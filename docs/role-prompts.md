# Role prompts

Khala uses Pi system prompts to shape the behavior of its child roles.
The
shared [`khala` skill](../skills/khala/SKILL.md) explains the tool contracts;
role prompts explain what each role is responsible for.
The application service
still enforces actor permissions, Work state, and revisions.

## How Pi applies a role prompt

When Khala starts a child session, it passes the internal `--khala-role` flag to
Pi.
The Khala extension handles Pi's `before_agent_start` event and appends the
matching file from [`system-prompts/`](../system-prompts/) to Pi's system
prompt:

| Role | Prompt file | Khala tools exposed |
| --- | --- | --- |
| Conclave | [`conclave.md`](../system-prompts/conclave.md) | Archive, actions, runtime inspection, Oracle |
| Executor | [`executor.md`](../system-prompts/executor.md) | Archive, signals, actions |
| Observer | [`observer.md`](../system-prompts/observer.md) | Archive, assessment |
| Oracle | [`oracle.md`](../system-prompts/oracle.md) | No tools during Oracle review |

The ordinary User session is not assigned a child role.
[`user.md`](../system-prompts/user.md)
is packaged as reference guidance but is not appended by the current extension.

Pi's `prompts/` directory is separate: those files are user-invoked prompt
templates such as `/fresh-eyes`.
Files in `system-prompts/` are role instructions
injected automatically into matching child sessions.

## Tweak a role

1. Edit the prompt file for the role in `system-prompts/`.
2. Keep the role identity, authority boundary, and output contract clear.
3. Start Khala from the checkout so the extension reads the edited files:

   ```sh
   pi -e ./src/index.ts
   ```

4. Exercise the relevant workflow and inspect the resulting Archive records,
   Signals, or review evidence.
5. Run the repository checks before sharing the change:

   ```sh
   npm run check
   npm run test
   ```

A running child keeps the prompt it received for that session.
Restart the
relevant child or begin a new Work to test prompt changes cleanly.
Installed
packages use the prompt files shipped in that package; update or reinstall the
package after changing a checkout before testing the installed copy.

## What to change in a prompt

Use prompts to clarify:

- the role's identity and what it must not do;
- which Archive facts to read before acting;
- how to use the role's available tools;
- what evidence to collect and record;
- required output formats and stopping conditions;
- how to handle untrusted repository, provider, and model text.

Do not use prompts to grant permissions, bypass revision checks, change Mission
terms, merge provider requests, or invent tools.
Those rules belong to the
application service and tool schemas.
Do not duplicate the full tool reference
in every role prompt; link to the shared skill instead.

## Prompt design by role

### Conclave

Tune admission criteria, scheduling decisions, Verdict handling, provider
feedback assessment, runtime recovery, and Outcome verification.
Keep the
Conclave read-only with respect to the repository and require Archive evidence
before each decision.

### Executor

Tune repository inspection order, implementation and validation habits, review
request preparation, Signal quality, and how authorized feedback is handled.
Keep the Executor inside the bound sandbox and immutable Mission.

### Observer

Tune which bounded repository facts to gather for missing context.
Keep the
Observer read-only, relevant to the submitted Work, and limited to one concise
assessment.

### Oracle

Tune the bounded review rubric and response format.
The Oracle receives only
its packet, has no tools, and produces advisory findings; the Conclave makes the
actual Verdict.

## Prompt changes and traceability

Khala computes a prompt identity when configuring a role runtime and persists it with Executions, Observer bindings, and Oracle records.
Conclave wake prompts are transient and are not represented as a separate lifecycle object.
Treat prompt changes as behavior changes.
Review the diff, run the checks, and verify the resulting Archive evidence.
The service remains the final authority even when a prompt is
ambiguous or malicious text attempts to override it.
