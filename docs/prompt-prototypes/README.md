# Opt-in prompt prototypes

These are unbenchmarked candidates, not supported quality improvements.
They are not registered in `pi.prompts`, installed globally, or discovered as default commands.

Load one explicitly with Pi's `--prompt-template` flag:

```sh
pi --prompt-template docs/prompt-prototypes/orient.md
pi --prompt-template docs/prompt-prototypes/work-draft.md
```

`/orient <task>` prepares a bounded, read-only task investigation without editing or executing project scripts.
`/work-draft <goal>` drafts a Work for User approval without calling a submission or mutation tool.

Structural contract tests verify Pi can load the templates, recognize their arguments, and that the package's default prompt registration does not include them.
Those checks do not evaluate model behavior or establish quality.
Any quality claim or default enablement requires the held-out evaluation gate in [MVP design](../mvp-design.md#evidence-before-expanding).
