/**
 * pi-orchestrator: inject the workflow section into the system prompt.
 *
 * The workflow file names capability classes (opus, sonnet, flash, coding)
 * rather than models; pi-failover owns and injects the model roster section,
 * which lists which models each class contains. A user's own ORCHESTRATOR.md
 * (found in cwd, any parent directory, or the agent dir, nearest first)
 * replaces the packaged default outright; the two are never injected together.
 * pi loads its own context files separately, so those do not suppress this
 * workflow. The packaged workflow is injected only when all four required
 * companion extensions are installed; a missing one withholds it. Installation
 * is read from pi's settings packages plus the model registry's `failover`
 * provider, not from runtime tool visibility. /workflow doctor reports what is
 * installed and whether the workflow is withheld. A user's own ORCHESTRATOR.md
 * is always injected verbatim, never withheld.
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

function workflowReport(): string {
  const workflow = loadWorkflow();

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
  return lines.join("\n");
}

// Load once at extension load time so a missing asset warns immediately,
// exactly once.
const initialWorkflow = loadWorkflow();
if (initialWorkflow.disabled) {
  console.warn(`[pi-orchestrator] workflow disabled: ${initialWorkflow.disabled}`);
}
if (process.env.ORCHESTRATOR_DEBUG) {
  console.log(`[pi-orchestrator]\n${workflowReport()}`);
}

interface CapabilityDef {
  capability: string;
  /** Package name matched against pi's settings `packages` (installation gate). */
  package?: string;
  /** Provider name matched against the model registry (installation gate). */
  provider?: string;
  install: string;
  required: boolean;
}

/**
 * Extensions the workflow relies on. The four required ones gate the packaged
 * workflow; ask_user is optional and must never gate anything. Gates are about
 * installation (settings packages or the model registry), never runtime tools.
 */
const CAPABILITY_DEFS: CapabilityDef[] = [
  { capability: "pi-subagents", package: "pi-subagents", install: "pi install npm:pi-subagents", required: true },
  { capability: "pi-boomerang", package: "pi-boomerang", install: "pi install npm:pi-boomerang", required: true },
  {
    capability: "context-mode",
    package: "context-mode",
    install: "pi install npm:context-mode",
    required: true,
  },
  {
    capability: "pi-failover",
    provider: "failover",
    install: "pi install git:github.com/rthadani/pi-failover",
    required: true,
  },
  { capability: "ask_user", package: "pi-ask-user", install: "pi install npm:pi-ask-user", required: false },
];

/** Runtime tools each extension may expose; informational only, never a gate. */
const INFO_TOOLS: Readonly<Record<string, readonly string[]>> = {
  "pi-subagents": ["subagent"],
  "pi-boomerang": ["boomerang"],
  "context-mode": ["ctx_execute", "ctx_batch_execute", "ctx_search"],
  "pi-failover": [],
  ask_user: ["ask_user"],
};

/** Capabilities present per installed packages and model-registry providers. */
export function detectExtensions(
  hasPackage: (name: string) => boolean,
  hasProvider: (name: string) => boolean,
): Set<string> {
  const present = new Set<string>();
  for (const def of CAPABILITY_DEFS) {
    const byPackage = def.package !== undefined && hasPackage(def.package);
    const byProvider = def.provider !== undefined && hasProvider(def.provider);
    if (byPackage || byProvider) present.add(def.capability);
  }
  return present;
}

/** Required capabilities missing from an available set; empty when all present. */
export function missingRequired(available: ReadonlySet<string>): CapabilityDef[] {
  return CAPABILITY_DEFS.filter((def) => def.required && !available.has(def.capability));
}

/** Best-effort tool names from pi; null when getAllTools is absent or throws. Informational only. */
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

/** pi's settings.json path, honouring PI_CODING_AGENT_DIR when set. */
function settingsPath(): string {
  const agentDirPath = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
  return join(agentDirPath, "settings.json");
}

/**
 * Installed package sources from settings.json, or null when unreadable or
 * unparseable. Entries may be strings or objects with a `source` string.
 */
function readInstalledPackages(path: string): ReadonlySet<string> | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const packages = (parsed as { packages?: unknown } | null | undefined)?.packages;
  if (!Array.isArray(packages)) return null;
  const sources = new Set<string>();
  for (const entry of packages) {
    if (typeof entry === "string") sources.add(entry);
    else if (entry && typeof entry === "object") {
      const source = (entry as { source?: unknown }).source;
      if (typeof source === "string") sources.add(source);
    }
  }
  return sources;
}

/** Predicate: is a package name present in any installed source (case-insensitive)? */
function hasInstalledPackage(installed: ReadonlySet<string>): (name: string) => boolean {
  const lower = Array.from(installed, (source) => source.toLowerCase());
  return (name: string) => {
    const needle = name.toLowerCase();
    return lower.some((source) => source.includes(needle));
  };
}

