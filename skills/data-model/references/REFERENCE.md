# Data Model Reference

Use this reference for dataclasses, Pydantic v2, pydantic-settings, and infrasys
modeling.

## Index (quick find)

- [1) Model chooser](#1-model-chooser)
- [2) Canonical Pydantic field pattern](#2-canonical-pydantic-field-pattern)
- [3) Generic models (v2)](#3-generic-models-v2)
- [4) Semantic/constrained types first](#4-semanticconstrained-types-first)
- [5) Float aliases](#5-float-aliases)
- [6) Mutable defaults](#6-mutable-defaults)
- [7) Nullable-string to nested model](#7-nullable-string-to-nested-model)
- [8) Enums over strings](#8-enums-over-strings)
- [9) pydantic-settings](#9-pydantic-settings)
- [10) v2 API only](#10-v2-api-only)
- [11) Avoid computed_field for core state](#11-avoid-computed_field-for-core-state)
- [12) Custom serialization (Annotated + PlainSerializer)](#12-custom-serialization-annotated--plainserializer)
- [13) Field aliasing](#13-field-aliasing)
- [14) Excluding fields and sparse payloads](#14-excluding-fields-and-sparse-payloads)
- [15) Immutable updates with model_copy](#15-immutable-updates-with-model_copy)
- [16) infrasys component boundary](#16-infrasys-component-boundary)
- [17) Inheritance rule](#17-inheritance-rule)
- [18) Migration checklist](#18-migration-checklist)

## 1) Model chooser

- Existing canonical package/System model: reuse or extend the owner model; do
  not create a parallel local contract in a consumer package.
- `@dataclass`: simple trusted internal typed data.
- `BaseModel` (Pydantic v2): external/validated/serialized data.
- `BaseSettings` (`pydantic-settings`): app configuration.
- `Component` / `SupplementalAttribute`: infrasys entities.

## 2) Canonical Pydantic field pattern

```python
from typing import Annotated
from pydantic import BaseModel, Field

class GeneratorInput(BaseModel):
    name: Annotated[str, Field(min_length=1, description="Generator name")]
    rating_mw: Annotated[float, Field(gt=0, description="Installed capacity in MW")]
```

Rules:

- `Annotated[type, Field(...)]`.
- `description=` by repo convention.
- constraints in `Field`.
- `Field(description=...)` does not make weak types strong. Important IDs,
  physical quantities, component references, solver names, datasets, and model
  entities need semantic types, unit-aware fields, enums, or canonical model
  relationships.
- New `bool` fields and optional fields are design-review triggers; consider
  separate model variants before adding flags or `None` states.
- unions as `A | B` (never `typing.Union[A, B]`).

## 3) Generic models (v2)

```python
from typing import Generic, TypeVar
from pydantic import BaseModel, Field

T = TypeVar("T")

class GenericResponse(BaseModel, Generic[T]):
    data: T
    status: int
    message: str
    metadata: dict[str, str] = Field(default_factory=dict)
```

Prefer this over legacy `GenericModel` imports. If success and failure payloads
have different required fields, use separate response variants instead of many
optional fields.

## 4) Semantic/constrained types first

Before custom types, check Pydantic built-ins:

- `PostgresDsn`, `HttpUrl`, `EmailStr`, `UUID4`, `SecretStr`, `PositiveFloat`,
  etc.

For project domain fields, prefer the existing semantic contract:

- unit-aware field/model pattern for physical quantities
- canonical component/model reference for system entities
- `Enum` for finite domains
- semantic alias/value object for important IDs

## 5) Float aliases

Use built-ins first:

```python
from typing import Annotated
from pydantic import BaseModel, Field, PositiveFloat

class GeneratorInput(BaseModel):
    rating_mw: Annotated[PositiveFloat, Field(description="Installed capacity in MW")]
```

If built-ins do not fit domain range, define reusable alias:

```python
from typing import Annotated, TypeAlias
from pydantic import Field

UnitFloat: TypeAlias = Annotated[float, Field(ge=0, le=1)]
# or project helper form:
# UnitFloat = AnnotatedTyping[float, Field(ge=0, le=1)]
```

## 6) Mutable defaults

```python
from typing import Annotated
from pydantic import BaseModel, Field

class ComponentContribution(BaseModel):
    services: Annotated[list[str], Field(default_factory=list, description="Services that this component contributes to.")]
    metadata: Annotated[dict[str, str], Field(default_factory=dict, description="Additional metadata tags.")]
```

Never use `=[]`, `={}`, `=set()` defaults.

## 7) Nullable-string to nested model

If field becomes semi-structured `str | None` blob, extract nested model.

```python
from typing import Annotated
from pydantic import BaseModel, Field

class FuelContract(BaseModel):
    supplier: Annotated[str, Field(min_length=1, description="Fuel supplier")]
    contract_id: Annotated[str, Field(min_length=1, description="Contract ID")]

class GeneratorInput(BaseModel):
    fuel_contract: Annotated[FuelContract, Field(description="Fuel contract data")]
```

## 8) Enums over strings

```python
from enum import Enum

class EmissionType(str, Enum):
    CO2E = "CO2E"
    CO2 = "CO2"
    NOX = "NOx"
    SO2 = "SO2"
    PM25 = "PM2.5"
    PM10 = "PM10"
    VOC = "VOC"
    NH3 = "NH3"
    CH4 = "CH4"
    N2O = "N2O"
    H2 = "H2"
```

## 9) pydantic-settings

```python
from typing import Annotated
from pydantic import Field, PostgresDsn
from pydantic_settings import BaseSettings, SettingsConfigDict

class AppSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="APP_", env_file=".env")

    db_url: Annotated[PostgresDsn, Field(description="Database connection URL")]
    log_level: Annotated[str, Field(description="Application log level")]
```

No raw `os.environ`/dotenv parsing.

## 10) v2 API only

Use:

- `field_validator`, `model_validator`
- `model_dump`, `model_validate`
- `Model.model_fields` for field existence checks

Avoid:

- `@validator`, `@root_validator`
- `.dict()`, `.parse_obj()`

```python
if "rating_mw" in GeneratorInput.model_fields:
    ...
```

## 11) Avoid computed_field for core state

Prefer explicit stored fields + validator/method over fragile `@computed_field`
chains.

## 12) Custom serialization (Annotated + PlainSerializer)

Preferred pattern:

```python
from typing import Annotated
from pydantic import BaseModel, PlainSerializer

DoubleNumber = Annotated[int, PlainSerializer(lambda v: v * 2)]

class Model(BaseModel):
    number: DoubleNumber
```

Complex reusable serializer:

```python
from typing import Annotated, Any
from pint import UnitRegistry
from pydantic import BaseModel, Field, PlainSerializer

ureg = UnitRegistry()

def ser_ext(ext: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for k, v in ext.items():
        out[k] = v.magnitude if isinstance(v, ureg.Quantity) else v
    return out

SerializedExt = Annotated[dict[str, Any], PlainSerializer(ser_ext)]

class ComponentMeta(BaseModel):
    ext: SerializedExt = Field(default_factory=dict, description="Extra component metadata")
```

Always verify `model_dump(mode="json")`.

## 13) Field aliasing

```python
from typing import Annotated
from pydantic import BaseModel, Field

class Asset(BaseModel):
    max_capacity: Annotated[
        float,
        Field(ge=0, description="Maximum capacity", serialization_alias="Max Capacity"),
    ]
    foo: Annotated[str, Field(description="Example field", serialization_alias="foo_alias")]
```

Use aliases for external contract names, keep internal Python names clean.

## 14) Excluding fields and sparse payloads

```python
from pydantic import BaseModel, Field

class Transaction(BaseModel):
    id: int
    private_id: int = Field(exclude=True)
    value: int = Field(ge=0, exclude_if=lambda v: v == 0)
```

Sparse payloads:

```python
print(user.model_dump(exclude_unset=True))
print(
    FooBarModel(banana=None, foo="hello", bar={"whatever": 123}).model_dump(
        exclude_none=True
    )
)
```

## 15) Immutable updates with model_copy

```python
from pydantic import BaseModel

class BarModel(BaseModel):
    whatever: int

class FooBarModel(BaseModel):
    banana: float
    foo: str
    bar: BarModel

m = FooBarModel(banana=3.14, foo="hello", bar={"whatever": 123})

m2 = m.model_copy(update={"banana": 0})
same_nested_ref = id(m.bar) == id(m.model_copy().bar)
new_nested_ref = id(m.bar) != id(m.model_copy(deep=True).bar)
```

Use shallow by default; use `deep=True` when nested mutation isolation needed.

## 16) infrasys component boundary

```python
from typing import Annotated
from pydantic import Field
from infrasys import Component

class Generator(Component):
    active_power: Annotated[float, Field(ge=0, description="Current active power MW")]
    rating: Annotated[float, Field(gt=0, description="Nameplate rating MW")]
```

- `Component`: core entities.
- `SupplementalAttribute`: cross-cutting many-to-many metadata.

## 17) Inheritance rule

Use hierarchy for categorization only, not field-sharing reuse.

```python
class HydroGen(Generator):
    """Abstract class for Hydro generators."""
```

## 18) Migration checklist

- rename old key -> new key before validation
- add deterministic defaults for new required fields
- remove deprecated keys with `pop(key, None)`
- keep migrations idempotent
