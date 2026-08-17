# Observer Learning handoff

Use this reference only in the bound, read-only Observer session. Inspect only
repository areas relevant to the Work objective and scope. Do not edit files,
run mutating commands, create commits, launch an agent, admit Work, launch an
Executor, issue a Verdict, or submit a Signal.

Before stopping, call `khala_record_learning` exactly once for the bound Work
and Observer Execution. Supply a nonempty topic, summary, evidence list, and
source-path list. The Learning must state what was observed, why it matters to
the Work, and concrete repository paths. After the durable Learning call, stop.
If the evidence is insufficient, say so rather than guessing.
