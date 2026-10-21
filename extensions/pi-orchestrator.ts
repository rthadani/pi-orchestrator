/**
 * pi-orchestrator: inject the failover.json model catalog and, when the user has
 * no ORCHESTRATOR.md, the full default workflow into the system prompt.
 *
 * The workflow file names capability classes (opus, sonnet, flash, coding)
 * rather than models; the roster section lists which models each class contains.
 * A user's own ORCHESTRATOR.md (found in cwd, any parent directory, or the
 * agent dir, nearest first) replaces the packaged default outright; the two are
 * never injected together. pi loads its own context files separately, so those
 * do not suppress this workflow. The roster is always injected from failover.json.
 * The workflow asset is always injected in full, never filtered by which tools
 * are installed; /workflow doctor reports the extensions it expects.
 *
 * Warning: a class name is not a model string. Pass `failover/<model-name>`;
 * `failover/<class>` does not resolve to that class and falls back to the
 * configured default.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

function agentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

/** Directories searched for ORCHESTRATOR.md: cwd up to the root, then the agent dir. */
function candidateDirs(cwd: string, agentDir: string): string[] {
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
  return dirs;
}

/**
 * Find the nearest ORCHESTRATOR.md: cwd, then each parent up to the filesystem
 * root, then the agent dir as the global fallback. Pure: takes an `exists`
 * predicate so the search order is testable without touching the filesystem.
 */
export function findOrchestratorFile(
  cwd: string,
  agentDir: string,
  exists: (p: string) => boolean,
): string | undefined {
  for (const dir of candidateDirs(cwd, agentDir)) {
    const path = join(dir, "ORCHESTRATOR.md");
    if (exists(path)) return path;
  }
  return undefined;
}

export interface WorkflowState {
  /** The workflow section to inject, or "" when no workflow was loaded. */
  section: string;
  /** The resolved file path (user file or packaged asset). */
  path: string;
  /** File mtime in ms, or null when the file is missing. */
  mtimeMs: number | null;
  /** Why the workflow is disabled, or null when a section was loaded. */
  disabled: string | null;
  /** Which source won: the user's ORCHESTRATOR.md or the packaged default. */
  source: "user" | "default";
}

function workflowAssetPath(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "assets", "ORCHESTRATOR.example.md");
}

