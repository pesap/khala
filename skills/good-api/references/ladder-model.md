# API learning ladder model

Source: https://blog.sbensu.com/posts/apis-as-ladders/

## Core vocabulary

- **Convenient**: beginners can solve the common first problem with little
  upfront learning.
- **Gradual**: novices can learn one stable layer at a time; small new
  requirements do not force large conceptual jumps.
- **Flexible**: experts can solve many real problems without product-controlled
  dead ends or eject paths.

## Design order

Design APIs in this order:

1. Flexible primitives first.
2. Gradual layers second.
3. Convenient wrappers/defaults third.

Market adoption often pressures the opposite order. Convenience helps first
adoption, gradualness helps retention, and flexibility prevents expert
abandonment.

## Failure modes

- Hidden relationships or dependencies.
- Overly simplistic modeling that cannot express real cases.
- Unnecessary coupling between concepts.
- Convenience wrappers that hide too much and make the next layer surprising.
- Layering where adding the advanced layer changes the semantics learned in the
  earlier layer.

## Useful questions

- What concepts must a beginner learn before the first successful call?
- What extra concepts unlock the second and third use cases?
- Can advanced users compose operations, or do they hit arbitrary restrictions?
- Are wrappers backed by understandable primitives?
- Do defaults cover common cases without blocking uncommon cases?
