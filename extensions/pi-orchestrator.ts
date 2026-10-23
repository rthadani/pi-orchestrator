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
 *    gate blocks a *project code write* - `edit`/`write` of a source file, a
 *    `git commit`, a dependency install, a formatter's write mode - until a
 *    `subagent` spawn has happened in that session. Without it, the model
 *    edits the code itself and your own workflow clause licenses skipping
 *    scout and oracle. Everything else (reads, greps, LSP, builds, test runs,
 *    `pi install`, config edits under the agent dir) passes straight through:
 *    the gate exists to force delegation for code changes, not to tax
 *    inspection. Classification fails open, so an unrecognised tool is allowed
 *    rather than charged a delegation round trip.
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
import { dirname, extname, isAbsolute, join, resolve, sep } from "node:path";
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

// ---------------------------------------------------------------------------
// Code-write classification
//
// The gate exists for one case: a change to project code should go through
// scout/oracle/worker first. Inspection, tooling, builds, test runs, package
// installs and user-level config all go direct. Every classifier here fails
// OPEN: a path or command that cannot be classified is allowed, because a
// wrong block costs a full delegation round trip that the work never needed.
// ---------------------------------------------------------------------------

const SOURCE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".cc",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".swift",
  ".scala",
  ".ex",
  ".exs",
  ".sh",
  ".sql",
  ".vue",
  ".svelte",
  ".astro",
]);

/** Docs, data and config: editing these is never a code change, wherever they live. */
const DOC_EXTENSIONS: ReadonlySet<string> = new Set([
  ".md",
  ".mdx",
  ".rst",
  ".adoc",
  ".txt",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".lock",
  ".xml",
  ".html",
  ".css",
  ".scss",
  ".svg",
  ".csv",
  ".log",
]);

const SOURCE_DIRECTORIES: ReadonlySet<string> = new Set(["src", "app", "lib", "packages", "extensions"]);

/**
 * True when a path names project source: a code extension, or a file under a
 * source directory. A docs extension wins over the directory rule, so
 * `src/README.md` and `packages/x/package.json` stay direct edits.
 */
export function isSourcePath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").trim();
  if (normalized === "") return false;
  const lower = normalized.toLowerCase();
  const extension = extname(lower);
  if (DOC_EXTENSIONS.has(extension)) return false;
  if (SOURCE_EXTENSIONS.has(extension)) return true;
  // Directories only: a *file* named `src` does not make its neighbours source.
  const segments = lower.split("/").filter(Boolean);
  return segments.slice(0, -1).some((segment) => SOURCE_DIRECTORIES.has(segment));
}

