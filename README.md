# pi-orchestrator

A pi extension that renders the models in your `failover.json` into a compact system-prompt section, so your workflow file can name capability classes instead of hardcoding model names.

## What it does

At startup it reads your failover config and renders one line per capability class, listing that class's models in failover order with input/output cost and modality. The result is appended to the system prompt as a "Model roster" section:

```
## Model roster (from failover.json)
`failover/<name>` resolves to the first set containing the name; requests fail
over circularly within that class and never cross classes. Image requests skip
backends without image support.
- strong: strong-model ($1.4/$4.4, text) -> second-model ($3/$15, text+image)
- code: code-model ($0.95/$4, text+image, :xhigh->max) -> fallback-model
- fast: fast-model ($0.14/$0.28, text) -> second-fast ($0.15/$0.5, text+image)
```

Each model is shown as `name ($in/$out, modality)`. A model that appears in more than one class is listed with full details the first time and as a bare name after, and a model whose `thinkingLevelMap` maps `xhigh` carries a `:xhigh->max` marker.

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

## Default workflow

The package ships a condensed default orchestration workflow (`assets/ORCHESTRATOR.example.md`). It is injected into the system prompt only when no `ORCHESTRATOR.md` is found. When you create one, it replaces the default outright: the default and your file are never both injected, so they cannot contradict each other.

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

A shipped-default-only setup needs nothing: with no `ORCHESTRATOR.md` anywhere, the packaged default is injected with capability filtering applied (see the next section). To disable the shipped default while keeping the roster, create an empty `ORCHESTRATOR.md`.

The shipped asset is not meant to be edited in place: package updates overwrite it. Use `/workflow init` to start a copy you own.

## Capability-aware workflow

The shipped default workflow adapts to what is actually installed. Blocks that depend on tools from other pi packages are wrapped in capability markers and are injected only when the matching tools are present, so a clean install never tells the model to call a tool that does not exist. Unmarked rules (plan before code, the carve-out list, token efficiency, the closing notes) are always injected.

| Capability | Needed for | Install when missing |
| --- | --- | --- |
| `subagent` | the oracle/worker/reviewer/scout/researcher roles | `pi install npm:pi-subagents` |
| `boomerang` | long autonomous runs without raw output in context | `pi install npm:pi-boomerang` |
| `context-mode` | bulky-I/O rules via `ctx_execute`/`ctx_batch_execute`/`ctx_search` | `pi install npm:context-mode` |
| `ask_user` | the one-focused-question rule | `pi install npm:pi-ask-user` |

A user `ORCHESTRATOR.md` is never filtered: it is injected verbatim, exactly as written, because you wrote it deliberately. Only the packaged default asset is capability-filtered.

Run `/workflow doctor` to audit what is missing. It reports each capability, which tool satisfied it, and the exact install command for each gap. If no failover config exists it also recommends `pi install git:github.com/rthadani/pi-failover` as the model provider.

## What it deliberately does not do

It makes no routing decisions and never contacts a provider. The roster section itself contains no role or policy text; policy (which class to pick when, escalation rules, review discipline) lives in your `ORCHESTRATOR.md`, or in the packaged default workflow when you have none.

## Tests

```
node test/roster-render.test.mjs
```

The harness needs no install and no dependencies; it exercises the pure render function and the mtime-cached loader with offline fixtures.

## Notes

Pi loads extensions at startup, so restart after installing. Do not keep a second copy in `~/.pi/agent/extensions/`, or the provider/section registers twice.
