# pi-orchestrator

A pi extension that ships a default agent workflow, injects it into the system
prompt where an `AGENTS.md` would go, and enforces it by blocking direct code
changes, not reads or builds, until a subagent has been spawned. Installing the
package gives you a working plan -> implement -> review loop without writing an
AGENTS.md. The model roster lives in pi-failover, which is a required companion
and registers `model_roster` itself.

## What it does

Two mechanisms. Both are needed, and neither alone was enough.

**Injection.** The winning workflow is added to `systemPromptOptions.contextFiles`,
which pi renders inside `<project_context>` as
`<project_instructions path="...">`. That is the same slot, framing, and
position as `AGENTS.md`, and it carries the same authority. A custom prompt
section always renders *after* `<cwd>` - last in the prompt, behind the skills
list - which is the weakest position available and is why the workflow used to
be readable but ignored.

**Enforcement.** `tool_call` handlers can block a call. Until a `subagent` spawn
has happened in that session, the gate blocks a *project code write* and
nothing else.

### What the gate blocks

- Edits and writes to a source file: a code extension (`.ts`, `.tsx`, `.js`,
  `.py`, `.go`, `.rs`, `.java`, `.sh`, and the like), or any file under `src/`,
  `app/`, `lib/`, `packages/`, `extensions/`. A docs extension wins over the
  directory rule, so `src/README.md` stays a direct edit.
- Commands that change tracked repository state: `git commit`, `push`, `reset`,
  `checkout`, `rebase`, `merge`, `cherry-pick`, `revert`, `clean`,
  `git stash drop`, `git tag -d`.
- Project-local dependency installs: `npm i`, `yarn add`, `pnpm add`,
  `pip install`, `cargo add`, `go get`.
- A formatter or linter in its write mode: `prettier --write`, `eslint --fix`,
  `gofmt -w`, `rustfmt`.
- Migrations.
- An irreversible delete (`rm`, `shred`, `truncate`, `dd`), or a redirect into a
  source file.

### What passes directly

- Reads, `grep`, `find`, `ls`, LSP tools, `ctx_search`, web tools.
- Builds and type checks (`npx tsc`, `npm run build`), and test runs (`npm
  test`, `vitest`, `pytest`).
- Tooling installs: `pi install`, `pi uninstall`, `npm i -g`.
- `git status|log|diff|show|branch|remote|fetch`.
- Documentation and config edits (`.md`, `.json`, `.yaml`, `.toml`), wherever
  they live.
