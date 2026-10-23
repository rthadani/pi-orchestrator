/**
 * pi-orchestrator: make the workflow authoritative, not advisory.
 *
 * Two mechanisms, both required:
 *
 * 1. Injection. The winning workflow is added to `systemPromptOptions.contextFiles`,
 *    which pi renders inside `<project_context>` as
 *    `<project_instructions path="...">` - the same slot and framing as an
 *    AGENTS.md. A custom prompt section always renders after `<cwd>`, i.e. last,
 *    which is the weakest position in the prompt; the project-instructions slot
 *    is early and carries repo-configuration authority. The legacy
 *    `orchestrator_workflow` section is deleted on sight so a prompt never
 *    carries the workflow twice.
 *
 * 2. Enforcement. `tool_call` can block a call (`return { block: true }`). The
 *    gate blocks every file-reading or file-mutating tool until a `subagent`
 *    spawn has happened in that session. Without it, the model reads the repo
 *    itself, decides the files are "already known", and your own step-1 clause
 *    licenses skipping scout and oracle.
 *
 * State is keyed by session id, never by module-level "current task", so two
 * sessions in one process cannot borrow each other's delegation. Enforcement
 * only happens in a session that can actually delegate: children are exempt
 * (they start from a custom message), and a process without the `subagent`
 * tool is exempt too, so a review child can never be wedged between a gate it
 * cannot satisfy and a read it is not allowed to make.
 *
 * The workflow file names capability classes (opus, sonnet, flash, coding)
 * rather than models; pi-failover owns and injects the model roster section.
 * A user's own ORCHESTRATOR.md (cwd, any parent, or the agent dir, nearest
 * first) replaces the packaged default outright. The packaged workflow is
 * injected only when all four required companion extensions are installed; a
 * missing one withholds it, and a withheld workflow is never enforced.
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

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
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
function candidateDirs(cwd: string, agentDirPath: string): string[] {
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
  addDir(agentDirPath);
  return dirs;
}

/**
 * Find the nearest ORCHESTRATOR.md: cwd, then each parent up to the filesystem
 * root, then the agent dir as the global fallback. Pure: takes an `exists`
 * predicate so the search order is testable without touching the filesystem.
 */
export function findOrchestratorFile(
  cwd: string,
  agentDirPath: string,
  exists: (p: string) => boolean,
): string | undefined {
  for (const dir of candidateDirs(cwd, agentDirPath)) {
    const path = join(dir, "ORCHESTRATOR.md");
    if (exists(path)) return path;
  }
  return undefined;
}

export interface WorkflowState {
  /** The workflow text to inject, or "" when no workflow was loaded. */
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

/**
 * One cache slot per resolved path, not one slot for the process. Two sessions
 * with different working directories would otherwise evict each other on every
 * run, which is a correctness problem (a stale slot could serve the wrong
 * workflow for a moment) as well as a performance one.
 */
const workflowCache = new Map<string, { mtimeMs: number | null; size: number | null; state: WorkflowState }>();

function loadWorkflowFrom(path: string, source: "user" | "default"): WorkflowState {
  const mtimeMs = mtimeOf(path);
  const size = sizeOf(path);
  const cached = workflowCache.get(path);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) {
    return cached.state;
  }
  const state = buildWorkflow(path, source);
  workflowCache.set(path, { mtimeMs, size, state });
  return state;
}

/** Resolve the winning workflow: the user's ORCHESTRATOR.md, else the packaged default. */
export function loadWorkflow(cwd?: string, agentDirPath?: string): WorkflowState {
  const resolvedCwd = cwd ?? process.cwd();
  const userPath = findOrchestratorFile(resolvedCwd, agentDirPath ?? agentDir(), existsSync);
  return loadWorkflowFrom(userPath ?? workflowAssetPath(), userPath ? "user" : "default");
}

/** The section key older versions used. It is removed wherever it is found. */
const LEGACY_SECTION_KEY = "orchestrator_workflow";

interface MutablePromptOptions {
  contextFiles?: Array<{ path: string; content: string }>;
  sections?: Record<string, string>;
}

