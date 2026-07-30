# Domain probes for planning

Use these probes only when the topic naturally touches the domain. Pick 1-2
high-value questions; do not run this as a checklist.

## Authentication and authorization

- Login/auth: OAuth providers, email/password, magic links, or SSO?
- Sessions: server-side sessions or stateless tokens? Refresh/lifetime policy?
- Permissions: simple roles, RBAC, ABAC, or scoped capabilities?
- Recovery: password reset, email verification, MFA, account lockout?
- API keys: scoped permissions, rotation, rate limits, audit trail?

## Real-time and collaboration

- Updates: WebSockets, SSE, polling, or eventual refresh?
- Offline/reconnect: queue, retry, discard, or conflict resolution?
- Collaboration: CRDT/OT needed, or simpler last-write-wins?
- Notifications: in-app, push, email, read receipts, persistence?

## API design

- Style: REST, GraphQL, RPC, event-driven, or internal module API?
- Versioning: URL/header/schema version, or no public compatibility promise?
- Pagination: cursor or offset? Stable ordering required?
- Errors: structured codes, messages, retryability, production redaction?
- Compatibility: what consumers must not break?

## Data and persistence

- Storage: relational, document, key-value, file/object storage, or existing
  system?
- Integrity: transactions, constraints, idempotency, deduplication?
- Migrations: forward-only, rollback, data migrations, compatibility window?
- Retention: deletion, archival, privacy, audit requirements?
- Scale: read/write ratio, expected size, indexing needs?

## Search and discovery

- Query: full-text, exact match, semantic, fuzzy, or filters only?
- Ranking: recency, relevance, popularity, custom scoring?
- Filters: facets, AND/OR behavior, saved searches?
- Indexing: real-time, async, batch, acceptable lag?
- Failure mode: what happens if search backend is stale/down?

## Files and media

- Upload path: direct-to-cloud or through server?
- Limits: file size, count, total storage, type allowlist?
- Processing: thumbnails, compression, OCR, virus scanning, previews?
- Access: public, signed URLs, permissions, expiry?
- Lifecycle: versioning, deletion, cleanup of orphan files?

## Caching and performance

- Cache location: client, CDN, app, database, Redis?
- Invalidation: TTL, event-driven, manual, write-through/cache-aside?
- Freshness: acceptable staleness and stale-while-revalidate behavior?
- Hot paths: p95/p99 targets, concurrency, payload size?
- Degradation: what should happen when cache is unavailable?

## Testing and verification

- Test layer: unit, integration, E2E, contract, visual, snapshot?
- Public behavior: what should tests observe from the outside?
- Fixtures: realistic data, factories, test containers, mocks?
- CI: required checks, time budget, flake tolerance?
- Coverage: what risk needs coverage, not just percentage?

## Deployment and operations

- Environment: local/dev/staging/prod parity?
- Release: manual, CI/CD, feature flag, canary, blue-green?
- Rollback: code rollback, data rollback, config rollback?
- Config/secrets: env vars, vault, platform-native secrets?
- Observability: logs, metrics, tracing, alerts, dashboards?

## UI and product experience

- Primary flow: what is the most common path through the UI?
- Empty/loading/error states: what does the user see?
- Responsiveness: mobile parity or simplified mobile?
- Accessibility: keyboard, screen reader, contrast, reduced motion?
- Visual priority: what should draw attention first?

## AI/LLM features

- Task type: generation, extraction, classification, routing, retrieval, tool
  use?
- Evaluation: what makes an answer good/bad? Who judges it?
- Guardrails: refusal, grounding, citations, schema validation, human review?
- Data: prompts, examples, reference set, privacy constraints?
- Monitoring: drift, hallucination, latency/cost, feedback loop?
