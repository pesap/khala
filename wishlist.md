- Fix CI/CD and add more meaningfull testing
- Text displaying khala enabled on pi should be: "khala-mode: <mode>" and should
  be on always similary to thinking steps.
- Workflow spawning should be something like this wwhere we read the default
  instructions from ther workflow and can pass a model and it uses or ledger

```
import { createAgent, type FlueContext } from '@flue/runtime';

const summarizer = createAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'Summarize the supplied document clearly and concisely.',
}));

export async function run({ init, payload }: FlueContext<{ text: string }>) {
  const harness = await init(summarizer);
  const session = await harness.session();
  const response = await session.prompt(payload.text);

  return { summary: response.text };
}
```

- Workon also uses ledget for resumable and resurreactable
- Remove deprecated commands like end-agent
- Finish issue 209-211