/**
 * Put the workflow where an AGENTS.md would go, and nowhere else.
 *
 * Idempotent by construction: every existing entry for the workflow path is
 * dropped first, so running this twice (or on options reused across runs)
 * cannot accumulate copies.
 */
export function applyWorkflowToPrompt(
  options: MutablePromptOptions,
  workflow: WorkflowState,
  active: boolean,
): void {
  const files = options.contextFiles ?? (options.contextFiles = []);
  for (let index = files.length - 1; index >= 0; index -= 1) {
    if (files[index].path === workflow.path) files.splice(index, 1);
  }
  if (active && workflow.section) {
    files.push({ path: workflow.path, content: workflow.section });
  }
  if (options.sections) delete options.sections[LEGACY_SECTION_KEY];
}

/**
 * Tools that can read or write repository state. Blocking reads is deliberate:
 * with reads open, the model gathers the context itself, then reasons that the
 * files are "already known" and skips the recon the workflow asks for.
 */
const GATED_TOOL = /^(read|grep|find|ls|bash|powershell|edit|write|codemode|lsp_|ctx_)/;

/** Tools that must always pass: spawning is the way out of the gate. */
const ALWAYS_ALLOWED = new Set(["subagent", "ask_user"]);

function isMutatingTool(toolName: string): boolean {
  return /^(edit|write)$/.test(toolName) || /^(bash|powershell|codemode)$/.test(toolName);
}

export interface GateInput {
  toolName: string;
  /** The workflow is injected for this session, so it can be enforced. */
  active: boolean;
  /** `WORKFLOW_ENFORCE=off` and similar. */
  enforce: boolean;
  /** This call belongs to a top-level (user-started) session. */
  topLevel: boolean;
  /** A spawn is in flight, so child sessions are calling tools right now. */
  spawnInFlight: boolean;
  /** A `subagent` spawn has already happened in this session. */
  delegated: boolean;
}

export interface GateDecision {
  block: boolean;
  reason?: string;
}

/** Pure gate decision, so the enforcement rules are testable without pi. */
export function decideToolGate(input: GateInput): GateDecision {
  if (!input.enforce || !input.active) return { block: false };
  if (ALWAYS_ALLOWED.has(input.toolName)) return { block: false };
  if (!GATED_TOOL.test(input.toolName)) return { block: false };
  // Children run as pi sessions in this process; gating them would deadlock scout.
  if (!input.topLevel || input.spawnInFlight) return { block: false };
  if (input.delegated) return { block: false };

  const what = isMutatingTool(input.toolName) ? "change files" : "inspect the repository";
  return {
    block: true,
    reason: [
      `Blocked: ${input.toolName} cannot be used to ${what} yet.`,
      "The active workflow requires delegation before direct work:",
      'recon with subagent({ agent: "scout", task: "..." }), design with',
      'subagent({ agent: "oracle", task: "..." }), then implement with',
      'subagent({ agent: "worker", task: "..." }). Start with scout or oracle.',
    ].join(" "),
  };
}

/** Enforcement is on unless explicitly disabled for the process. */
export function enforcementEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const value = (env.WORKFLOW_ENFORCE ?? "").trim().toLowerCase();
  return !(value === "off" || value === "0" || value === "false" || value === "no");
}

/**
 * Per-session gate bookkeeping. All mutation happens on the event loop, one
 * event at a time, so no locking is needed; the invariant that matters is that
 * no state is keyed by "the current task" or by module-level single slots.
 */
class WorkflowGate {
  private readonly topLevelSessions = new Set<string>();
  private readonly activeSessions = new Set<string>();
  private readonly delegatedSessions = new Set<string>();
  private spawnsInFlight = 0;

  /** A user-started run defines a top-level session and re-arms its gate. */
  beginUserRun(session: string): void {
    this.topLevelSessions.add(session);
    this.delegatedSessions.delete(session);
    // Any spawn still counted here belongs to an earlier turn that never
    // reported completion; a user turn is a safe point to drop the count.
    this.spawnsInFlight = 0;
  }

