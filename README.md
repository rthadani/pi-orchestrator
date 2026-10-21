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

A workflow file like `AGENTS.md` should name capability classes (`opus`, `sonnet`, `flash`, `coding` are conventional names, not required ones) rather than model names. That way swapping a model in `failover.json` never requires editing the workflow file: the next run picks up the new catalog automatically, and the injected section always describes what each class currently resolves to.

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

The package ships a condensed default orchestration workflow (`assets/workflow.md`). It is injected into the system prompt only when you have no context file of your own. Any of these files, in the current working directory, any parent directory, or the agent dir, wins and replaces the default:

`AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, `CLAUDE.MD`

The model roster is independent: it always comes from `failover.json`, whether or not a default workflow is injected.

To disable the shipped default while keeping the roster, create an empty `AGENTS.md`.

The shipped asset is not meant to be edited in place: package updates overwrite it. To change the workflow, put your own context file in the project (or the agent dir) instead.

## What it deliberately does not do

It makes no routing decisions and never contacts a provider. The roster section itself contains no role or policy text; policy (which class to pick when, escalation rules, review discipline) lives in your context file, or in the packaged default workflow when you have none.

## Tests

```
node test/roster-render.test.mjs
```

The harness needs no install and no dependencies; it exercises the pure render function and the mtime-cached loader with offline fixtures.

## Notes

Pi loads extensions at startup, so restart after installing. Do not keep a second copy in `~/.pi/agent/extensions/`, or the provider/section registers twice.
