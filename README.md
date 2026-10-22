# pi-orchestrator

A pi extension that ships a default agent workflow and injects it into the
system prompt, so installing the package gives you a working
plan -> implement -> review loop without writing an AGENTS.md. It also renders
your `failover.json` into a model roster, so the workflow can name capability
classes instead of hardcoding model names.

## What it does

Two sections are injected, and neither ever names a specific model.

**Workflow.** The packaged default in `assets/ORCHESTRATOR.example.md` is
injected only when all four required companion extensions are installed;
otherwise it is withheld (the roster still injects). Your own
`ORCHESTRATOR.md` in the current directory, a parent, or the pi agent dir
replaces the default outright and is always injected verbatim, never withheld.
`/workflow doctor` reports what is present and whether the workflow is
withheld.

**Model roster.** Read from your failover config and rendered one line per
capability class, listing each class's models in failover order with
input/output cost and modality:

```
## Model roster (from failover.json)
`failover/<name>` resolves to the first set containing the name; requests fail
over circularly within that class and never cross classes. Image requests skip
backends without image support.
- strong: strong-model ($1.4/$4.4, text) -> second-model ($3/$15, text+image)
- code: code-model ($0.95/$4, text+image, :xhigh->max) -> fallback-model
- fast: fast-model ($0.14/$0.28, text) -> second-fast ($0.15/$0.5, text+image)
```

Each model is shown as `name ($in/$out, modality)`. A model appearing in more
than one class carries full details the first time and a bare name after, and
a model whose `thinkingLevelMap` maps `xhigh` gets a `:xhigh->max` marker.

## Why it exists

A workflow file like `ORCHESTRATOR.md` should name capability classes (`opus`, `sonnet`, `flash`, `coding` are conventional names, not required ones) rather than model names. That way swapping a model in `failover.json` never requires editing the workflow file: the next run picks up the new catalog automatically, and the injected section always describes what each class currently resolves to.

## Install

```
pi install git:github.com/rthadani/pi-orchestrator
```

## Config

It honours `FAILOVER_CONFIG`, defaulting to `~/.pi/agent/failover.json`, the same convention as pi-failover. The config is the same JSON shape that pi-failover already reads: a `sets` array, where each set has a `name` and a `models` array.

## Behaviour

The roster is rendered once and cached. It is re-read only when the config file's mtime changes (or the resolved path changes). If the config is missing, unreadable, or malformed, the extension injects nothing and warns once at load; it never throws into a session.

The `/roster` command prints exactly what would be injected, plus the config path and mtime. Set `ROSTER_DEBUG=1` to log the same report at load.

`/workflow` reports which workflow source won (your `ORCHESTRATOR.md` with its
path, or the packaged default with its mtime); `/workflow init` copies the
template to a file you own; `/workflow doctor` audits which required
extensions are installed and whether the workflow is currently withheld or
injecting. Set `ORCHESTRATOR_DEBUG=1` to log the workflow report at load.

## Default workflow

The package ships a full default orchestration workflow (`assets/ORCHESTRATOR.example.md`). It is injected into the system prompt only when no `ORCHESTRATOR.md` is found. When you create one, it replaces the default outright: the default and your file are never both injected, so they cannot contradict each other.

Search order, nearest wins:

1. `ORCHESTRATOR.md` in the current working directory
2. `ORCHESTRATOR.md` in any parent directory, up to the filesystem root
3. `ORCHESTRATOR.md` in the agent dir (`~/.pi/agent`, or `PI_CODING_AGENT_DIR`), the global fallback

The model roster is independent: it always comes from `failover.json`, whether or not a workflow file is injected.

`pi` still loads `AGENTS.md` (and the other context files) itself, so `AGENTS.md` is not a substitute for `ORCHESTRATOR.md` and does not suppress the default workflow.

To start customizing, run:

```
/workflow init
```

That copies the packaged example to `./ORCHESTRATOR.md` (or to a path you pass, e.g. `/workflow init /some/where/ORCHESTRATOR.md`). It refuses to overwrite an existing file. Edit the file, then restart or reload pi.

A shipped-default-only setup needs the four required extensions installed: with
no `ORCHESTRATOR.md` anywhere, the packaged default is injected in full once
they are present. To disable the shipped default while keeping the roster,
create an empty `ORCHESTRATOR.md`.

The shipped asset is not meant to be edited in place: package updates overwrite it. Use `/workflow init` to start a copy you own.

## Required extensions

The workflow requires four companion extensions. None are installed
automatically by this package; `/workflow doctor` reports what is installed and
whether the workflow is withheld.

| Extension | Why the workflow needs it | Install |
| --- | --- | --- |
| `pi-subagents` | the oracle/worker/reviewer/scout/researcher roles | `pi install npm:pi-subagents` |
| `pi-boomerang` | long autonomous runs without raw output in context | `pi install npm:pi-boomerang` |
| `context-mode` | bulky-I/O rules via `ctx_execute`/`ctx_batch_execute`/`ctx_search` | `pi install npm:context-mode` |
| `pi-failover` | the model roster and `failover/<name>` routing | `pi install git:github.com/rthadani/pi-failover` |
| `ask_user` (optional) | the one-focused-question rule | `pi install npm:pi-ask-user` |

`pi-subagents`, `pi-boomerang`, `context-mode`, and `pi-failover` are required:
when any one is not installed, the packaged workflow is withheld (not injected)
until it is. The check is on installation (pi's settings `packages` plus the
model registry's `failover` provider), never on runtime tool visibility, so a
lazy extension that has not yet registered its tools does not suppress the
workflow. The model roster is independent and still injects. `ask_user` is
optional and never gates anything; the one-question-at-a-time rule degrades
gracefully without the tool.

Your own `ORCHESTRATOR.md` is never withheld: when one is present it is
injected verbatim, exactly as written, regardless of which extensions are
installed.

## What it deliberately does not do

It makes no routing decisions and never contacts a provider. The roster section itself contains no role or policy text; policy (which class to pick when, escalation rules, review discipline) lives in your `ORCHESTRATOR.md`, or in the packaged default workflow when you have none.

## Publishing

Publishing happens from CI when a version tag is pushed. The maintainer bumps `version` in package.json, commits, then runs `git tag v<version> && git push origin v<version>`. The workflow refuses to publish if the tag and the package version disagree. It requires an `NPM_TOKEN` repository secret with publish rights to the `@rthadani` scope; when the secret is missing, the workflow fails with a clear error before publishing. A manual run (`workflow_dispatch`) defaults to a dry run and uploads nothing unless you set `dry_run` to `false`; tag pushes publish for real. Provenance requires the repository to be public.

## Tests

```
node test/roster-render.test.mjs
```

The harness needs no install and no dependencies; it exercises the pure render function and the mtime-cached loader with offline fixtures.

## Notes

Pi loads extensions at startup, so restart after installing. Do not keep a second copy in `~/.pi/agent/extensions/`, or the provider/section registers twice.
