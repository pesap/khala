# CONTEXT.md Format

## Structure

```md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**: A customer's request to purchase one or more items. _Avoid_:
Purchase, transaction

**Invoice**: A request for payment sent to a customer after delivery. _Avoid_:
Bill, payment request

**Customer**: A person or organization that places orders. _Avoid_: Client,
buyer, account

## Relationships

- An **Order** produces one or more **Invoices**
- An **Invoice** belongs to exactly one **Customer**

## Example dialogue

> **Dev:** "When a **Customer** places an **Order**, do we create the
> **Invoice** immediately?" **Domain expert:** "No — an **Invoice** is only
> generated once a **Fulfillment** is confirmed."

## Flagged ambiguities

- "account" was used to mean both **Customer** and **User** — resolved: these
  are distinct concepts.
```

## Rules

- Be opinionated: choose one canonical term; list alternatives as avoid/aliases.
- Flag conflicts explicitly under "Flagged ambiguities" with clear resolution.
- Keep definitions tight (one sentence, what it is).
- Show relationships with bold term names and cardinality where obvious.
- Include only domain-specific concepts, not generic programming terms.
- Group terms under subheadings when natural clusters emerge.
- Include one short dev/domain-expert dialogue.

## Single vs multi-context repos

Single-context repos usually use one root `CONTEXT.md`.

Multi-context repos use `CONTEXT-MAP.md` to link contexts and relationships:

```md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) — receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) — generates invoices and processes
  payments
- [Fulfillment](./src/fulfillment/CONTEXT.md) — manages warehouse picking and
  shipping

## Relationships

- **Ordering → Fulfillment**: Ordering emits `OrderPlaced` events; Fulfillment
  consumes them to start picking
- **Fulfillment → Billing**: Fulfillment emits `ShipmentDispatched` events;
  Billing consumes them to generate invoices
- **Ordering ↔ Billing**: Shared types for `CustomerId` and `Money`
```

Inference rules:

- if `CONTEXT-MAP.md` exists, use it
- else if root `CONTEXT.md` exists, single context
- else create root `CONTEXT.md` lazily when first term is resolved