function buildWorkflow(path: string, source: "user" | "default"): WorkflowState {
  const mtimeMs = mtimeOf(path);
  if (mtimeMs === null) {
    return {
      section: "",
      path,
      mtimeMs: null,
      disabled: source === "default" ? "workflow asset missing" : "workflow file missing",
      source,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return { section: "", path, mtimeMs, disabled: `unreadable: ${describeError(error)}`, source };
  }
  if (raw.trim() === "") {
    return { section: "", path, mtimeMs, disabled: "workflow file empty", source };
  }
  return { section: raw, path, mtimeMs, disabled: null, source };
}

let workflowCache: WorkflowState | null = null;

/**
 * Resolve the winning workflow: the user's ORCHESTRATOR.md when one exists,
 * otherwise the packaged default. Cached by resolved path + mtime, so user and
 * default files are only re-read when they change. Never throws; a missing or
 * unreadable file yields an empty section with a `disabled` reason.
 */
export function loadWorkflow(cwd?: string, agentDirPath?: string): WorkflowState {
  const resolvedCwd = cwd ?? process.cwd();
  const resolvedAgentDir = agentDirPath ?? agentDir();
  const userPath = findOrchestratorFile(resolvedCwd, resolvedAgentDir, existsSync);
  const path = userPath ?? workflowAssetPath();
  const source: "user" | "default" = userPath ? "user" : "default";
  if (workflowCache && workflowCache.path === path && workflowCache.mtimeMs === mtimeOf(path)) {
    return workflowCache;
  }
  workflowCache = buildWorkflow(path, source);
  return workflowCache;
}

export interface DefaultSections {
  /** The workflow text to inject, or null when it must be omitted. */
  workflow: string | null;
  /** The roster text to inject, or null when it must be omitted. */
  roster: string | null;
}

/**
 * Decide which sections to inject. Pure, no fs: the workflow text (user file or
 * packaged default, already resolved by loadWorkflow) is injected when
 * non-empty; the roster is omitted only when disabled.
 */
export function renderDefaultSections(
  workflowText: string,
  rosterState: RosterState,
): DefaultSections {
  return {
    workflow: workflowText || null,
    roster: rosterState.section || null,
  };
}

function workflowReport(): string {
  const workflow = loadWorkflow();
  const roster = loadRoster();

  const lines: string[] = [];
  if (workflow.source === "user") {
    lines.push("workflow source: user file");
    lines.push(`path: ${workflow.path}`);
    if (workflow.disabled) lines.push(`note: ${workflow.disabled}`);
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

interface CapabilityDef {
  capability: string;
  tools: string[];
  install: string;
  required: boolean;
}

/** Extensions the workflow relies on; the first three are required, ask_user is optional. */
const CAPABILITY_DEFS: CapabilityDef[] = [
  { capability: "pi-subagents", tools: ["subagent"], install: "pi install npm:pi-subagents", required: true },
  { capability: "pi-boomerang", tools: ["boomerang"], install: "pi install npm:pi-boomerang", required: true },
  {
    capability: "context-mode",
    tools: ["ctx_execute", "ctx_batch_execute", "ctx_search"],
    install: "pi install npm:context-mode",
    required: true,
  },
  { capability: "ask_user", tools: ["ask_user"], install: "pi install npm:pi-ask-user", required: false },
];

/** Extension names whose required tools are present, per the pi tool list. */
export function detectCapabilities(hasTool: (name: string) => boolean): Set<string> {
  const present = new Set<string>();
  for (const def of CAPABILITY_DEFS) {
    if (def.tools.some((name) => hasTool(name))) present.add(def.capability);
  }
  return present;
}

let warnedToolDetection = false;

/** Best-effort tool names from pi; null when getAllTools is absent or throws. */
function collectToolNames(pi: ExtensionAPI): ReadonlySet<string> | null {
  try {
    const getAll = (pi as unknown as { getAllTools?: () => unknown }).getAllTools;
    if (typeof getAll !== "function") return null;
    const tools = getAll();
    if (!Array.isArray(tools)) return null;
    const names = new Set<string>();
    for (const tool of tools) {
      const name = tool && typeof tool === "object" ? (tool as { name?: unknown }).name : undefined;
      if (typeof name === "string") names.add(name);
    }
    return names;
  } catch {
    return null;
  }
}

/** Tool names plus a single load-time warning when detection is impossible. */
function detectTools(pi: ExtensionAPI): ReadonlySet<string> | null {
  const names = collectToolNames(pi);
  if (names === null && !warnedToolDetection) {
    warnedToolDetection = true;
    console.warn(
      "[pi-orchestrator] tool detection unavailable; /workflow doctor cannot audit extensions",
    );
  }
  return names;
}

export interface DoctorState {
  /** Extension names detected as present, from detectCapabilities. */
  available: ReadonlySet<string>;
  workflowSource: "user" | "default";
  workflowPath: string;
  failoverFound: boolean;
  failoverPath: string;
}

/** Render the /workflow doctor report; pure so it can be exercised offline. */
export function renderDoctorReport(state: DoctorState): string {
  const lines: string[] = ["workflow extensions"];
  const required = CAPABILITY_DEFS.filter((def) => def.required);
  const optional = CAPABILITY_DEFS.filter((def) => !def.required);
  const missingRequired = required.filter((def) => !state.available.has(def.capability));

  if (missingRequired.length > 0) {
    lines.push(
      `MISSING REQUIRED: ${missingRequired
        .map((def) => def.capability)
        .join(", ")} — the workflow expects ${required.map((def) => def.capability).join(", ")}`,
    );
  } else {
    lines.push("required extensions: all present");
  }

  for (const def of required) {
    if (state.available.has(def.capability)) {
      lines.push(`- ${def.capability}: present`);
    } else {
      lines.push(`- ${def.capability}: missing — required; run \`${def.install}\``);
    }
  }
  for (const def of optional) {
    if (state.available.has(def.capability)) {
      lines.push(`- ${def.capability}: present`);
    } else {
      lines.push(
        `- ${def.capability}: optional — degrades gracefully (the one-question-at-a-time rule works without the tool)`,
      );
    }
  }

  lines.push("");
  if (state.workflowSource === "user") {
    lines.push(
      `workflow override: user ORCHESTRATOR.md (${state.workflowPath}); injected verbatim, never filtered`,
    );
  } else {
    lines.push("workflow override: none (packaged default, injected in full)");
  }
  lines.push("");
  if (state.failoverFound) {
    lines.push(`failover config: found (${state.failoverPath})`);
  } else {
    lines.push(
      `failover config: not found — install a model provider with \`pi install git:github.com/rthadani/pi-failover\``,
    );
  }
  return lines.join("\n");
}

export default function piRoster(pi: ExtensionAPI): void {
  // Probe once at load so a pi without getAllTools warns immediately instead of
  // silently skipping the doctor audit.
  detectTools(pi);

  pi.on("before_agent_start", (event) => {
    const rosterState = loadRoster();
    const workflowState = loadWorkflow();
    // The workflow (user file or packaged default) is always injected in full,
    // never filtered by which tools are installed.
    const sections = renderDefaultSections(workflowState.section, rosterState);

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
    description: "Show workflow source and roster; `init` copies the template; `doctor` audits required extensions",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens[0] === "doctor") {
        const tools = detectTools(pi);
        if (tools === null) {
          ctx.ui.notify("tool detection unavailable; cannot audit workflow extensions", "error");
          return;
        }
        const available = detectCapabilities((name) => tools.has(name));
        const workflow = loadWorkflow();
        const roster = loadRoster();
        ctx.ui.notify(
          renderDoctorReport({
            available,
            workflowSource: workflow.source,
            workflowPath: workflow.path,
            failoverFound: roster.disabled !== "config file missing",
            failoverPath: roster.path,
          }),
          "info",
        );
        return;
      }
      if (tokens[0] === "init") {
        const target = tokens[1]
          ? resolve(ctx.cwd, tokens.slice(1).join(" "))
          : resolve(ctx.cwd, "ORCHESTRATOR.md");
        if (existsSync(target)) {
          ctx.ui.notify(
            `refusing to overwrite existing file: ${target}\nEdit it directly, or run /workflow init with another path.`,
            "error",
          );
          return;
        }
        try {
          writeFileSync(target, readFileSync(workflowAssetPath(), "utf8"), { flag: "wx" });
          ctx.ui.notify(
            `wrote ${target}\nNext: edit it to suit your workflow, then restart or reload pi.`,
            "info",
          );
        } catch (error) {
          ctx.ui.notify(`failed to write ${target}: ${describeError(error)}`, "error");
        }
        return;
      }
      ctx.ui.notify(workflowReport(), "info");
    },
  });
}