  setActive(session: string, active: boolean): void {
    if (active) this.activeSessions.add(session);
    else this.activeSessions.delete(session);
  }

  isTopLevel(session: string): boolean {
    return this.topLevelSessions.has(session);
  }

  /** A spawn started: the whole session is now allowed to work directly. */
  spawnStarted(session: string): void {
    this.delegatedSessions.add(session);
    this.spawnsInFlight += 1;
  }

  /** A spawn finished, successfully or not: never leave the count stuck. */
  spawnEnded(): void {
    this.spawnsInFlight = Math.max(0, this.spawnsInFlight - 1);
  }

  /** A top-level edit/write completed, so the next change must re-delegate. */
  mutationCompleted(session: string): void {
    this.delegatedSessions.delete(session);
  }

  /** Current decision for a tool call in a session. */
  decide(
    session: string,
    toolName: string,
    enforce: boolean,
  ): GateDecision {
    return decideToolGate({
      toolName,
      active: this.activeSessions.has(session),
      enforce,
      topLevel: this.topLevelSessions.has(session),
      spawnInFlight: this.spawnsInFlight > 0,
      delegated: this.delegatedSessions.has(session),
    });
  }

  describe(session: string): string {
    if (!this.activeSessions.has(session)) return "enforcement: inactive (no workflow injected)";
    if (!this.topLevelSessions.has(session)) return "enforcement: child session (exempt)";
    if (this.delegatedSessions.has(session)) return "enforcement: delegation seen, tools open";
    return "enforcement: armed, file tools blocked until a spawn";
  }
}

/** Best-effort session identity; never throws for a minimal ctx. */
function sessionKey(ctx: unknown): string {
  const manager = (ctx as { sessionManager?: { getSessionId?: () => string } } | undefined)?.sessionManager;
  try {
    const id = manager?.getSessionId?.();
    if (typeof id === "string" && id.length > 0) return id;
  } catch {
    // fall through
  }
  const cwd = (ctx as { cwd?: string } | undefined)?.cwd;
  return typeof cwd === "string" ? `cwd:${cwd}` : "session:default";
}

function cwdOf(ctx: unknown): string {
  const cwd = (ctx as { cwd?: string } | undefined)?.cwd;
  return typeof cwd === "string" && cwd.length > 0 ? cwd : process.cwd();
}

function workflowReport(workflow: WorkflowState): string {
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
  console.log(`[pi-orchestrator]\n${workflowReport(initialWorkflow)}`);
}

const gate = new WorkflowGate();

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