/** pi's own config tree: tooling and settings, never the project's code. */
export function isAgentConfigPath(path: string): boolean {
  const raw = path.trim();
  const expanded = raw === "~" || raw.startsWith("~/") ? join(homedir(), raw.slice(1)) : raw;
  // A relative path cannot be positively identified as agent config: resolving
  // it against the process cwd would exempt whatever the cwd happens to be.
  if (!isAbsolute(expanded)) return false;
  const target = resolve(expanded);
  const configDir = resolve(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
  return target === configDir || target.startsWith(configDir + sep);
}

/** Shell-ish tools whose input carries a command whose text we can classify. */
const SHELL_COMMAND_FIELDS: Readonly<Record<string, readonly string[]>> = {
  bash: ["command", "cmd"],
  powershell: ["command"],
  ctx_execute: ["code"],
};

/** The command string for a shell tool, or null when there is nothing to read. */
function shellCommandOf(toolName: string, input: unknown): string | null {
  const fields = SHELL_COMMAND_FIELDS[toolName];
  if (!fields || typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  if (toolName === "ctx_execute") {
    // Other languages are program text, not commands; nothing to classify.
    const language = typeof record.language === "string" ? record.language.toLowerCase() : "";
    if (language !== "shell" && language !== "bash") return null;
  }
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/** Write-ish tokens. A command carrying one is not read-only. */
const WRITE_TOKENS: readonly RegExp[] = [
  />/, // any redirect, including `>>` and `2>`, can write a file
  /<</, // a heredoc feeds a command we cannot inspect
  /\btee\b/,
  /\bsed\s+-i/,
  /--output\b/,
  /(^|\s)-o\s/, // `-o file` (curl, tsc, sort, ...): output to a file
  /\bsudo\b/,
  /\bxargs\b/,
  /\b(rm|rmdir|mv|cp|mkdir|touch|chmod|chown|chgrp|ln|truncate|dd|mkfs|shred|kill|pkill|systemctl)\b/,
  /\bgit\s+(add|am|apply|checkout|cherry-pick|clean|clone|commit|fetch|init|merge|mv|pull|push|rebase|reset|restore|rm|stash|switch|tag)\b/,
  /\bgit\s+config\s+(?!.*--get)/,
  /\b(npm|yarn|pnpm)\s+(ci|i|install|add|link|pack|prune|publish|rm|run|uninstall|update)\b/,
  /\bpi\s+(install|uninstall|update|remove|add)\b/,
];

function hasWriteToken(text: string): boolean {
  return WRITE_TOKENS.some((pattern) => pattern.test(text));
}

/** Read-only binaries: no subcommand allowlist means the whole invocation is safe. */
const READ_ONLY_BINARIES: ReadonlySet<string> = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "grep",
  "rg",
  "fd",
  "find",
  "file",
  "stat",
  "pwd",
  "echo",
  "printf",
  "which",
  "type",
  "env",
  "whoami",
  "date",
  "jq",
  "diff",
  "cmp",
  "tree",
  "du",
  "df",
  "sort",
  "uniq",
  "cut",
  "awk",
  "sed",
  "xxd",
  "base64",
  "git",
  "npm",
  "node",
  "python3",
  "tsc",
  "pi",
  "gh",
  "curl",
  "wget",
]);

/** Read-only subcommands, per binary that has both safe and unsafe ones. */
const READ_ONLY_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  git: [
    "status",
    "log",
    "diff",
    "show",
    "branch",
    "remote",
    "rev-parse",
    "describe",
    "blame",
    "config --get",
    "ls-files",
    "grep",
  ],
  npm: ["view", "ls", "list", "info", "outdated", "audit", "why", "explain", "config get", "pkg get"],
  gh: ["view", "list", "status", "diff", "api"],
  pi: ["list", "--version", "--help", "status"],
};

/** A non-GET request method, or a body/file flag, makes an HTTP call a write. */
const NON_GET_METHOD = /(^|\s)(-X|--request|--method)\s+(POST|PUT|PATCH|DELETE)\b/i;
const CURL_WRITE_FLAGS = /(^|\s)(-d|--data|--data-raw|--data-binary|--data-urlencode|-F|--form|--form-string|-T|--upload-file)\b/;
const WGET_WRITE_FLAGS = /(^|\s)(--post-data|--post-file|-O|--output-document|--method=)\b/;
const GH_API_WRITE_FLAGS = /(^|\s)(-f|--field|-F|--raw-field|--input)\b/;

/** Classify one segment (no pipes or separators) as read-only. */
function isReadOnlySegment(segment: string): boolean {
  const words = segment.split(/\s+/);
  // Skip a leading `VAR=value` prefix, so `FOO=1 ls` classifies as `ls`.
  let index = 0;
  while (index < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index])) index += 1;
  const binary = words[index];
  // A path form (`./tool`, `/usr/bin/ls`) is unclassifiable by name: block.
  if (binary === undefined || !READ_ONLY_BINARIES.has(binary)) return false;

  const rest = words.slice(index + 1).join(" ");
  const allowed = READ_ONLY_SUBCOMMANDS[binary];
  if (allowed && !allowed.some((entry) => rest === entry || rest.startsWith(`${entry} `))) return false;

  if (binary === "curl" && (NON_GET_METHOD.test(rest) || CURL_WRITE_FLAGS.test(rest))) return false;
  if (binary === "wget" && (NON_GET_METHOD.test(rest) || WGET_WRITE_FLAGS.test(rest))) return false;
  if (binary === "gh" && /^api\b/.test(rest) && (NON_GET_METHOD.test(rest) || GH_API_WRITE_FLAGS.test(rest))) {
    return false;
  }
  return true;
}

/**
 * True when a shell command only inspects: every segment of a compound command
 * classifies read-only and no write token appears anywhere.
 *
 * Used as a positive allow signal, so a deny pattern can never catch an
 * inspection (`grep migrate src` stays direct). Being conservative here only
 * costs accuracy, not safety: a `false` merely falls through to the deny list.
 */
export function isReadOnlyCommand(command: string): boolean {
  const text = command.trim();
  if (text === "" || hasWriteToken(text)) return false;
  const segments = text.split(/(?:\|\||&&|[;&|\n])/);
  let seen = 0;
  for (const segment of segments) {
    const trimmed = segment.trim();
    if (trimmed === "") continue;
    seen += 1;
    if (!isReadOnlySegment(trimmed)) return false;
  }
  return seen > 0;
}

