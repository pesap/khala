---
name: academic-review
description: Use this skill when the user needs rigorous reasoning from first principles, simple Feynman-style explanations, reviewer2-level critical analysis, or decomplexification of academic papers. Use even when the user says "explain simply", "challenge this approach", "be more skeptical", or "decomplexify this paper" without naming the method.
license: MIT
---

## Use when
- User asks for first-principles reasoning or conceptual clarity.
- User asks for simple, jargon-light explanations.
- User asks for strict/critical review of architecture, code, or research choices.
- User wants assumptions challenged before implementation.
- User asks to "decomplexify" a paper or concept.

## Avoid when
- User wants only direct implementation with no analysis.
- Task is mechanical editing with no reasoning tradeoffs.

## Modes
1. **Feynman mode**: explain for a beginner using concrete examples and plain language.
2. **First-principles mode**: strip assumptions, identify invariants, rebuild the solution from fundamentals.
3. **Reviewer2 mode**: skeptical review of correctness, architecture, maintainability, and evidence quality.
4. **Decomplexify mode**: two-phase breakdown that destroys complexity and explains so simply a 12-year-old could understand.

## Instructions

### Standard Review (Modes 1-3)
1. Start by restating the claim/design in one sentence.
2. List explicit assumptions and unknowns.
3. Challenge each assumption with counterexamples or edge cases.
4. Reconstruct the solution from fundamentals (constraints, invariants, failure modes).
5. If explaining, prefer short examples over jargon.
6. If reviewing, classify findings: Critical, Warning, Suggestion, Nit.
7. Provide a concrete recommendation and what evidence would change it.

### Decomplexify Mode (Mode 4) — For Papers and Complex Concepts

**Phase 1: First Principles Breakdown**
1. List every common assumption people make about the topic
2. For each assumption, ask: "Is this fundamentally, provably true — or just inherited thinking?"
3. Show explicitly what changes when each false assumption is removed
4. Strip away until only what is fundamentally, provably true remains

**Phase 2: Feynman Rebuild**
1. Rebuild the concept from only the fundamentals that survived Phase 1
2. Explain using everyday analogies — cooking, LEGO, sports, school, water flowing, libraries
3. Test every sentence: "Would a 12-year-old who has never heard of this understand what I just said?"
4. If any sentence contains hidden complexity, break it down further
5. Use no jargon. No "as you probably know." No assumed background.
6. Confirm understanding: summarize in 2-3 sentences a kid could repeat back

**Decomplexify Output for Khala Notes:**
- Short descriptive title (not full academic title)
- What they tested: Plain description of methods
- What they found: Core findings in definition list format
- The surprising thing: What actually happened vs. what was expected
- Why it matters: Real-world implication in simple terms
- The analogy: One concrete everyday comparison that captures the essence

## Output
- Core claim (what is being evaluated)
- Assumptions + stress tests
- Explanation or critique findings (severity-labeled)
- Recommended path + validation steps

### For Decomplexify Mode specifically:
- Phase 1: Assumptions stripped
- Phase 2: Simple explanation with analogy
- The surprising thing
- Why it matters
- One-sentence summary a 12-year-old could repeat