- Anything under the pi agent dir (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`).

Classification is permissive on purpose. An unknown tool, an unparseable
command, or a write we cannot classify is allowed, so a misclassification errs
toward letting work through, never toward blocking it: a wrong block costs a
scout/oracle/worker round trip for work that never needed one, which is the
failure that made ordinary tasks unusable. `subagent` and `ask_user` always
pass. Child agent sessions are exempt, because pi-subagents runs children as pi
sessions inside the same process and gating them would deadlock the scout the
gate exists to force. Counts are per session and per spawn, so a failed or
abandoned spawn cannot leave the gate stuck open.

A completed top-level code write re-arms that session: the next code change must
delegate again, which is what keeps implementation on `worker` instead of in the
orchestrator. An inspection or a test run does not re-arm.

**Workflow.** The packaged default in `assets/ORCHESTRATOR.example.md` is
injected only when all four required companion extensions are installed;
otherwise it is withheld, and a withheld workflow is never enforced. Your own
`ORCHESTRATOR.md` in the current directory, a parent, or the pi agent dir
replaces the default outright and is always injected verbatim, never withheld.
`/workflow doctor` reports what is present, whether the workflow is withheld,
and whether the gate is armed.

**Model roster.** This package does not render or inject the model roster.
pi-failover owns that section: it registers `model_roster` itself, so the
workflow can name capability classes instead of hardcoding model names.

## Why it exists

A workflow file like `ORCHESTRATOR.md` should name capability classes
(`opus`, `sonnet`, `flash`, `coding` are conventional names, not required
ones) rather than model names. That way swapping a model in `failover.json`
never requires editing the workflow file: pi-failover's roster section always
describes what each class currently resolves to.

## Install

```
pi install git:github.com/rthadani/pi-orchestrator
```

pi-failover is a required companion, so install it too:

```
pi install git:github.com/rthadani/pi-failover
```

## Behaviour

The workflow is resolved once per resolved path and cached. It is re-read only
when that file's mtime or size changes. If the file is missing, unreadable, or
empty, the extension injects no workflow, enforces nothing, and warns once at
load; it never throws into a session.

Enforcement has one switch: `WORKFLOW_ENFORCE=off` (also `0`, `false`, `no`)
disables the gate for the process while leaving injection intact. There is no
per-task bypass: the gate classifies the shape of a write, not the significance
of the work, so it cannot decide that one particular task is small enough to
skip delegation, and a bypass command is exactly what gets used to skip the
work.

`/workflow` reports which workflow source won (your `ORCHESTRATOR.md` with its
path, or the packaged default with its mtime); `/workflow init` copies the
template to a file you own; `/workflow doctor` audits which required extensions
are installed, whether the workflow is currently withheld or injecting, and
whether the gate is armed for this session. Set `ORCHESTRATOR_DEBUG=1` to log
the workflow report at load.

## Default workflow

The package ships a full default orchestration workflow
(`assets/ORCHESTRATOR.example.md`). It is injected into the system prompt only
when no `ORCHESTRATOR.md` is found. When you create one, it replaces the
default outright: the default and your file are never both injected, so they
cannot contradict each other.

Search order, nearest wins:

1. `ORCHESTRATOR.md` in the current working directory
2. `ORCHESTRATOR.md` in any parent directory, up to the filesystem root
3. `ORCHESTRATOR.md` in the agent dir (`~/.pi/agent`, or
   `PI_CODING_AGENT_DIR`), the global fallback

`pi` still loads `AGENTS.md` (and the other context files) itself, so
`AGENTS.md` is not a substitute for `ORCHESTRATOR.md` and does not suppress
the default workflow.

To start customizing, run:

```
/workflow init
```

That copies the packaged example to `./ORCHESTRATOR.md` (or to a path you
pass, e.g. `/workflow init /some/where/ORCHESTRATOR.md`). It refuses to
overwrite an existing file. Edit the file, then restart or reload pi.

A shipped-default-only setup needs the four required extensions installed: with
no `ORCHESTRATOR.md` anywhere, the packaged default is injected in full once
they are present. To disable the shipped default, create an empty
`ORCHESTRATOR.md`.

The shipped asset is not meant to be edited in place: package updates overwrite
it. Use `/workflow init` to start a copy you own.

## Required extensions

The workflow requires four companion extensions. None are installed
automatically by this package; `/workflow doctor` reports what is installed and
whether the workflow is withheld.

| Extension | Why the workflow needs it | Install |
| --- | --- | --- |
| `pi-subagents` | the oracle/worker/reviewer/scout/researcher roles | `pi install npm:pi-subagents` |
| `pi-boomerang` | long autonomous runs without raw output in context | `pi install npm:pi-boomerang` |
| `context-mode` | bulky-I/O rules via `ctx_execute`/`ctx_batch_execute`/`ctx_search` | `pi install npm:context-mode` |
| `pi-failover` | the failover provider, which injects the model roster and provides `failover/<name>` routing | `pi install git:github.com/rthadani/pi-failover` |
| `ask_user` (optional) | the one-focused-question rule | `pi install npm:pi-ask-user` |

`pi-subagents`, `pi-boomerang`, `context-mode`, and `pi-failover` are required:
when any one is not installed, the packaged workflow is withheld (not injected)
until it is. The check is on installation (pi's settings `packages` plus the
model registry's `failover` provider), never on runtime tool visibility, so a
lazy extension that has not yet registered its tools does not suppress the
workflow. `ask_user` is optional and never gates anything; the
one-question-at-a-time rule degrades gracefully without the tool.

Your own `ORCHESTRATOR.md` is never withheld: when one is present it is
injected verbatim, exactly as written, regardless of which extensions are
installed.

## What it deliberately does not do

It makes no routing decisions and never contacts a provider. It does not
render or inject the model roster: that section belongs to pi-failover. Policy
(which class to pick when, escalation rules, review discipline) lives in your
`ORCHESTRATOR.md`, or in the packaged default workflow when you have none.

It also does not judge your task. It recognises the shape of a code write, not
the significance of a task: it cannot tell a new feature from a one-line typo
fix, so it enforces the shape of the work (delegate, then do) for the one class
it can name, project code writes, and lets everything else through. The
orchestration judgement for genuine feature work still lives in the injected
prompt, not in the gate. The remaining hole is a code write no text pattern
can name: `node -e 'fs.writeFileSync(...)'`, `cp src/a.ts src/b.ts`, a
`codemode` script, or a JS `ctx_execute` body are all allowed, because calling
them writes would be a guess. Treat the gate as a nudge toward the workflow,
not a sandbox.

## Publishing

Publishing authenticates with npm Trusted Publishing (OIDC): no npm token is
stored in this repository, and provenance is generated automatically.

**One-time bootstrap (hard prerequisite):** npm cannot create a brand-new
package over OIDC, so the first version must be published once outside this
workflow (per npm's own guidance). After that first publish, every later
version publishes from CI. Register the trusted publisher on npmjs.com:
package Settings -> Trusted Publishing -> GitHub Actions, with user
`rthadani`, repository `pi-orchestrator`, workflow filename `publish.yml`, and
an empty environment. The workflow filename is part of the trust binding:
renaming or moving `.github/workflows/publish.yml` breaks publishing until the
registration is updated.

Publishing happens from CI when a version tag is pushed: the maintainer bumps
`version` in package.json, commits, then runs
`git tag v<version> && git push origin v<version>`. The workflow refuses to
publish if the tag and the package version disagree. A manual run
(`workflow_dispatch`) defaults to a dry run and uploads nothing; a `v*` tag
publishes for real. Requirements: npm CLI >= 11.5.1 (the workflow upgrades npm
itself) and a public repository.

## Tests

```
node test/workflow.test.mjs
```

The harness needs no install and no dependencies; it exercises workflow
resolution, installation gating, and section injection with offline fixtures.

## Notes

Pi loads extensions at startup, so restart after installing. Do not keep a
second copy in `~/.pi/agent/extensions/`, or the provider/section registers
twice.

Upgrade pi-orchestrator and pi-failover together, because older mixes write
the same section key.
