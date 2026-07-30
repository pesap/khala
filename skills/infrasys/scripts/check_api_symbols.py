#!/usr/bin/env python3
"""Check that key infrasys API symbols still exist.

Default behavior checks the *installed* `infrasys` package (for example from PyPI).
Use `--repo` only when you intentionally want to check a source checkout.

The target path must be the infrasys package root directory
(the folder that contains system.py, time_series_models.py, etc.).

Examples
--------
# Check installed package (recommended)
uvx --from python --with infrasys python skills/infrasys/scripts/check_api_symbols.py

# Optional: check a source checkout directly
uvx --from python python skills/infrasys/scripts/check_api_symbols.py --repo /path/to/infrasys_package_root

# Print resolved package root
uvx --from python --with infrasys python skills/infrasys/scripts/check_api_symbols.py --print-root
"""

from __future__ import annotations

import argparse
import importlib.util
import re
from pathlib import Path

REQUIRED: dict[str, tuple[str, ...]] = {
    "system.py": (
        "System",
        "get_components",
        "get_component",
        "list_components_by_name",
        "show_components",
        "list_time_series_keys",
        "list_time_series_metadata",
        "add_time_series",
        "get_time_series",
        "get_time_series_by_key",
        "remove_time_series",
        "to_json",
        "from_json",
        "save",
        "load",
        "serialize_system_attributes",
        "deserialize_system_attributes",
        "handle_data_format_upgrade",
    ),
    "time_series_models.py": (
        "SingleTimeSeries",
        "Deterministic",
        "NonSequentialTimeSeries",
        "TimeSeriesStorageType",
    ),
    "serialization.py": ("CachedTypeHelper",),
    "cost_curves.py": ("CostCurve", "FuelCurve", "UnitSystem"),
    "value_curves.py": (
        "InputOutputCurve",
        "IncrementalCurve",
        "AverageRateCurve",
        "LinearCurve",
    ),
    "function_data.py": (
        "LinearFunctionData",
        "QuadraticFunctionData",
        "PiecewiseLinearData",
        "PiecewiseStepData",
    ),
}


def has_symbol(text: str, symbol: str) -> bool:
    pattern = re.compile(rf"^\s*(def|class)\s+{re.escape(symbol)}\b", re.MULTILINE)
    return bool(pattern.search(text))


def looks_like_infrasys_package_root(path: Path) -> bool:
    return (path / "system.py").exists() and (path / "time_series_models.py").exists()


def unique_paths(paths: list[Path]) -> list[Path]:
    seen: set[str] = set()
    out: list[Path] = []
    for p in paths:
        key = str(p.resolve())
        if key in seen:
            continue
        seen.add(key)
        out.append(p)
    return out


def discover_candidates(repo_arg: Path | None) -> list[Path]:
    candidates: list[Path] = []

    if repo_arg is not None:
        candidates.append(repo_arg.expanduser())

    # Prefer installed package (PyPI or otherwise) for portability.
    spec = importlib.util.find_spec("infrasys")
    if spec and spec.origin:
        candidates.append(Path(spec.origin).resolve().parent)

    # Fallback: common repo layouts near current/script directory.
    starts = [Path.cwd(), Path(__file__).resolve().parent]
    for start in starts:
        for parent in [start, *start.parents]:
            candidates.append(parent / "src" / "infrasys")
            candidates.append(parent / "infrasys")

    return unique_paths(candidates)


def resolve_repo(repo_arg: Path | None) -> Path | None:
    for candidate in discover_candidates(repo_arg):
        if looks_like_infrasys_package_root(candidate):
            return candidate.resolve()
    return None


def check_symbols(repo: Path) -> list[str]:
    missing: list[str] = []
    for rel_file, symbols in REQUIRED.items():
        fpath = repo / rel_file
        if not fpath.exists():
            missing.append(f"missing file: {fpath}")
            continue

        text = fpath.read_text(encoding="utf-8")
        for symbol in symbols:
            if not has_symbol(text, symbol):
                missing.append(f"{rel_file}: missing symbol {symbol}")
    return missing


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--repo",
        type=Path,
        default=None,
        help="Optional path to infrasys package root (folder containing system.py)",
    )
    parser.add_argument(
        "--print-root", action="store_true", help="Print resolved package path"
    )
    parser.add_argument(
        "--verbose", action="store_true", help="Print candidate search paths"
    )
    args = parser.parse_args()

    if args.verbose:
        print("Candidates:")
        for p in discover_candidates(args.repo):
            print(f"- {p}")

    repo = resolve_repo(args.repo)
    if repo is None:
        print("Could not locate infrasys package root.")
        print(
            "Install infrasys from PyPI and run via: "
            "uvx --from python --with infrasys python <script>"
        )
        print("Or provide --repo <path-to-infrasys-package-root> for source checkouts.")
        return 2

    if args.print_root:
        print(repo)

    missing = check_symbols(repo)
    if missing:
        print("API drift detected:")
        for item in missing:
            print(f"- {item}")
        return 1

    print("API symbol check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
