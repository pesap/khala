# Design: Read-only Archive Diagnostics and Recovery

## Decision
Add a read-only diagnostic surface that scans and explains Archive health without
mutating, truncating, rewriting, or repairing the append-only JSONL file. Recovery
is a human- or Conclave-directed process that creates new valid records through
existing lifecycle owners; the diagnostic tool itself never performs recovery.

## Authority and capabilities

- Archive bytes and line order remain authoritative.
- Diagnostics may report file existence, readability, line numbers, envelope
  validity, record type counts, duplicate identifiers, and projection summaries.
- A User Session may inspect safe project-level health. An Executor may inspect
  only its bound execution. The Conclave may request project diagnostics. Raw
  payload display must follow the existing role visibility rules.
- Diagnostics must use the trusted project archive-root boundary and the shared
  typed projections. They must not bypass role checks by accepting an arbitrary
  filesystem path.

A diagnostic result should identify stable record IDs, line numbers, types, and
safe error categories. It must never echo malformed lines or payload values.

## Security and failure behavior

Unreadable files and malformed JSON fail closed. The result may include a line
number and sanitized OS error code, but not parser text containing Archive data.
Symlinks, paths outside the selected Archive root, and unexpected file types are
reported as unsafe and are not followed for repair. No shell command, truncation,
rename, sort, or in-place JSON rewriting is permitted.

## Compatibility

The JSONL envelope remains append-only while supporting legacy version-1 and
current version-2 records, including Mandates and Missions. Diagnostics are
additive and use the existing `isArchiveRecord` guards and typed projection
layer. Existing read tools continue returning authoritative records; a future
health command should be a separate, clearly read-only capability rather than a
new mutation path.

## Rollout

1. Implement a pure scanner over a supplied read-only stream abstraction and test
   missing, unreadable, malformed, invalid, duplicate, and valid Archives.
2. Add role-filtered formatting that emits safe summaries and line references.
3. Expose it first as a local developer command with no automatic remediation.
4. Add Conclave and monitor integration only after payload-redaction tests pass.

## Rollback

Remove the diagnostic registration and retain the scanner as an internal test
utility. Since no Archive mutation occurs, rollback does not require restoration
or migration. Any human repair must use a separately reviewed append-only
procedure and remain outside this design.

## Open questions

- Should a diagnostic snapshot include cryptographic hashes of lines or only
  record IDs and counts?
- Which OS read-error categories are stable enough to expose to users?
- How should a partially written final line be distinguished from corruption
  without weakening fail-closed reads? Current policy treats every malformed
  final line as corruption; only the empty segment after a normal trailing
  newline is valid.
- Should duplicate record IDs be a hard health failure or a warning when the
  records are otherwise valid?
- What Conclave approval is required before creating a successor record for a
  diagnosed failed lifecycle?
