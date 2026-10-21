# pi-orchestrator

A pi extension that ships a default agent workflow and injects it into the
system prompt, so installing the package gives you a working
plan -> implement -> review loop without writing an AGENTS.md. It also renders
your `failover.json` into a model roster, so the workflow can name capability
classes instead of hardcoding model names.

## What it does

Two sections are injected, and neither ever names a specific model.

**Workflow.** The packaged default in `assets/ORCHESTRATOR.example.md` is
injected in full unless you provide your own `ORCHESTRATOR.md` in the current
directory, a parent, or the pi agent dir. Yours replaces the default outright.
The workflow expects a few companion extensions; none are installed
automatically, and `/workflow doctor` reports what is missing.

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
extensions are installed. Set `ORCHESTRATOR_DEBUG=1` to log the workflow
report at load.

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

A shipped-default-only setup needs nothing: with no `ORCHESTRATOR.md` anywhere, the packaged default is injected in full. To disable the shipped default while keeping the roster, create an empty `ORCHESTRATOR.md`.

The shipped asset is not meant to be edited in place: package updates overwrite it. Use `/workflow init` to start a copy you own.

## Required extensions

The workflow expects three companion extensions and treats one as optional.
None of them are installed automatically by this package; `/workflow doctor`
reports what is missing.

| Extension | Why the workflow needs it | Install |
| --- | --- | --- |
| `pi-subagents` | the oracle/worker/reviewer/scout/researcher roles | `pi install npm:pi-subagents` |
| `context-mode` | bulky-I/O rules via `ctx_execute`/`ctx_batch_execute`/`ctx_search` | `pi install npm:context-mode` |
| `pi-boomerang` | long autonomous runs without raw output in context | `pi install npm:pi-boomerang` |
| `ask_user` (optional) | the one-focused-question rule | `pi install npm:pi-ask-user` |

`pi-subagents`, `context-mode`, and `pi-boomerang` are required: when one is
missing, `/workflow doctor` reports it as missing and required. `ask_user` is
optional and degrades gracefully, because the one-question-at-a-time rule can
be followed without the tool.

The full workflow asset is always injected, regardless of which extensions
are installed; it is never filtered or gated. A user `ORCHESTRATOR.md` is also
injected verbatim, exactly as written.

## What it deliberately does not do

It makes no routing decisions and never contacts a provider. The roster section itself contains no role or policy text; policy (which class to pick when, escalation rules, review discipline) lives in your `ORCHESTRATOR.md`, or in the packaged default workflow when you have none.

## Tests

```
node test/roster-render.test.mjs
```

The harness needs no install and no dependencies; it exercises the pure render function and the mtime-cached loader with offline fixtures.

## Notes

Pi loads extensions at startup, so restart after installing. Do not keep a second copy in `~/.pi/agent/extensions/`, or the provider/section registers twice.