/** Files written by `>`/`>>`/`tee`, which a code write could hide behind. */
function redirectTargets(command: string): string[] {
  const targets: string[] = [];
  for (const match of command.matchAll(/(?:>>?|\btee)\s+([^\s;|&]+)/g)) targets.push(match[1]);
  return targets;
}

interface BashRule {
  pattern: RegExp;
  why: string;
  /** A global install (`-g`, `--global`) is tooling, not a project dependency. */
  globalExempt?: boolean;
}

/** Positively identified code writes in a shell command. */
const BASH_CODE_WRITE_RULES: readonly BashRule[] = [
  {
    pattern: /\bgit\s+(commit|push|reset|checkout|rebase|merge|cherry-pick|revert|clean)\b/,
    why: "it changes tracked repository state",
  },
  { pattern: /\bgit\s+stash\s+(drop|clear)\b/, why: "it drops stashed work" },
  { pattern: /\bgit\s+tag\s+(-d|--delete)\b/, why: "it deletes a tag" },
  {
    pattern: /\b(npm|yarn|pnpm)\s+(i|install|add|ci)\b/,
    why: "it installs project dependencies",
    globalExempt: true,
  },
  { pattern: /\b(pip|pip3)\s+install\b/, why: "it installs project dependencies", globalExempt: true },
  { pattern: /\bcargo\s+add\b/, why: "it adds a dependency" },
  { pattern: /\bgo\s+get\b/, why: "it adds a dependency" },
  { pattern: /\b(migrate|migration|db:migrate)\b/, why: "it runs a database migration" },
  { pattern: /\bprettier\b[^;|]*--write\b/, why: "it reformats files in place" },
  { pattern: /\beslint\b[^;|]*--fix\b/, why: "it rewrites files in place" },
  { pattern: /\bgofmt\s+-w\b/, why: "it reformats files in place" },
  { pattern: /\brustfmt\b(?![^;|]*--check)/, why: "it reformats files in place" },
  { pattern: /\bcargo\s+fmt\b(?![^;|]*--check)/, why: "it reformats files in place" },
  {
    pattern: /\b(rm|rmdir|shred|truncate|dd|mkfs(?:\.\w+)?)\b/,
    why: "it deletes or overwrites files irreversibly",
  },
];

const GLOBAL_FLAG = /(^|\s)(-g|--global)\b/;

/** Why a shell command is a code write, or null when it is not one we can name. */
function matchBashCodeWrite(command: string): string | null {
  const global = GLOBAL_FLAG.test(command);
  for (const rule of BASH_CODE_WRITE_RULES) {
    if (rule.globalExempt && global) continue;
    if (rule.pattern.test(command)) return rule.why;
  }
  return null;
}

/** The file path a writing tool targets, or null when its input names none. */
const WRITE_PATH_FIELDS = ["path", "file_path", "filePath"];

function targetPathOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const record = input as Record<string, unknown>;
  for (const field of WRITE_PATH_FIELDS) {
    const value = record[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/**
 * Tools that write a file named by their input. `edit`/`write` are pi's own;
 * the rest are the common spellings other tool sets use for the same thing.
 */
const PATH_WRITE_TOOL = /^(edit|write|patch|multi_edit|apply_patch|notebook_edit)$/;

/** A positively identified code write, with the evidence for the block reason. */
export interface CodeWrite {
  why: string;
}

/**
 * Classify a call as a project code write, or null to let it run.
 *
 * Null is the default on purpose: unknown tool, unreadable input, a command we
 * cannot parse, and any inspection all mean "no delegation needed".
 */
export function classifyCodeWrite(toolName: string, input: unknown): CodeWrite | null {
  if (PATH_WRITE_TOOL.test(toolName)) {
    const path = targetPathOf(input);
    if (path === null) return null;
    // pi's own config is tooling, never the project's code.
    if (isAgentConfigPath(path)) return null;
    if (!isSourcePath(path)) return null;
    return { why: `${path} is source code` };
  }

  const command = shellCommandOf(toolName, input);
  if (command === null) return null;
  // An inspection is never a code write, whatever the deny rules say.
  if (isReadOnlyCommand(command)) return null;

  for (const target of redirectTargets(command)) {
    if (isSourcePath(target) && !isAgentConfigPath(target)) {
      return { why: `it writes ${target}, which is source code` };
    }
  }

  const why = matchBashCodeWrite(command);
  return why === null ? null : { why };
}

export interface GateInput {
  toolName: string;
  /** Raw tool input; read only to classify a write. */
  input?: unknown;
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
  // Children run as pi sessions in this process; gating them would deadlock scout.
  if (!input.topLevel || input.spawnInFlight) return { block: false };
  if (input.delegated) return { block: false };

  // Everything not positively identified as a code write passes: an unknown
  // tool must never cost a scout/oracle/worker round trip.
  const write = classifyCodeWrite(input.toolName, input.input);
  if (write === null) return { block: false };

  return {
    block: true,
    reason: [
      `Blocked: ${input.toolName} would change project code (${write.why}).`,
      "The active workflow requires delegation before a code change:",
      'recon with subagent({ agent: "scout", task: "..." }), design with',
      'subagent({ agent: "oracle", task: "..." }), then implement with',
      'subagent({ agent: "worker", task: "..." }). Start with scout or oracle.',
      "Reads, builds, test runs, package installs and config edits never need this.",
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
  /** Ids of calls classified as code writes; their completion re-arms the gate. */
  private readonly codeWriteCalls = new Set<string>();
  private spawnsInFlight = 0;

  /** A user-started run defines a top-level session and re-arms its gate. */
  beginUserRun(session: string): void {
    this.topLevelSessions.add(session);
    this.delegatedSessions.delete(session);
    // Any spawn still counted here belongs to an earlier turn that never
    // reported completion; a user turn is a safe point to drop the count.
    this.spawnsInFlight = 0;
    this.codeWriteCalls.clear();
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

  /** A code write ran, so the next one must re-delegate. */
  mutationCompleted(session: string): void {
    this.delegatedSessions.delete(session);
  }

  /** Remember a call that will need re-arming once it finishes. */
  markCodeWrite(callId: string): void {
    if (callId !== "") this.codeWriteCalls.add(callId);
  }

  /** True when this finished call was classified as a code write. */
  consumeCodeWrite(callId: string): boolean {
    return this.codeWriteCalls.delete(callId);
  }

  /** Current decision for a tool call in a session. */
  decide(
    session: string,
    toolName: string,
    enforce: boolean,
    input?: unknown,
  ): GateDecision {
    return decideToolGate({
      toolName,
      input,
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
    if (this.delegatedSessions.has(session)) return "enforcement: delegation seen, code writes open";
    return "enforcement: armed, code writes blocked until a spawn";
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

  // Enforce: until a spawn happens, code writes are blocked for a top-level
  // session. `tool_call` can block; a handler failure also blocks (fail-closed).
  pi.on("tool_call", (event, ctx) => {
    const session = sessionKey(ctx);
    const toolName = (event as { toolName?: string }).toolName ?? "";

    if (toolName === "subagent") {
      // Only a real spawn opens the gate. Management calls (`action: "status"`,
      // "steer", "pending", "interrupt") are not delegation and must not
      // unlock code writes.
      const action = (event as { input?: { action?: unknown } }).input?.action;
      if (action === undefined) gate.spawnStarted(session);
      return;
    }

    // No subagent tool in this process means the gate is unsatisfiable here.
    if (!delegationAvailable(pi)) return;

    const input = (event as { input?: unknown }).input;
    const decision = gate.decide(session, toolName, enforcementEnabled(), input);
    if (decision.block) {
      return { block: true, reason: decision.reason ?? "blocked by pi-orchestrator" };
    }

    // `tool_execution_end` carries no input, so remember here that this call
    // was a code write; only such a call re-arms the gate when it completes.
    if (classifyCodeWrite(toolName, input) !== null) {
      const callId = (event as { toolCallId?: string }).toolCallId ?? "";
      gate.markCodeWrite(callId);
    }
  });

  // Pair the spawn counter so a failed or aborted spawn cannot leave the gate
  // permanently open, and re-arm after a top-level code write.
  pi.on("tool_execution_end", (event, ctx) => {
    const toolName = (event as { toolName?: string }).toolName ?? "";
    const session = sessionKey(ctx);
    if (toolName === "subagent") {
      gate.spawnEnded();
      return;
    }
    const callId = (event as { toolCallId?: string }).toolCallId ?? "";
    const wasCodeWrite = gate.consumeCodeWrite(callId);
    if (wasCodeWrite && gate.isTopLevel(session)) {
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
