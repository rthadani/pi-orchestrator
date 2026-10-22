# pi-orchestrator

A pi extension that ships a default agent workflow and injects it into the
system prompt, so installing the package gives you a working
plan -> implement -> review loop without writing an AGENTS.md. It injects
exactly one section, the workflow. The model roster lives in pi-failover,
which is a required companion and registers `model_roster` itself.

## What it does

This package injects one section, the workflow, and never names a specific
model.

**Workflow.** The packaged default in `assets/ORCHESTRATOR.example.md` is
injected only when all four required companion extensions are installed;
otherwise it is withheld. Your own `ORCHESTRATOR.md` in the current
directory, a parent, or the pi agent dir replaces the default outright and is
always injected verbatim, never withheld. `/workflow doctor` reports what is
present and whether the workflow is withheld.

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

The workflow is resolved once and cached. It is re-read only when the winning
file's mtime changes (or the resolved path changes). If the file is missing,
unreadable, or empty, the extension injects no workflow and warns once at
load; it never throws into a session.

`/workflow` reports which workflow source won (your `ORCHESTRATOR.md` with its
path, or the packaged default with its mtime); `/workflow init` copies the
template to a file you own; `/workflow doctor` audits which required
extensions are installed and whether the workflow is currently withheld or
injecting. Set `ORCHESTRATOR_DEBUG=1` to log the workflow report at load.

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