/** Best-effort provider names from the model registry; null when unavailable or throws. */
function collectProviderNames(ctx: unknown): ReadonlySet<string> | null {
  try {
    const registry = (ctx as { modelRegistry?: { getProvider?: (name: string) => unknown } } | undefined)
      ?.modelRegistry;
    if (!registry || typeof registry.getProvider !== "function") return null;
    const names = new Set<string>();
    for (const def of CAPABILITY_DEFS) {
      if (def.provider && registry.getProvider(def.provider)) names.add(def.provider);
    }
    return names;
  } catch {
    return null;
  }
}

/** Present capabilities, or null when settings or the model registry cannot be probed. */
export function detectPresent(ctx: unknown): ReadonlySet<string> | null {
  const installed = readInstalledPackages(settingsPath());
  const providerNames = collectProviderNames(ctx);
  if (installed === null || providerNames === null) return null;
  return detectExtensions(hasInstalledPackage(installed), (name) => providerNames.has(name));
}

const warnedMissingKeys = new Set<string>();

/** Warn once per missing set that the packaged workflow is withheld. */
function warnMissingRequired(missing: readonly CapabilityDef[]): void {
  const key = missing
    .map((def) => def.capability)
    .sort()
    .join(",");
  if (warnedMissingKeys.has(key)) return;
  warnedMissingKeys.add(key);
  const list = missing.map((def) => `${def.capability} (run \`${def.install}\`)`).join(", ");
  console.warn(
    `[pi-orchestrator] missing required extensions: ${list}. The packaged workflow is withheld until they are installed.`,
  );
}

let warnedEnforcementUnverified = false;

/** Warn once when enforcement could not be verified; the workflow fails open. */
function warnEnforcementUnverified(): void {
  if (warnedEnforcementUnverified) return;
  warnedEnforcementUnverified = true;
  console.warn(
    "[pi-orchestrator] required-extension enforcement could not be verified (settings.json or modelRegistry unavailable); injecting the workflow anyway.",
  );
}

export interface DoctorState {
  /** Extension names detected as installed, from detectExtensions. */
  available: ReadonlySet<string>;
  workflowSource: "user" | "default";
  workflowPath: string;
  /** Whether the packaged workflow is currently withheld for missing extensions. */
  withheld: boolean;
  /** Runtime tool names seen via pi.getAllTools(); informational, never a gate. */
  toolsSeen: ReadonlySet<string> | null;
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
      `workflow override: user ORCHESTRATOR.md (${state.workflowPath}); injected verbatim, never withheld`,
    );
  } else if (state.withheld) {
    lines.push("workflow status: WITHHELD — required extensions are missing");
  } else {
    lines.push("workflow status: injecting (packaged default; all required extensions installed)");
  }
  lines.push("");
  const toolsSeen = state.toolsSeen;
  if (toolsSeen !== null) {
    lines.push("runtime tools (informational, not a gate):");
    for (const def of CAPABILITY_DEFS) {
      const tools = INFO_TOOLS[def.capability] ?? [];
      if (tools.length === 0) continue;
      const seen = tools.map((name) => `${name}=${toolsSeen.has(name) ? "seen" : "not seen"}`).join(", ");
      lines.push(`- ${def.capability}: ${seen}`);
    }
  } else {
    lines.push("runtime tools: unavailable (informational, not a gate)");
  }
  return lines.join("\n");
}

export default function piRoster(pi: ExtensionAPI): void {
  pi.on("before_agent_start", (event, ctx) => {
    const workflowState = loadWorkflow();

    const present = detectPresent(ctx);
    const missing = present === null ? null : missingRequired(present);
    // Fail open when detection is unavailable; a user's own file is never withheld.
    const withhold = missing !== null && missing.length > 0 && workflowState.source !== "user";

    const workflowSection = workflowState.section && !withhold ? workflowState.section : "";
    if (workflowSection) {
      event.systemPromptOptions.sections.orchestrator_workflow = workflowSection;
    } else {
      delete event.systemPromptOptions.sections.orchestrator_workflow;
    }

    if (missing === null) {
      warnEnforcementUnverified();
    } else if (withhold) {
      warnMissingRequired(missing);
    }
  });

  pi.registerCommand("workflow", {
    description: "Show workflow source; `init` copies the template; `doctor` audits required extensions",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      if (tokens[0] === "doctor") {
        const present = detectPresent(ctx);
        if (present === null) {
          ctx.ui.notify(
            "extension detection unavailable (settings.json or modelRegistry); cannot audit workflow extensions",
            "error",
          );
          return;
        }
        const workflow = loadWorkflow();
        const missing = missingRequired(present);
        const withheld = missing.length > 0 && workflow.source !== "user";
        ctx.ui.notify(
          renderDoctorReport({
            available: present,
            workflowSource: workflow.source,
            workflowPath: workflow.path,
            withheld,
            toolsSeen: collectToolNames(pi),
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