/** Best-effort tool names from pi; null when getAllTools is absent or throws. Informational only. */function collectToolNames(pi: ExtensionAPI): ReadonlySet<string> | null {
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

/**
 * Whether this process can delegate at all.
 *
 * A session without the `subagent` tool has no way to satisfy the gate, so
 * enforcing there is a deadlock, not a nudge: a review child that cannot spawn
 * and cannot read is wedged. Unknown capability (no getAllTools) also fails
 * open, because a wrong "can delegate" answer costs a stuck run while a wrong
 * "cannot delegate" answer only costs enforcement.
 */
function delegationAvailable(pi: ExtensionAPI): boolean {
  const tools = collectToolNames(pi);
  return tools !== null && tools.has("subagent");
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
  /** Gate state for the calling session, when one is known. */
  enforcement?: string;
}

/** Render the /workflow doctor report; pure so it can be exercised offline. */
export function renderDoctorReport(state: DoctorState): string {
  const lines: string[] = ["workflow extensions"];
  const required = CAPABILITY_DEFS.filter((def) => def.required);
  const optional = CAPABILITY_DEFS.filter((def) => !def.required);
  const missingRequiredDefs = required.filter((def) => !state.available.has(def.capability));

  if (missingRequiredDefs.length > 0) {
    lines.push(
      `MISSING REQUIRED: ${missingRequiredDefs
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
  lines.push(`workflow placement: <project_instructions path="${state.workflowPath}"> inside <project_context>`);
  if (state.enforcement) lines.push(state.enforcement);
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
    const session = sessionKey(ctx);
    // Only an explicit user-initiated run defines a top-level session. Children
    // start from a custom message; an unknown type fails open rather than
    // arming a gate the session may not be able to satisfy.
    const messageType = (event as { messageType?: string }).messageType;
    if (messageType === "user") {
      gate.beginUserRun(session);
    }

    const workflowState = loadWorkflow(cwdOf(ctx));

    const present = detectPresent(ctx);
    const missing = present === null ? null : missingRequired(present);
    // Fail open when detection is unavailable; a user's own file is never withheld.
    const withhold = missing !== null && missing.length > 0 && workflowState.source !== "user";

    const active = Boolean(workflowState.section) && !withhold;
    applyWorkflowToPrompt(
      event.systemPromptOptions as unknown as MutablePromptOptions,
      workflowState,
      active,
    );
    gate.setActive(session, active);

    if (missing === null) {
      warnEnforcementUnverified();
    } else if (withhold) {
      warnMissingRequired(missing);
    }
  });

  // Enforce: until a spawn happens, file tools are blocked for a top-level
  // session. `tool_call` can block; a handler failure also blocks (fail-closed).
  pi.on("tool_call", (event, ctx) => {
    const session = sessionKey(ctx);
    const toolName = (event as { toolName?: string }).toolName ?? "";

    if (toolName === "subagent") {
      // Only a real spawn opens the gate. Management calls (`action: "status"`,
      // "steer", "pending", "interrupt") are not delegation and must not
      // unlock file tools.
      const action = (event as { input?: { action?: unknown } }).input?.action;
      if (action === undefined) gate.spawnStarted(session);
      return;
    }

    // No subagent tool in this process means the gate is unsatisfiable here.
    if (!delegationAvailable(pi)) return;

    const decision = gate.decide(session, toolName, enforcementEnabled());
    if (decision.block) {
      return { block: true, reason: decision.reason ?? "blocked by pi-orchestrator" };
    }
  });

  // Pair the spawn counter so a failed or aborted spawn cannot leave the gate
  // permanently open, and re-arm after a top-level mutation.
  pi.on("tool_execution_end", (event, ctx) => {
    const toolName = (event as { toolName?: string }).toolName ?? "";
    const session = sessionKey(ctx);
    if (toolName === "subagent") {
      gate.spawnEnded();
      return;
    }
    if (gate.isTopLevel(session) && isMutatingTool(toolName)) {
      const isError = Boolean((event as { isError?: boolean }).isError);
      if (!isError) gate.mutationCompleted(session);
    }
  });

  pi.registerCommand("workflow", {
    description: "Show workflow source and enforcement state; `init` copies the template; `doctor` audits it",
    handler: async (args, ctx) => {
      const tokens = args.trim().split(/\s+/).filter(Boolean);
      const session = sessionKey(ctx);
      if (tokens[0] === "doctor") {
        const present = detectPresent(ctx);
        if (present === null) {
          ctx.ui.notify(
            "extension detection unavailable (settings.json or modelRegistry); cannot audit workflow extensions",
            "error",
          );
          return;
        }
        const workflow = loadWorkflow(cwdOf(ctx));
        const missing = missingRequired(present);
        const withheld = missing.length > 0 && workflow.source !== "user";
        ctx.ui.notify(
          renderDoctorReport({
            available: present,
            workflowSource: workflow.source,
            workflowPath: workflow.path,
            withheld,
            toolsSeen: collectToolNames(pi),
            enforcement: gate.describe(session),
          }),
          "info",
        );
        return;
      }
      if (tokens[0] === "init") {
        const target = tokens[1]
          ? resolve(cwdOf(ctx), tokens.slice(1).join(" "))
          : resolve(cwdOf(ctx), "ORCHESTRATOR.md");
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
      ctx.ui.notify(workflowReport(loadWorkflow(cwdOf(ctx))), "info");
    },
  });
}
