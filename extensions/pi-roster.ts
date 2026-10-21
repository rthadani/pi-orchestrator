/**
 * pi-roster: inject the failover.json model catalog into the system prompt.
 *
 * AGENTS.md names capability classes (opus, sonnet, flash, coding) rather
 * than models; this roster section lists which models each class contains,
 * with cost, modality, and how `failover/<name>` is resolved. Policy (which
 * class to pick when, escalation rules, review discipline) stays in AGENTS.md
 * and is deliberately never rendered here.
 *
 * Warning: a class name is not a model string. Pass `failover/<model-name>`;
 * `failover/<class>` does not resolve to that class and falls back to the
 * configured default.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

interface FailoverModel {
  name: string;
  input?: ("text" | "image")[];
  cost?: { input?: number; output?: number };
  thinkingLevelMap?: Record<string, string>;
}

interface FailoverSet {
  name: string;
  models: FailoverModel[];
}

export interface FailoverConfig {
  sets: FailoverSet[];
}

export interface RosterState {
  /** The rendered roster section, or "" when the config could not be read. */
  section: string;
  /** The resolved config path. */
  path: string;
  /** File mtime in ms, or null when the file is missing. */
  mtimeMs: number | null;
  /** Why the roster is disabled, or null when a section was rendered. */
  disabled: string | null;
}

const ROSTER_HEADER = [
  "## Model roster (from failover.json)",
  "`failover/<name>` resolves to the first set containing the name; requests fail",
  "over circularly within that class and never cross classes. Image requests skip",
  "backends without image support.",
].join("\n");

/** Absent `input` means text-only; an `image` entry means text+image. */
function modalityLabel(model: FailoverModel): string {
  return (model.input ?? ["text"]).includes("image") ? "text+image" : "text";
}

function formatModel(model: FailoverModel): string {
  const parts: string[] = [];
  if (model.cost && typeof model.cost.input === "number" && typeof model.cost.output === "number") {
    parts.push(`$${model.cost.input}/$${model.cost.output}`);
  }
  parts.push(modalityLabel(model));
  const mappedEffort = model.thinkingLevelMap?.["xhigh"];
  if (mappedEffort) parts.push(`:xhigh->${mappedEffort}`);
  return `${model.name} (${parts.join(", ")})`;
}

/**
 * Render the roster section from a parsed config. Pure: no runtime imports, no
 * I/O, so it can be exercised offline. A model that appears in more than one
 * set is printed with full details the first time and as a bare name after.
 */
export function renderRoster(config: FailoverConfig): string {
  if (!config?.sets?.length) return "";
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const set of config.sets) {
    if (set === null || typeof set !== "object") continue;
    if (typeof set.name !== "string" || set.name.trim() === "") continue;
    const models = Array.isArray(set.models) ? set.models : [];
    if (models.length === 0) continue;
    const members: string[] = [];
    for (const model of models) {
      if (model === null || typeof model !== "object") continue;
      if (typeof model.name !== "string" || model.name.trim() === "") continue;
      if (seen.has(model.name)) {
        members.push(model.name);
        continue;
      }
      seen.add(model.name);
      members.push(formatModel(model));
    }
    if (members.length === 0) continue;
    lines.push(`- ${set.name}: ${members.join(" -> ")}`);
  }
  if (lines.length === 0) return "";
  return `${ROSTER_HEADER}\n${lines.join("\n")}`;
}

function configPath(): string {
  return process.env.FAILOVER_CONFIG || join(homedir(), ".pi", "agent", "failover.json");
}

function mtimeOf(path: string): number | null {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildRoster(path: string, mtimeMs: number | null): RosterState {
  if (mtimeMs === null) {
    return { section: "", path, mtimeMs: null, disabled: "config file missing" };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { section: "", path, mtimeMs, disabled: `unreadable: ${describeError(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return { section: "", path, mtimeMs, disabled: `invalid JSON: ${describeError(error)}` };
  }
  const config = parsed as FailoverConfig;
  if (!config || !Array.isArray(config.sets) || config.sets.length === 0) {
    return { section: "", path, mtimeMs, disabled: "config has no model sets" };
  }
  let section: string;
  try {
    section = renderRoster(config);
  } catch (error) {
    return { section: "", path, mtimeMs, disabled: `invalid config: ${describeError(error)}` };
  }
  if (!section) {
    return { section: "", path, mtimeMs, disabled: "no models to list" };
  }
  return { section, path, mtimeMs, disabled: null };
}

let cache: RosterState | null = null;

/**
 * Resolve, read, and render the roster, caching the rendered section and only
 * re-reading when the file's mtime changes (or the path changes). Never throws;
 * a broken config yields an empty section with a `disabled` reason.
 */
export function loadRoster(): RosterState {
  const path = configPath();
  const mtimeMs = mtimeOf(path);
  if (cache && cache.path === path && cache.mtimeMs === mtimeMs) {
    return cache;
  }
  cache = buildRoster(path, mtimeMs);
  return cache;
}

function rosterReport(state: RosterState): string {
  const meta = `config: ${state.path}\nmtime: ${state.mtimeMs ?? "missing"}`;
  return state.section ? `${state.section}\n${meta}` : `roster disabled: ${state.disabled}\n${meta}`;
}

// Load once at extension load time so a broken config warns immediately, exactly once.
const initialState = loadRoster();
if (initialState.disabled) {
  console.warn(`[pi-roster] roster disabled: ${initialState.disabled}`);
}
if (process.env.ROSTER_DEBUG) {
  console.log(`[pi-roster]\n${rosterReport(initialState)}`);
}

export default function piRoster(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const state = loadRoster();
    if (state.section) {
      event.systemPromptOptions.sections.model_roster = state.section;
    } else {
      delete event.systemPromptOptions.sections.model_roster;
    }
  });

  pi.registerCommand("roster", {
    description: "Show the model roster rendered from failover.json",
    handler: async (_args, ctx) => {
      ctx.ui.notify(rosterReport(loadRoster()), "info");
    },
  });
}
