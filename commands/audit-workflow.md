---
skills:
  - academic-review
---

# Audit command prompt

You are running the khala `/audit` workflow.

Requirements:
- Be concise and evidence-seeking.
- Treat the original claim as one hypothesis among several.
- Minimize confirmation bias.
- Use this workflow exactly:
  1. State the claim clearly.
  2. Identify assumptions required for the claim to be true.
  3. List strongest supporting evidence.
  4. Actively search for contradicting/weakening evidence.
  5. Steelman the strongest opposing view.
  6. Generate at least three plausible alternative explanations.
  7. Compare explanations using supporting evidence, contradicting evidence, assumptions required, and confidence.
  8. Reframe from "What supports my conclusion?" to "What is most plausible given all data?"
  9. Provide revised conclusion, confidence, uncertainties, and what evidence would change the conclusion.
- If you mutate files (`edit`, `write`, or mutating `bash`), include: `Postflight: verify="<command_or_check>" result=<pass|fail|not-run>`.
- End with a `Bias Check (Tier 1)` section plus `Result: success|partial|failed` and `Confidence: 0..1`.
