/**
 * pi-orchestrator: inject the failover.json model catalog and, when the user has no
 * context file, a condensed default workflow into the system prompt.
 *
 * AGENTS.md names capability classes (opus, sonnet, flash, coding) rather
 * than models; the roster section lists which models each class contains.
 * The shipped workflow asset (assets/workflow.md) is injected only when the
 * user owns no context file in cwd, a parent directory, or the agent dir. A
 * user's own AGENTS.md (or AGENTS.override.md / CLAUDE.md variant) wins and
 * suppresses the default workflow; the roster is always injected from
 * failover.json.
 *
 * Warning: a class name is not a model string. Pass `failover/<model-name>`;
 * `failover/<class>` does not resolve to that class and falls back to the
 * configured default.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

/** Context file names pi discovers, in its own priority order. */
export const CONTEXT_FILENAMES = [
  "AGENTS.override.md",
  "AGENTS.md",
  "AGENTS.MD",
  "CLAUDE.md",
  "CLAUDE.MD",
] as const;

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/**
 * Find every context file pi would load for this working directory: the five
 * candidate names in cwd, each parent up to the filesystem root, then the agent
 * dir. Any hit means the user owns the instructions and the packaged default
 * workflow must be suppressed.
 */
export function findContextFiles(
  cwd: string,
  agentDir: string,
  exists: (p: string) => boolean,
): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const addDir = (dir: string): void => {
    const resolved = resolve(dir);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    dirs.push(resolved);
  };

  let current = resolve(cwd);
  while (true) {
    addDir(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  addDir(agentDir);

  const found: string[] = [];
  for (const dir of dirs) {
    for (const filename of CONTEXT_FILENAMES) {
      const path = join(dir, filename);
      if (exists(path)) found.push(path);
    }
  }
  return found;
}

export interface WorkflowState {
  /** The packaged workflow section, or "" when the asset could not be read. */
  section: string;
  /** The resolved asset path. */
  path: string;
  /** File mtime in ms, or null when the asset is missing. */
  mtimeMs: number | null;
  /** Why the workflow is disabled, or null when a section was loaded. */
  disabled: string | null;
}

function workflowAssetPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "workflow.md");
}

function buildWorkflow(path: string, mtimeMs: number | null): WorkflowState {
  if (mtimeMs === null) {
    return { section: "", path, mtimeMs: null, disabled: "workflow asset missing" };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { section: "", path, mtimeMs, disabled: `unreadable: ${describeError(error)}` };
  }
  if (raw.trim() === "") {
    return { section: "", path, mtimeMs, disabled: "workflow asset empty" };
  }
  return { section: raw, path, mtimeMs, disabled: null };
}

let workflowCache: WorkflowState | null = null;

/**
 * Read the packaged workflow asset, caching it and only re-reading when the
 * asset's mtime changes. Never throws; a missing or unreadable asset yields an
 * empty section with a `disabled` reason.
 */
export function loadWorkflow(): WorkflowState {
  const path = workflowAssetPath();
  const mtimeMs = mtimeOf(path);
  if (workflowCache && workflowCache.path === path && workflowCache.mtimeMs === mtimeMs) {
    return workflowCache;
  }
  workflowCache = buildWorkflow(path, mtimeMs);
  return workflowCache;
}

export interface DefaultSections {
  /** The workflow text to inject, or null when it must be omitted. */
  workflow: string | null;
  /** The roster text to inject, or null when it must be omitted. */
  roster: string | null;
}

/**
 * Decide which sections to inject. Pure, no fs: the workflow is omitted when
 * the user owns a context file; the roster is omitted only when disabled.
 */
export function renderDefaultSections(
  workflowText: string,
  rosterState: RosterState,
  hasUserContext: boolean,
): DefaultSections {
  return {
    workflow: hasUserContext ? null : workflowText || null,
    roster: rosterState.section || null,
  };
}

function workflowReport(): string {
  const workflow = loadWorkflow();
  const roster = loadRoster();
  const contextFiles = findContextFiles(process.cwd(), agentDir(), existsSync);

  const lines: string[] = [];
  if (contextFiles.length > 0) {
    lines.push("workflow source: user context files");
    for (const path of contextFiles) lines.push(`- ${path}`);
  } else if (workflow.section) {
    lines.push("workflow source: packaged default");
    lines.push(`asset: ${workflow.path}`);
    lines.push(`mtime: ${workflow.mtimeMs ?? "missing"}`);
  } else {
    lines.push(`workflow disabled: ${workflow.disabled}`);
    lines.push(`asset: ${workflow.path}`);
  }
  lines.push("");
  lines.push(rosterReport(roster));
  return lines.join("\n");
}

// Load once at extension load time so a broken config or missing asset warns
// immediately, exactly once.
const initialState = loadRoster();
if (initialState.disabled) {
  console.warn(`[pi-orchestrator] roster disabled: ${initialState.disabled}`);
}
const initialWorkflow = loadWorkflow();
if (initialWorkflow.disabled) {
  console.warn(`[pi-orchestrator] workflow disabled: ${initialWorkflow.disabled}`);
}
if (process.env.ROSTER_DEBUG) {
  console.log(`[pi-orchestrator]\n${rosterReport(initialState)}`);
}
if (process.env.ORCHESTRATOR_DEBUG) {
  console.log(`[pi-orchestrator]\n${workflowReport()}`);
}

export default function piRoster(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event) => {
    const rosterState = loadRoster();
    const workflowState = loadWorkflow();
    const hasUserContext = findContextFiles(process.cwd(), agentDir(), existsSync).length > 0;
    const sections = renderDefaultSections(workflowState.section, rosterState, hasUserContext);

    if (sections.workflow) {
      event.systemPromptOptions.sections.orchestrator_workflow = sections.workflow;
    } else {
      delete event.systemPromptOptions.sections.orchestrator_workflow;
    }
    if (sections.roster) {
      event.systemPromptOptions.sections.model_roster = sections.roster;
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

  pi.registerCommand("workflow", {
    description: "Show which workflow source won and the model roster",
    handler: async (_args, ctx) => {
      ctx.ui.notify(workflowReport(), "info");
    },
  });
}
