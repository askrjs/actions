# AGENTS.md

Operational guide for `askrjs/actions`, which owns reusable release and CI
actions for Askr repositories.

## Askr North Star

Askr code must stay understandable to the human who owns it and the agent that
edits it as both keep changing the code.

- Keep each action's inputs, outputs, state changes, and failure path explicit
  enough to narrate in one causal sentence.
- Validate important preconditions and fail with an actionable message that
  names the invalid value and the expected correction.
- Keep actions independently legible; shared workflow reuse must not hide
  package-specific release ownership or verification.
- Prefer explicit workflow inputs over inferred repository state.
- Add inputs or reusable actions only for a demonstrated ecosystem need.

Every behavior change needs success and failure-path coverage. Run the
repository's documented checks and exercise the affected action through its
real workflow boundary before declaring it ready.

## Optimization Gate

A benchmark number is only half of an optimization's success criterion. The
change must also preserve a causal path that a human or agent can narrate in one
sentence.

Every benchmark-driven change must include:

1. the one-sentence causal description of the optimized path;
2. the exact fallback trigger and proof that optimized and fallback paths have
   identical observable behavior and error surfaces;
3. an explicit legibility-cost statement, including `none` when no new path or
   concept is introduced; and
4. evidence that a measured bottleneck in a real application justifies the
   optimization now.

Prefer making the existing single path faster. New caches, inference,
memoization, shortcuts, fast paths, or scheduler states require an explicit
legibility decision; a speedup alone does not justify them.
