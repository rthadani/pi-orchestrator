---
name: design-decision-gate
description: "You MUST use this before a consequential design or implementation decision, an irreversible change, or when the request is ambiguous. Runs a decision handshake: classify the boundary, gather evidence, synthesize context, ask one focused question with 2-5 concrete options and a recommendation, commit the answer, then proceed. Works with or without the ask_user tool."
metadata:
  short-description: Decision gate for ambiguity and high-stakes design choices
---

# Design Decision Gate

Use this skill to force explicit alignment before a consequential decision.

This skill is about **decision control**, not chit-chat. Its job is to convert
one real ambiguity into one recorded decision, then get back to work.

## Non-negotiable rule

Gate the step before proceeding when **any** of the following is true:

1. The next step changes architecture, schema, API contracts, deployment
   strategy, or security posture.
2. The work is costly to undo: a large refactor, a migration, a destructive
   edit, or a production-facing behaviour change.
3. Requirements, constraints, or success criteria are unclear, conflicting, or
   missing.
4. Multiple valid options exist and the trade-off is preference-dependent.
5. You are about to assume something that would materially change the
   implementation.

Do **not** skip this gate unless the user already gave a clear, explicit
decision for that exact trade-off.

**The trivial exception.** A change is trivial when it touches one or two files,
roughly 50 changed lines or fewer, adds no dependency, public API, schema,
config key, or deployment surface, and changes no existing behaviour beyond a
bug fix. For a trivial change, do not gate: state the change in one line, do
it, and name any assumption you took. Every unnecessary question spends the
user's attention and buys nothing.

## Agent Protocol Handshake (required)

Follow this handshake in order.

### 1) Detect boundary

Classify the current step as:

- `high_stakes`
- `ambiguous`
- `both`
- `clear` (no gate needed)

If the classification is not `clear`, continue. If you find two candidate
boundaries, pick the one the other depends on and gate that one.

### 2) Gather evidence first

Before asking, gather context from the available tools: read the files, check
the callers, search the docs, inspect config. Do not ask the user to decide
something the repository already answers. Never ask blind.

### 3) Synthesize context

Prepare a short neutral summary covering:

- current state, in two or three sentences
- the key constraints
- the trade-offs per option
- your recommendation and why

Keep it to a short paragraph or a few bullets. No recap of the whole task.

### 4) Ask one focused question

Ask with one decision per turn. Two shapes, depending on what is available.

**With the `ask_user` tool**, pass:

- `question`: the concrete decision prompt
- `context`: the synthesized summary
- `options`: 2-5 mutually exclusive choices, each `{ title, description }`
- `allowMultiple`: `false` unless independent selections are genuinely needed
- `allowFreeform`: usually `true`, so the user can answer outside your frame
- `displayMode` *(optional)*: `"inline"` when the summary and trade-offs must
  stay visible beside the options, `"overlay"` otherwise
- `contextExpanded` *(optional)*: `true` when the context is the evidence the
  user needs to weigh

When 2-4 decisions at one boundary are independent and their prerequisites are
already settled, you may ask them together with `questions`. Each entry carries
its own `question`, `context`, `options`, `allowMultiple`, and `allowFreeform`.
A top-level `question` sent alongside `questions` is only a heading and is
never asked. Never batch a decision whose options depend on another answer; ask
that one in a later call.

**Without the `ask_user` tool**, ask in plain chat in the same shape: numbered
options, one line of trade-off each, the recommendation marked, and an explicit
invitation to answer outside the list. Do not degrade into an open-ended "what
do you think?", and do not skip the gate because the tool is missing.

### 5) Commit the decision

After the answer:

- restate the decision in plain language, in one line
- state what happens next
- proceed with the implementation

Do not re-ask to confirm the confirmation.

### 6) Re-open only on new ambiguity

Ask again only if materially new uncertainty appears. New facts can reopen a
settled decision. A slow feeling cannot.

## Anti-overasking guardrails (required)

Apply a strict question budget per decision boundary:

- **Max 1** gate call per boundary in normal cases.
- **Max 2** gate calls for the same boundary when the first answer is unclear,
  cancelled, or contradictory.
- Never ask the same trade-off again without new evidence.

Escalation ladder:

1. **Attempt 1:** structured options plus a concise context summary.
2. **Attempt 2, only if needed:** a narrower question with your recommendation
   and explicit choices:
   - `Proceed with the recommended option`
   - `Choose another option` (freeform)
   - `Stop for now`

After attempt 2:

- If the boundary is `high_stakes` or `both`: **stop and mark blocked**. Do not
  keep asking.
- If the boundary is `ambiguous` only and the user says "your call" or
  equivalent: proceed with the most reversible default and state the assumption
  explicitly.

## Payload quality standard

### Question quality

Use:

- "Which option should we adopt for X?"
- "Do you want A (fast) or B (safer) for Y?"

Avoid:

- broad prompts with no decision boundary
- several unrelated decisions in one question
- questions the code, docs, or config already answer

### Option quality

Options must be:

- mutually exclusive and concrete ("Postgres with a migration" beats "use a
  database")
- short and outcome-oriented
- explicit about what each one costs or changes
- two to five in number; more than five means the decision is not decomposed
  yet
- accompanied by a recommendation; a user choosing blind is a failure of the
  gate

## Recommended pattern

A single-select design decision, with the tool:

```json
{
  "question": "Which caching strategy should we use for the first release?",
  "context": "p95 latency is the problem. Redis is fastest but adds infra; an in-memory cache is simpler but not shared across instances.",
  "options": [
    { "title": "In-memory cache", "description": "Simpler rollout, weaker horizontal consistency" },
    { "title": "Redis cache", "description": "Better consistency and scalability, more ops overhead" }
  ],
  "allowMultiple": false,
  "allowFreeform": true
}
```

The same decision without the tool:

```text
Which caching strategy should we use for the first release?

p95 latency is the problem. Redis is fastest but adds infra; an in-memory cache
is simpler but not shared across instances.

1. In-memory cache - simpler rollout, weaker horizontal consistency
2. Redis cache - better consistency and scalability, more ops overhead (recommended)

Answer with a number, or tell me something else.
```

## Anti-patterns

- Asking without gathering context first
- A wall of four questions at once
- Options that differ only in wording
- Recommending nothing, or recommending all of them
- Forcing options when freeform is clearly better
- Asking permission to do the thing you were just asked to do
- Re-litigating a decision the user already made
- Batching dependent decisions, or using a batch to dodge one-decision-per-turn
- Proceeding with a high-stakes implementation after an unclear or cancelled
  answer

## If the answer is cancelled or unclear

Pause execution and explain what is blocked. Use at most one narrower follow-up
question (attempt 2). After that, do not loop:

- for `high_stakes` or `both`: remain blocked until the decision is explicit
- for `ambiguous` only: proceed only if the user delegated the choice, with the
  most reversible option, and state the assumption in one line

Treat a cancelled prompt as "no decision yet". Never pick silently on a
destructive or irreversible step.
