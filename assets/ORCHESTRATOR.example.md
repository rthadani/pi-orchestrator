This project uses pi-subagents for a plan → implement → parallel-review workflow,
with a confirmation stop only when the plan needs a real decision (step 2).
Follow these rules whenever a task involves designing or changing code here.

## Workflow

1. **Design first.** For any non-trivial change, delegate design to the `oracle`
   subagent before writing any code yourself. Do not implement anything until a
   plan exists.

   A change is **trivial** when all of these hold: one or two files touched and
   roughly 50 changed lines or fewer; no new dependency, public API, schema,
   config key, or deployment surface; no behaviour change to an existing
   feature beyond a bug fix; and no answer from you is needed for it to be
   written correctly. Everything else is non-trivial.

   **Optional recon and research inputs to design.** Two subagents may feed
   this step, conditionally, never by default:

   - If the task touches unfamiliar parts of the codebase and the relevant
     files, symbols, or entry points are not already known, launch `scout`
     first for compressed recon and hand its findings to `oracle`. Skip it
     when the change surface is small or already mapped.
   - If the design hinges on external facts (library or API behavior, version
     compatibility, benchmarks, security or licensing claims), launch
     `researcher` for a sourced brief and feed it back to `oracle` before the
     plan is finalized. Skip it when the design is decidable from the code
     and docs already in hand.

   Both are read-only inputs to design, not extra pipeline stages; do not run
   them just because they exist.

   **Grill the user during design.** `oracle` must not guess at open questions
   (scope, trade-offs, constraints, multiple valid approaches); it returns them
   alongside its analysis, and the parent asks one focused question at a time
   (via `ask_user`), feeding answers back until the design is settled. This
   holds even when `oracle` returns a confident plan: a non-trivial change with
   a genuine open question is asked about before `worker` touches code. For a
   trivial change, do not ask: state the change in one line and implement it.
   Presenting a plan built on unspoken assumptions counts as a workflow
   failure.

