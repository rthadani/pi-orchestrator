# Workflow

Use a plan → implement → parallel-review loop. Design first; write code only after a plan exists. Follow these rules whenever a task involves designing or changing code.

## Steps

1. **Design first.** For any non-trivial change, delegate design to the `oracle` subagent before writing code. A change is **trivial** only when all hold: one or two files touched and roughly 50 changed lines or fewer; no new dependency, public API, schema, config key, or deployment surface; no behaviour change beyond a bug fix; and no answer from you is needed to write it correctly. Everything else is non-trivial.

2. **Ask before guessing.** Oracle must not guess at open questions; it returns them alongside its analysis. The parent asks the user one focused question at a time until the design settles. Never present a plan built on unspoken assumptions. A trivial change gets a one-line statement, no question.

3. **Pause only for a real decision.** After planning, proceed straight to `worker` when the design matches the request and raises nothing the user must decide. Stop and ask only for a genuine decision: open questions, judgment calls beyond the request, destructive or hard-to-reverse steps, or changes touching schema, API contracts, security, or deployment.

4. **Delegate implementation to `worker`.** The parent never edits source directly. Every implementation step goes through the worker, with the model class passed explicitly.

5. **Review automatically, three reviewers in parallel.** After implementation, run correctness, tests, and simplicity reviewers concurrently, never one at a time. Synthesize the three reports into one summary for the user.

6. **Loop on findings.** If any reviewer reports issues, fix them via `worker` and re-run the three reviewers, up to three rounds. If the cap is hit with unresolved issues, summarize them instead of looping silently.

## Agent roles

- `oracle` — design only, read-only, no code changes.
- `worker` — the only agent that writes code.
- `reviewer` — read-only critique, never edits; run three at once (correctness, tests, simplicity).
- `scout` — optional read-only codebase recon; uses the `flash` class, escalate to `sonnet` for dense or unfamiliar codebases.
- `researcher` — optional read-only web research; uses the `sonnet` class.

## Model selection

- Every subagent runs on a per-class fallback chain; when a provider runs out of credits the request moves to the next model in that class and never crosses classes. Pass the class explicitly on every spawn.
- **Coding entry point.** `worker`'s default class is chosen by the trivial test: trivial → `flash`; non-trivial or any carve-out area → `coding`.
- **Reviewer classes.** Correctness on `sonnet`, tests and simplicity on `flash`.
- **Mechanical operations** (git add/commit/push, moves, renames, formatting) go to `flash` regardless of blast radius; safety comes from explicit constraints in the prompt, not from a stronger class.
- **Opus is opt-in.** If any role is assigned `opus`, ask the user first, naming the role and why; without approval, that role runs on `sonnet` instead.
- **Escalate thinking effort before the model.** For open design decisions or multi-subsystem spans, prefer a higher thinking level on `sonnet` over `opus`.
- **Second opinion.** For a contested call or a decision that is expensive to reverse, run one short bounded second pass on the `sonnet` class and ask only which approach it would pick.
- **Measure, don't guess.** Confirm file count and scale with `git diff --stat` and `git status --porcelain`. A model's self-estimate of its own diff size is not a measurement.
- **Escalate a flash run that grew.** If a `flash` worker's finished work outgrew the trivial test or hit a carve-out, send it no further edits; finish or redo on `coding`.

## Carve-outs: never flash

- authentication, authorization, session or token handling
- payments, billing, pricing, or money arithmetic
- database schema or migrations
- secrets, keys, credentials, or crypto
- public API contracts, wire formats, or serialization shared across services
- anything that deletes or overwrites user data

## Token efficiency

- Keep bulky I/O (command output, logs, test runs, data files) out of context; print only the derived answer.
- Use boomerang for long autonomous stretches so raw output never accumulates in context.
- Child reports must be short summaries plus a log path, not raw output.
- Prefer LSP queries (`lsp_symbols`, `lsp_hover`, `lsp_definition`) over reading whole files.
- Encode repeated workflows as templates with deterministic pre-steps instead of re-reasoning them each time.

## Notes

- These are prompt-level instructions, not runtime enforcement. A parent can still use its own tools directly; treat the delegation rule as a strong nudge, not a guarantee.
- For a hard guarantee, gate the parent's own write/edit tools behind a permission policy.
- Name the subagent explicitly in every instruction, and re-plan when a later request changes scope rather than re-litigating an approved plan.
