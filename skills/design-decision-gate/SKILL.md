---
name: design-decision-gate
description: "Resolve a genuine design decision with the user before implementation starts. Use when a non-trivial change has an open question you cannot settle from the code (scope, trade-offs, constraints, several valid approaches), or when a step is destructive or hard to reverse. Asks one focused question at a time with 2-5 concrete options and a stated recommendation, then commits the answer. Do not use it for trivia or to confirm work the user already asked for."
metadata:
  short-description: One-question-at-a-time decision gate for design ambiguity
---

# Design Decision Gate

A decision gate is a stop, not a conversation. The goal is to convert one real
ambiguity into one recorded decision, then get back to work.

## Is this a real decision?

Ask only when the answer changes what gets built and you cannot derive it:

- scope or boundary the request left open,
- a trade-off where both sides are defensible,
- a constraint you do not know (target platform, compatibility, budget, deadline),
- a destructive or hard-to-reverse step,
- a step touching schema, public API, security, or deployment posture.

Do **not** ask when:

- the user already answered it earlier in the conversation,
- the code, docs, or config in hand settle it,
- a yes is the only possible answer ("should I proceed?", "does this look okay?"),
- the change is trivial: one or two files, roughly 50 changed lines or fewer, no
  new dependency or public surface. State the change in one line and do it.

Every unnecessary question spends the user's attention and buys nothing. When in
doubt, decide, label the assumption in one line, and proceed. A wrong assumption
the user can see is cheaper than a question they did not need.

## Protocol

**1 → Detect the boundary.** Name the single thing you cannot decide. If you
find two, pick the one the other depends on.

**2 → Gather evidence first.** Read the files, check the callers, search the
docs. Never ask about something already answerable from the repo.

**3 → Synthesize context.** Two or three sentences: what you are trying to do,
what you found, why the remaining choice is genuinely open. No recap of the
whole task.

**4 → Ask one question.** One decision per turn. Group questions only when they
are inseparable, and then use at most four. For each option give a short title
plus one line on what it costs or changes.

**5 → Commit.** Echo the chosen decision in one line so it is on the record,
then continue. Do not re-ask to confirm the confirmation.

**6 → Re-open only on new ambiguity.** New facts can reopen a settled decision.
A slow feeling cannot.

## Question quality

- Lead with the decision, not the background.
- Make the options mutually exclusive and concrete: "Postgres with a migration"
  beats "use a database".
- State a recommendation and why. A user picking blind is a failure of the gate.
- Two to five options. More than five means the decision is not yet decomposed.
- Include a freeform escape so the user can answer outside your frame.

## Option shape

Offer each option as a short title with a one-line trade-off:

```text
A. Retry in the client (recommended) - no server change, but three callers each
   need the logic.
B. Retry in the gateway - one place to fix, adds a hop and a timeout budget.
C. Fail fast, no retry - simplest, pushes the error to the user.
```

## Transport

Use the `ask_user` tool when it is available: pass the decision as `question`,
the synthesis as `context`, and each option as `{ title, description }` with the
recommended one first and marked as recommended.

When `ask_user` is not available, ask in plain chat in the same shape, numbered,
one question per message, with the recommendation stated. Do not degrade into an
open-ended "what do you think?" and do not skip the gate because the tool is
missing.

## If the answer is cancelled or unclear

Treat a cancelled prompt as "no decision yet": do not pick silently on a
destructive or irreversible step. Either ask once more with narrower options, or
take the reversible path and say which assumption you took. Reporting the
assumption is mandatory; guessing quietly is not an option.

## Anti-patterns

- A wall of four questions at once.
- Options that differ only in wording.
- Recommending nothing, or recommending all of them.
- Asking permission to do the thing you were just asked to do.
- Re-litigating a decision the user already made.