2. **Pause after planning only when the plan needs a real decision.** Once
   `oracle` returns, review the plan before implementing:
   - **Proceed straight to `worker`** when the design matches what the user
     asked for and raises nothing the user must decide — announce the plan in
     a line or two and start implementation. The three-reviewer fanout is the
     safety net; do not ask "should I proceed?" when a yes is the only
     possible answer.
   - **STOP and ask** when there is a genuine decision: open questions oracle
     returned, judgment calls extending beyond the original request,
     destructive or hard-to-reverse steps, or changes touching schema, API
     contracts, security, or deployment posture. Present the specific
     decision points and wait for explicit approval ("go ahead", "looks
     good", "proceed", or similar).
   - If the user's approval message also specifies changes to the plan,
     incorporate those before implementing — don't implement the original
     plan if it was amended.

3. **Implementation is always delegated to `worker`. Never implement directly.**
   The parent orchestrating this session must not use its own write/edit/bash
   tools to make the code change itself, even if it has those tools available
   and even if delegating feels like unnecessary overhead for a small change.
   `worker` is only invoked once a plan exists for a non-trivial change; a
   trivial change may go straight to `worker`. Every implementation step goes
   through
   `subagent({ agent: "worker", model: "<class>", task: "..." })`
   or `/run worker "..."` with the same model passed explicitly.
   The model must be passed on every `worker` spawn, chosen per the "Coding
   entry point is chosen per task, not fixed" rule in Model selection; omitting
   it inherits the session model, which is not the intended routing.
   If you find yourself about to call `write` or `edit` on this repo's source
   files directly, stop and delegate to `worker` instead.

   **Wrap steps 3–5 in boomerang.** Once the plan is approved and no further
   user decisions are needed, invoke the `boomerang` tool with the full
   implement → review → fix loop as one task instead of running it
   turn-by-turn:

   `boomerang({ task: "implement the approved plan, then run the three
   parallel reviewers (correctness, tests, simplicity), then apply the fixes
   that make sense" })`

   This collapses the raw turn history into a handoff summary. Skip boomerang
   for small single-file changes or when mid-task decisions are expected.

4. **Review is automatic after implementation, and runs three reviewers
   in parallel — not one.** As soon as `worker` reports changes, launch three
   concurrent reviewers against the change without waiting for further
   confirmation. For a documentation-only change (no executable file touched),
   one consistency check is enough instead of three.

   - **Correctness** — logic errors, incorrect handling of edge cases
     (null/nil values, empty collections, off-by-one errors, concurrency
     issues such as races or deadlocks), whether the implementation
     actually matches the approved plan
   - **Tests** — test coverage for the change, whether existing tests still
     pass, whether new logic paths are exercised
   - **Simplicity / style** — unnecessary complexity, non-idiomatic code
     for the language in use, unclear naming, dead code, global mutable
     state (module-level mutable variables, atoms, singletons holding
     state) instead of explicitly passed parameters or injected
     dependencies

   Use genuine concurrent fan-out, not sequential steps — the parenthesized
   group syntax runs all three at once within a single chain step:
   /chain worker "implement the plan" -> (reviewer "correctness and edge cases" | reviewer "test coverage, run the test suite" | reviewer "simplicity and idiomatic style") -> worker "apply the fixes that make sense"
   or the natural-language equivalent ("run three reviewers on this diff in
   parallel: one for correctness, one for tests, one for simplicity"). Do not
   settle for a single reviewer pass, and do not chain the three reviewers one
   after another with plain `->` — that runs them sequentially, not in
   parallel. Review is only complete once all three angles have reported back.

   Synthesize all three results into one summary for the user rather than
   reporting them as three separate blocks.

5. **On review findings, loop back to `worker` — don't just report and stop.**
   If any reviewer reports issues worth fixing, delegate the fixes back to
   `worker` with the specific findings, then re-run the three parallel
   reviewers on the new diff. Repeat this implement → review cycle until
   either: (a) all three reviewers report no further issues worth fixing, or
   (b) 3 rounds have been completed — whichever comes first. If the cap is
   hit with unresolved issues, summarize the remaining findings for the user
   instead of continuing to loop silently.

6. **Re-plan when the request is new, not to re-litigate an approved plan.**
   Don't spawn a second `oracle` run for the same task unless the user asks
   for a revised plan or the plan was rejected. Do run `oracle` again when a
   later request has a different scope, surface, or acceptance criteria than
   the plan already approved (a new feature, a new file area, a behaviour
   change), because that is a new design rather than a re-plan.

## Agent roles

- `oracle` — design only, read-only tools, no code changes.
- `scout` — fast codebase recon, read-only. Conditionally gathers compressed
  context for `oracle` before design (see step 1).
- `researcher` — web research, read-only. Conditionally produces a sourced
  brief for `oracle` during design (see step 1).
- `worker` — the only agent that writes code. Always delegated to, never
  replaced by the parent doing it directly.
- `reviewer` — read-only critique of a diff, never edits. Run three at once
  in the review phase (correctness, tests, simplicity), never just one.

## Model selection

Every subagent runs through the `failover` provider (classes defined in
`~/.pi/agent/failover.json`), so a provider running out of credits fails over
to the next model in that agent's class instead of stopping the run. Pass the
model explicitly on every spawn. Fixed assignments: `scout` uses the `flash`
class (escalate to `sonnet` only for dense or unfamiliar codebases) and
`researcher` uses the `sonnet` class.

**Triage assigns class for `oracle` and the reviewers.** Before the detailed
design, spawn `oracle` on the `sonnet` class with a bounded
task: analyze the problem statement and return ONLY a class map — one class
for `oracle` and each of the three reviewers, plus an optional override for
`worker` — with a one-line reason per role and any risk flags. No detailed
design in that run. For trivial, well-scoped changes the parent may skip
triage: reviewers run on their default classes (correctness on `sonnet`, tests
and simplicity on `flash`), and `worker`'s class comes from the
coding-entry-point rule in Model selection.

**Opus is opt-in.** Sonnet covers ~95% of code work. If triage (or oracle's
later recommendation) assigns the `opus` class to ANY
role, the parent must first ask the user one focused question naming the
role, the reason, and what sonnet would risk. Without explicit approval,
that role runs on sonnet instead.

**Design and execution at the assigned classes.** The detailed `oracle` run
and the three parallel reviewers spawn on their triage-assigned classes;
`worker`'s default class comes from the coding-entry-point rule below unless
triage or `oracle` overrides it. Oracle's design still ends with
`Recommended model class: <opus|sonnet|coding|flash>` plus a one-line reason
grounded in the requirements; if it differs from triage, the parent applies
it — subject to the opus approval rule above.

Class names — `opus`, `sonnet`, `flash`, `coding` — are the only model
vocabulary this workflow uses. An injected Model roster section lists each class,
its models in failover order, their costs and their modalities; take every
model name from there rather than writing one in this workflow.

Always pass a `failover/<name>` string; never a raw provider model id.

**Reviewer classes: correctness → `sonnet`, tests → `flash`,
simplicity/style → `flash`.** The tests reviewer is the cheap one: its job is
running commands and reporting output, not reasoning about correctness.
Correctness keeps the stronger class, because that is where subtle logic
errors hide. Triage or `oracle` may override per reviewer; opus still
requires the approval above.

**Escalate thinking effort before you escalate the model.** When the request
leaves a real design decision open, or the change spans more than a couple of
files or subsystems, spawn `oracle` on the first-listed model of the `sonnet`
class and append `:xhigh` to that model's name (the roster marks it
`:xhigh->max`). The suffix is stripped before name resolution. Do not use
bare `:max`, which has no entry in that `thinkingLevelMap`.

**Second opinion on a contested call.** When `oracle` returns a design with
two viable approaches, or the decision is expensive to reverse (schema, public
API contract, deployment posture, security), run one short bounded second pass
on the second-listed model of the `sonnet` class. Give it the same problem
plus oracle's recommendation, and ask only which approach it would pick and
what the recommendation misses. Do not let it redesign from scratch.

Keep that second pass to one. That model shares a provider wallet with the
coding class's primary, so a long pass competes with the budget coding
depends on.

**Coding entry point is chosen per task, not fixed.** `worker`'s **default**
class is picked at spawn time by step 1's trivial test, the single definition
of trivial. If triage or `oracle` assigns a stronger class, that wins,
subject to the opus approval rule.

- **trivial, per step 1 → the `flash` class**
- **non-trivial, or any carve-out area → the `coding` class**

`worker`'s classes are `flash` and `coding` only; `sonnet` is for `oracle`,
`reviewer` and `researcher`.

**Mechanical operations go to `flash`, whatever their blast radius.**
`git add`/`commit`/`push`, file moves, renames, formatting, and config
transcription are routed by how little reasoning they need, not by how visible
they are. Safety on an irreversible step comes from explicit constraints in
the prompt (never force-push, never amend, do not change the remote, report
errors verbatim), not from choosing a stronger model.

**Measure, do not guess, the size.** If the work sits inside a git repository
(`cd` into the specific project first; the parent directory is not one),
confirm the file count and scale with `git diff --stat` and
`git status --porcelain`. Otherwise count the files yourself. A model's
self-estimate of its own diff size is not a measurement.

**Carve-out: never flash, no matter how small the diff.**

- authentication, authorization, session or token handling
- payments, billing, pricing, or money arithmetic
- database schema or migrations
- secrets, keys, credentials, or crypto
- public API contracts, wire formats, or serialization shared across services
- anything that deletes or overwrites user data

A three-line change in these areas is still a large change in risk.

**Escalate when a flash run grew.** A flash `worker` cannot be killed mid-run,
so check when it returns: re-count the files it touched, and if the finished
work outgrew step 1's trivial test or hit a carve-out, send it no further
edits. Finish or redo the work on the `coding` class.

**Why this routing lives in this workflow and not in failover.json.** failover.json is
reactive-only with no task-size input, so this routing lives in the parent's
spawn call.

## Token efficiency

These rules apply to the parent and every subagent on every task, not just
the workflow above.

- **context-mode first for bulky I/O.** Never read large command output, log
  files, test runs, or whole data files into context. Process them with
  `ctx_execute` / `ctx_execute_file` / `ctx_batch_execute` and print only the
  derived answer. Index recurring references (API docs, specs, large READMEs)
  once with `ctx_index` or `ctx_fetch_and_index`, then query them with
  `ctx_search` instead of re-reading or re-fetching.
- **Boomerang long autonomous tasks.** See step 3; also for long build/test
  cycles, so raw output never accumulates in context.
- **LSP over file dumps.** Use `lsp_symbols`, `lsp_hover`, `lsp_definition`,
  and `lsp_references` to answer questions about code structure instead of
  reading whole files. Read file bodies only when editing or when the LSP
  cannot answer.
- **Concise child reports.** Subagent prompts must ask for a short summary
  plus a report/log path, not raw output. Long validation runs, test logs,
  and build output stay inside the child (or in a bounded log file); the
  parent receives conclusions and paths only.
- **Templates for repeated workflows.** When a workflow is run more than
  once, encode it as a pi-prompt-workflows template with deterministic
  pre-steps instead of re-reasoning the same orchestration each time.

## Notes

- Name the subagent explicitly in every instruction (e.g. "have worker
  implement this") rather than vague phrasing like "go ahead and build it" —
  vague phrasing is what let implementation happen in the main loop instead
  of through `worker` in an earlier run.
- This workflow is a prompt-level instruction, not a runtime enforcement
  mechanism — the parent can still technically use its own tools. Step 3 is
  written explicitly to close that gap, but treat it as a strong nudge, not
  a guarantee. For a hard guarantee instead of a nudge, gate the parent's own
  write/edit tools behind `pi-permission-system`'s `ask`/`deny` policy for
  this repo.
