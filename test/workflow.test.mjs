// pi-orchestrator workflow harness: exercises workflow resolution, installation
// gating, and before_agent_start section injection in
// extensions/pi-orchestrator.ts with offline fixtures. No framework; throws on
// failure; prints PASS lines.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let failures = 0;
function assert(cond, msg) {
  if (!cond) {
    failures++;
    throw new Error(msg);
  }
}
function pass(msg) {
  console.log(`PASS: ${msg}`);
}
function runCase(name, fn) {
  try {
    fn();
    pass(name);
  } catch (e) {
    console.error(`FAIL: ${name}: ${e.message}`);
  }
}
async function runCaseAsync(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (e) {
    console.error(`FAIL: ${name}: ${e.message}`);
  }
}

const {
  findOrchestratorFile,
  loadWorkflow,
  detectExtensions,
  missingRequired,
  renderDoctorReport,
  applyWorkflowToPrompt,
  decideToolGate,
  enforcementEnabled,
  default: piRoster,
} = await import("../extensions/pi-orchestrator.ts");

const here = dirname(fileURLToPath(import.meta.url));
const assetPath = join(here, "..", "assets", "ORCHESTRATOR.example.md");
const asset = readFileSync(assetPath, "utf8");

runCase("CASE 1: ORCHESTRATOR.md search order (cwd, parents, agent dir, nearest wins)", () => {
  const none = findOrchestratorFile("/proj/sub", "/agents", () => false);
  assert(none === undefined, `expected no orchestrator file, got ${none}`);

  const cwdHit = "/proj/sub/ORCHESTRATOR.md";
  assert(
    findOrchestratorFile("/proj/sub", "/agents", (p) => p === cwdHit) === cwdHit,
    "cwd hit should win",
  );

  const parentHit = "/proj/ORCHESTRATOR.md";
  assert(
    findOrchestratorFile("/proj/sub", "/agents", (p) => p === parentHit) === parentHit,
    "parent hit should win",
  );

  const agentHit = "/agents/ORCHESTRATOR.md";
  assert(
    findOrchestratorFile("/proj/sub", "/agents", (p) => p === agentHit) === agentHit,
    "agent dir hit should win",
  );

  const set = new Set([parentHit, agentHit]);
  assert(
    findOrchestratorFile("/proj/sub", "/agents", (p) => set.has(p)) === parentHit,
    "nearer parent should beat the agent dir",
  );
});

runCase("CASE 2: AGENTS.md alone does not suppress the default workflow (search)", () => {
  const agentsHit = "/proj/AGENTS.md";
  const found = findOrchestratorFile("/proj/sub", "/agents", (p) => p === agentsHit);
  assert(found === undefined, `AGENTS.md must not suppress; got ${found}`);
});

runCase("CASE 3: missing workflow asset yields no section and no throw", () => {
  const missingDir = mkdtempSync(join(tmpdir(), "pi-workflow-missing-"));
  const copied = join(missingDir, "pi-orchestrator.ts");
  copyFileSync(join(here, "..", "extensions", "pi-orchestrator.ts"), copied);
  const script = [
    `const mod = await import(${JSON.stringify(copied)});`,
    `const s = mod.loadWorkflow();`,
    `if (s.section !== "") throw new Error("expected empty workflow section, got " + JSON.stringify(s.section));`,
    `if (!s.disabled) throw new Error("expected a disabled reason");`,
    `console.log("MISSING-OK");`,
  ].join("\n");
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: missingDir,
    encoding: "utf8",
  });
  assert(res.status === 0, `missing-asset subprocess failed:\n${res.stderr}`);
  assert((res.stdout || "").includes("MISSING-OK"), `missing-asset subprocess did not confirm:\n${res.stdout}`);
  const warns = (res.stderr || "").split("\n").filter((l) => l.includes("[pi-orchestrator] workflow disabled"));
  assert(warns.length === 1, `expected one workflow-disabled warn, got ${warns.length}:\n${res.stderr}`);
  rmSync(missingDir, { recursive: true, force: true });
});

runCase("CASE 4: shipped workflow asset names no models or providers", () => {
  assert(
    !/kimi|deepseek|glm|minimax|moonshot|anthropic|openai/i.test(asset),
    "workflow asset leaks a model or provider name",
  );
});

runCase("CASE 5: injected workflow is non-empty when present", () => {
  const state = loadWorkflow();
  assert(state.section.length > 0, "shipped workflow asset should be non-empty");
});

runCase("CASE 6: /workflow command reports the workflow source", () => {
  let handler;
  let notifyText = "";
  const pi = {
    on() {},
    registerCommand(name, opts) {
      if (name === "workflow") handler = opts.handler;
    },
  };
  piRoster(pi);
  assert(handler, "registerCommand('workflow') was not called");
  const ctx = { ui: { notify(text) { notifyText = text; } } };
  handler("", ctx);
  assert(typeof notifyText === "string" && notifyText.length > 0, "workflow handler did not notify");
  assert(
    /workflow source|workflow disabled/.test(notifyText),
    `unexpected workflow report:\n${notifyText}`,
  );
  assert(!/roster/i.test(notifyText), `workflow report must not mention a roster:\n${notifyText}`);
});

runCase("CASE 7: ORCHESTRATOR.md in cwd replaces the packaged default", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-cwd-"));
  const userFile = join(dir, "ORCHESTRATOR.md");
  writeFileSync(userFile, "# my workflow\ncustom rule\n");
  const state = loadWorkflow(dir, dir);
  assert(state.source === "user", `expected user source, got ${state.source}`);
  assert(state.path === userFile, `expected cwd path, got ${state.path}`);
  assert(state.section === "# my workflow\ncustom rule\n", `unexpected section: ${state.section}`);
  rmSync(dir, { recursive: true, force: true });
});

runCase("CASE 8: ORCHESTRATOR.md in a parent directory replaces the default", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-orch-parent-"));
  const child = join(parent, "sub");
  mkdirSync(child);
  const userFile = join(parent, "ORCHESTRATOR.md");
  writeFileSync(userFile, "# parent workflow\n");
  const state = loadWorkflow(child, parent);
  assert(state.source === "user", `expected user source, got ${state.source}`);
  assert(state.path === userFile, `expected parent path, got ${state.path}`);
  assert(state.section === "# parent workflow\n", `unexpected section: ${state.section}`);
  rmSync(parent, { recursive: true, force: true });
});

runCase("CASE 9: ORCHESTRATOR.md in the agent dir replaces the default", () => {
  const agent = mkdtempSync(join(tmpdir(), "pi-orch-agent-"));
  const cwdDir = mkdtempSync(join(tmpdir(), "pi-orch-agentcwd-"));
  const userFile = join(agent, "ORCHESTRATOR.md");
  writeFileSync(userFile, "# agent workflow\n");
  const state = loadWorkflow(cwdDir, agent);
  assert(state.source === "user", `expected user source, got ${state.source}`);
  assert(state.path === userFile, `expected agent-dir path, got ${state.path}`);
  assert(state.section === "# agent workflow\n", `unexpected section: ${state.section}`);
  rmSync(agent, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

runCase("CASE 10: nearer parent beats the agent dir when both have ORCHESTRATOR.md", () => {
  const parent = mkdtempSync(join(tmpdir(), "pi-orch-both-parent-"));
  const child = join(parent, "sub");
  mkdirSync(child);
  const agent = mkdtempSync(join(tmpdir(), "pi-orch-both-agent-"));
  const parentFile = join(parent, "ORCHESTRATOR.md");
  const agentFile = join(agent, "ORCHESTRATOR.md");
  writeFileSync(parentFile, "# parent wins\n");
  writeFileSync(agentFile, "# agent loses\n");
  const state = loadWorkflow(child, agent);
  assert(state.source === "user", `expected user source, got ${state.source}`);
  assert(state.path === parentFile, `nearer parent should win, got ${state.path}`);
  assert(state.section === "# parent wins\n", `unexpected section: ${state.section}`);
  rmSync(parent, { recursive: true, force: true });
  rmSync(agent, { recursive: true, force: true });
});

runCase("CASE 11: AGENTS.md alone does not suppress the default workflow (loading)", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-agents-"));
  writeFileSync(join(dir, "AGENTS.md"), "use tabs\n");
  const state = loadWorkflow(dir, dir);
  assert(state.source === "default", `expected default source, got ${state.source}`);
  assert(state.section.length > 0, "default workflow should inject");
  assert(!state.section.includes("use tabs"), "AGENTS.md content must not be treated as the workflow");
  rmSync(dir, { recursive: true, force: true });
});

await runCaseAsync("CASE 12: /workflow init writes the template and refuses to overwrite", async () => {
  let handler;
  let lastNotify = "";
  let lastType = "";
  const pi = {
    on() {},
    registerCommand(name, opts) {
      if (name === "workflow") handler = opts.handler;
    },
  };
  piRoster(pi);
  assert(handler, "registerCommand('workflow') was not called");

  const dir = mkdtempSync(join(tmpdir(), "pi-orch-init-"));
  const target = join(dir, "ORCHESTRATOR.md");
  const ctx = {
    cwd: dir,
    ui: { notify(text, type) { lastNotify = text; lastType = type; } },
  };
  await handler(`init ${target}`, ctx);
  assert(readFileSync(target, "utf8") === asset, "init did not write the example asset verbatim");
  assert(lastNotify.includes(target), `init report missing target path:\n${lastNotify}`);
  assert(lastType === "info", `init should report info, got ${lastType}`);

  writeFileSync(target, "user edits");
  await handler(`init ${target}`, ctx);
  assert(readFileSync(target, "utf8") === "user edits", "second init overwrote existing file");
  assert(lastType === "error", `second init should refuse with error, got ${lastType}`);
  assert(/refusing to overwrite/.test(lastNotify), `refusal message missing:\n${lastNotify}`);

  const dir2 = mkdtempSync(join(tmpdir(), "pi-orch-init2-"));
  const ctx2 = { cwd: dir2, ui: { notify(text, type) { lastNotify = text; lastType = type; } } };
  await handler("init", ctx2);
  assert(readFileSync(join(dir2, "ORCHESTRATOR.md"), "utf8") === asset, "default-path init did not write ORCHESTRATOR.md");

  rmSync(dir, { recursive: true, force: true });
  rmSync(dir2, { recursive: true, force: true });
});

runCase("CASE 13: shipped asset contains no requires: markers", () => {
  assert(!asset.includes("requires:"), `asset must not contain capability markers:\n${asset}`);
});

runCase("CASE 14: shipped asset retains the full workflow detail", () => {
  for (const needle of [
    "## Workflow",
    "## Agent roles",
    "## Model selection",
    "## Token efficiency",
    "## Notes",
    "oracle",
    "worker",
    "reviewer",
    "scout",
    "researcher",
    "logic errors",
    "test coverage",
    "unnecessary complexity",
    "Opus is opt-in",
    "Coding entry point",
    "Second opinion",
    "boomerang",
    "ctx_execute",
    "ask_user",
    "`worker`'s classes are `flash` and `coding` only",
    "`reviewer` and `researcher`",
  ]) {
    assert(asset.includes(needle), `asset lost detail: ${needle}`);
  }
});

// Exercise the before_agent_start handler with a controlled installed-package
// set (settings.json `packages`) and model-registry provider set. Reports the
// context files the handler added (the workflow now rides in
// <project_instructions>, the same slot as an AGENTS.md) and whether
// model_roster was present on the sections object before and after the run.
function injectWorkflow({
  packages = [],
  providers = [],
  userFile = null,
  settings = null,
  presetRoster = null,
  presetContextFiles = [],
  sessionId = "inject-session",
  messageType = "user",
} = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-orch-agent-"));
  const workDir = mkdtempSync(join(tmpdir(), "pi-orch-work-"));
  if (userFile !== null) writeFileSync(join(workDir, "ORCHESTRATOR.md"), userFile);
  writeFileSync(
    join(agentDir, "settings.json"),
    settings !== null ? settings : JSON.stringify({ packages }),
  );
  const prevCwd = process.cwd();
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.chdir(workDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let onBefore;
  const pi = {
    on(event, cb) {
      if (event === "before_agent_start") onBefore = cb;
    },
    registerCommand() {},
  };
  piRoster(pi);
  assert(onBefore, "before_agent_start handler was not registered");
  const ctx = {
    cwd: workDir,
    sessionManager: { getSessionId: () => sessionId },
    modelRegistry: {
      getProvider: (name) => (providers.includes(name) ? { name } : undefined),
    },
  };
  const sections = {};
  if (presetRoster !== null) sections.model_roster = presetRoster;
  const contextFiles = [...presetContextFiles];
  const beforeRoster = Object.prototype.hasOwnProperty.call(sections, "model_roster");
  const countBefore = contextFiles.length;
  onBefore({ messageType, systemPromptOptions: { sections, contextFiles } }, ctx);
  const added = contextFiles.slice(countBefore);
  const afterRoster = Object.prototype.hasOwnProperty.call(sections, "model_roster");
  const result = {
    workflow: added.length === 1 ? added[0].content : added.length === 0 ? undefined : "DUPLICATE",
    added,
    contextFiles,
    sections,
    beforeRoster,
    afterRoster,
  };
  process.chdir(prevCwd);
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  return result;
}

runCase("CASE 15: packaged workflow injects only when all four required extensions are installed", () => {
  const required = ["npm:pi-subagents", "npm:pi-boomerang", "npm:context-mode"];
  const allPresent = injectWorkflow({ packages: required, providers: ["failover"] });
  assert(allPresent.workflow === asset, "all required installed should inject the full asset");
  const missing = injectWorkflow({ packages: required, providers: [] });
  assert(missing.workflow === undefined, "missing pi-failover should withhold the workflow");
});

runCase("CASE 16: a user ORCHESTRATOR.md is injected verbatim even with all four required extensions missing", () => {
  const userText = "# my workflow\ncustom rule\n";
  const result = injectWorkflow({ packages: [], providers: [], userFile: userText });
  assert(
    result.workflow === userText,
    `user workflow was withheld instead of injected verbatim:\n${result.workflow}`,
  );
});

runCase("CASE 17: doctor marks the four required extensions and reports the withheld state", () => {
  const missing = renderDoctorReport({
    available: new Set(),
    workflowSource: "default",
    workflowPath: "/assets/ORCHESTRATOR.example.md",
    withheld: true,
    toolsSeen: new Set(),
  });
  assert(missing.includes("MISSING REQUIRED"), `missing-required banner absent:\n${missing}`);
  assert(
    missing.includes("MISSING REQUIRED: pi-subagents, pi-boomerang, context-mode, pi-failover"),
    `missing-required banner must name all four required:\n${missing}`,
  );
  assert(missing.includes("pi-subagents: missing — required"), `subagents required line absent:\n${missing}`);
  assert(missing.includes("pi-boomerang: missing — required"), `boomerang required line absent:\n${missing}`);
  assert(missing.includes("context-mode: missing — required"), `context-mode required line absent:\n${missing}`);
  assert(missing.includes("pi-failover: missing — required"), `failover required line absent:\n${missing}`);
  assert(missing.includes("pi install npm:pi-subagents"), `subagents install command absent:\n${missing}`);
  assert(missing.includes("pi install npm:pi-boomerang"), `boomerang install command absent:\n${missing}`);
  assert(missing.includes("pi install npm:context-mode"), `context-mode install command absent:\n${missing}`);
  assert(missing.includes("pi install git:github.com/rthadani/pi-failover"), `failover install command absent:\n${missing}`);
  assert(missing.includes("workflow status: WITHHELD"), `withheld state absent:\n${missing}`);
  assert(missing.includes("runtime tools (informational, not a gate)"), `informational tools line absent:\n${missing}`);
  assert(
    missing.includes("ask_user: optional — degrades gracefully"),
    `ask_user optional degrade line absent:\n${missing}`,
  );
  assert(!missing.includes("roster"), `doctor must not claim roster injection:\n${missing}`);
  assert(!missing.includes("failover config"), `doctor must not report a failover config file:\n${missing}`);

  const present = renderDoctorReport({
    available: new Set(["pi-subagents", "pi-boomerang", "context-mode", "pi-failover", "ask_user"]),
    workflowSource: "default",
    workflowPath: "/assets/ORCHESTRATOR.example.md",
    withheld: false,
    toolsSeen: new Set(["subagent", "boomerang", "ctx_execute", "ask_user"]),
  });
  assert(present.includes("required extensions: all present"), `all-present banner absent:\n${present}`);
  assert(present.includes("pi-subagents: present"), `subagents present line absent:\n${present}`);
  assert(present.includes("pi-failover: present"), `failover present line absent:\n${present}`);
  assert(present.includes("ask_user: present"), `ask_user present line absent:\n${present}`);
  assert(present.includes("workflow status: injecting"), `injecting state absent:\n${present}`);
  assert(present.includes("subagent=seen"), `informational subagent seen line absent:\n${present}`);
  assert(!present.includes("MISSING REQUIRED"), `missing banner should not appear when all present:\n${present}`);
  assert(!present.includes("WITHHELD"), `withheld should not appear when all present:\n${present}`);
});

runCase("CASE 18: detectExtensions maps installed packages and providers to capabilities", () => {
  const none = detectExtensions(() => false, () => false);
  assert(none.size === 0, `expected no extensions, got ${[...none]}`);

  const full = detectExtensions(
    (name) => ["pi-subagents", "pi-boomerang", "context-mode", "pi-ask-user"].includes(name),
    (name) => name === "failover",
  );
  assert(
    full.size === 5 && full.has("pi-subagents") && full.has("pi-boomerang") && full.has("context-mode") && full.has("pi-failover") && full.has("ask_user"),
    `unexpected extensions: ${[...full]}`,
  );

  const contextOnly = detectExtensions((name) => name === "context-mode", () => false);
  assert(contextOnly.size === 1 && contextOnly.has("context-mode"), `package should enable context-mode: ${[...contextOnly]}`);

  const failoverOnly = detectExtensions(() => false, (name) => name === "failover");
  assert(failoverOnly.size === 1 && failoverOnly.has("pi-failover"), `provider should enable pi-failover: ${[...failoverOnly]}`);
});

runCase("CASE 19: detectExtensions returns the four required capabilities only when predicates report present", () => {
  const all = detectExtensions(() => true, () => true);
  for (const cap of ["pi-subagents", "pi-boomerang", "context-mode", "pi-failover"]) {
    assert(all.has(cap), `missing required capability ${cap}`);
  }
  assert(all.has("ask_user"), "ask_user should be present when its package is reported");

  const packageSubset = detectExtensions(
    (name) => ["pi-subagents", "pi-boomerang", "context-mode", "pi-ask-user"].includes(name),
    () => false,
  );
  assert(
    packageSubset.has("pi-subagents") && packageSubset.has("pi-boomerang") && packageSubset.has("context-mode") && packageSubset.has("ask_user"),
    `package-only subset wrong: ${[...packageSubset]}`,
  );
  assert(!packageSubset.has("pi-failover"), "pi-failover must not be present without the provider");

  const providerSubset = detectExtensions(() => false, (name) => name === "failover");
  assert(providerSubset.size === 1 && providerSubset.has("pi-failover"), `provider-only subset wrong: ${[...providerSubset]}`);
});

runCase("CASE 20: the required set is exactly the four, with ask_user excluded", () => {
  const required = missingRequired(new Set());
  const names = required.map((def) => def.capability).sort();
  assert(
    names.join(",") === "context-mode,pi-boomerang,pi-failover,pi-subagents",
    `unexpected required set: ${names.join(",")}`,
  );
  assert(!required.some((def) => def.capability === "ask_user"), "ask_user must not be required");
});

runCase("CASE 21: missing any one required extension withholds; installed packages without tools still inject", () => {
  const requiredPackages = ["npm:pi-subagents", "npm:pi-boomerang", "npm:context-mode"];
  const cases = [
    { missing: "pi-subagents", packages: ["npm:pi-boomerang", "npm:context-mode"], providers: ["failover"] },
    { missing: "pi-boomerang", packages: ["npm:pi-subagents", "npm:context-mode"], providers: ["failover"] },
    { missing: "context-mode", packages: ["npm:pi-subagents", "npm:pi-boomerang"], providers: ["failover"] },
    { missing: "pi-failover", packages: requiredPackages, providers: [] },
  ];
  for (const c of cases) {
    const result = injectWorkflow({ packages: c.packages, providers: c.providers });
    assert(
      result.workflow === undefined,
      `missing ${c.missing} should withhold the workflow, got:\n${result.workflow}`,
    );
  }
  const withoutAskUser = injectWorkflow({ packages: requiredPackages, providers: ["failover"] });
  assert(withoutAskUser.workflow === asset, "missing ask_user alone must still inject the packaged workflow");

  // Regression: packages installed but NO runtime tools registered must still inject.
  const noTools = injectWorkflow({
    packages: [...requiredPackages, "npm:pi-ask-user"],
    providers: ["failover"],
  });
  assert(noTools.workflow === asset, "installed packages with no runtime tools must still inject");
});

runCase("CASE 22: unreadable settings or missing modelRegistry fails open and still injects", () => {
  const badSettings = injectWorkflow({ packages: [], providers: ["failover"], settings: "{ not json" });
  assert(badSettings.workflow === asset, "unreadable settings should fail open and inject");

  const agentDir = mkdtempSync(join(tmpdir(), "pi-orch-failopen-"));
  const workDir = mkdtempSync(join(tmpdir(), "pi-orch-failopenw-"));
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: ["npm:pi-subagents", "npm:pi-boomerang", "npm:context-mode"] }),
  );
  const prevCwd = process.cwd();
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.chdir(workDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    let onBefore;
    const pi = {
      on(event, cb) {
        if (event === "before_agent_start") onBefore = cb;
      },
      registerCommand() {},
    };
    piRoster(pi);
    const contextFiles = [];
    onBefore(
      { messageType: "user", systemPromptOptions: { sections: {}, contextFiles } },
      { cwd: workDir, sessionManager: { getSessionId: () => "failopen" } },
    );
    assert(
      contextFiles.length === 1 && contextFiles[0].content === asset,
      "missing modelRegistry should fail open and inject",
    );
  } finally {
    process.chdir(prevCwd);
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

runCase("CASE 23: the workflow is placed in project_instructions, never in a prompt section", () => {
  const requiredPackages = ["npm:pi-subagents", "npm:pi-boomerang", "npm:context-mode"];
  const result = injectWorkflow({ packages: requiredPackages, providers: ["failover"] });
  assert(result.workflow === asset, "gating-passed handler should inject the full asset");
  assert(
    result.added[0].path.endsWith("ORCHESTRATOR.example.md") || result.added[0].path.endsWith("ORCHESTRATOR.md"),
    `unexpected context file path: ${result.added[0].path}`,
  );
  assert(
    !Object.prototype.hasOwnProperty.call(result.sections, "orchestrator_workflow"),
    "the legacy orchestrator_workflow section must not be set",
  );
});

runCase("CASE 23b: a stale legacy orchestrator_workflow section is removed", () => {
  const requiredPackages = ["npm:pi-subagents", "npm:pi-boomerang", "npm:context-mode"];
  const result = injectWorkflow({ packages: requiredPackages, providers: ["failover"] });
  assert(
    !Object.prototype.hasOwnProperty.call(result.sections, "orchestrator_workflow"),
    "legacy section should be deleted from the prompt",
  );

  const sections = { orchestrator_workflow: "stale copy" };
  const contextFiles = [];
  applyWorkflowToPrompt(
    { sections, contextFiles },
    { section: "fresh", path: "/x/ORCHESTRATOR.md", mtimeMs: 1, disabled: null, source: "user" },
    true,
  );
  assert(!("orchestrator_workflow" in sections), "legacy key must be deleted on sight");
  assert(contextFiles.length === 1 && contextFiles[0].content === "fresh", "fresh workflow must be added");
});

runCase("CASE 23c: injection is idempotent across repeated runs", () => {
  const workflow = { section: "w", path: "/x/ORCHESTRATOR.md", mtimeMs: 1, disabled: null, source: "user" };
  const options = { sections: {}, contextFiles: [] };
  applyWorkflowToPrompt(options, workflow, true);
  applyWorkflowToPrompt(options, workflow, true);
  applyWorkflowToPrompt(options, workflow, true);
  assert(options.contextFiles.length === 1, `expected one entry, got ${options.contextFiles.length}`);

  applyWorkflowToPrompt(options, workflow, false);
  assert(options.contextFiles.length === 0, "a withheld workflow must remove its entry");
});

runCase("CASE 25: the gate blocks reads and writes for a top-level session with no spawn", () => {
  for (const toolName of ["read", "grep", "find", "ls", "bash", "edit", "write", "codemode", "lsp_hover", "ctx_execute"]) {
    const decision = decideToolGate({
      toolName,
      active: true,
      enforce: true,
      topLevel: true,
      spawnInFlight: false,
      delegated: false,
    });
    assert(decision.block, `${toolName} should be blocked before a spawn`);
    assert(/delegation/i.test(decision.reason ?? ""), `${toolName} block reason must explain delegation`);
  }
});

runCase("CASE 26: the gate always allows spawning, asking, and unknown non-file tools", () => {
  for (const toolName of ["subagent", "ask_user", "boomerang", "todo"]) {
    const decision = decideToolGate({
      toolName,
      active: true,
      enforce: true,
      topLevel: true,
      spawnInFlight: false,
      delegated: false,
    });
    assert(!decision.block, `${toolName} must not be blocked`);
  }
});

runCase("CASE 27: the gate opens after a spawn, exempts children, and respects the off switch", () => {
  const base = { active: true, enforce: true, topLevel: true, spawnInFlight: false };
  assert(!decideToolGate({ ...base, toolName: "read", delegated: true }).block, "delegated session must be open");
  assert(
    !decideToolGate({ ...base, topLevel: false, toolName: "read", delegated: false }).block,
    "child sessions must be exempt",
  );
  assert(
    !decideToolGate({ ...base, spawnInFlight: true, toolName: "read", delegated: false }).block,
    "calls made while a spawn is in flight must pass",
  );
  assert(
    !decideToolGate({ ...base, enforce: false, toolName: "edit", delegated: false }).block,
    "WORKFLOW_ENFORCE=off must disable the gate",
  );
  assert(
    !decideToolGate({ ...base, active: false, toolName: "edit", delegated: false }).block,
    "a withheld workflow must not be enforced",
  );
});

runCase("CASE 28: WORKFLOW_ENFORCE parsing accepts only explicit off values", () => {
  assert(enforcementEnabled({}) === true, "unset must enforce");
  assert(enforcementEnabled({ WORKFLOW_ENFORCE: "on" }) === true, "'on' must enforce");
  for (const value of ["off", "0", "false", "no", " OFF "]) {
    assert(enforcementEnabled({ WORKFLOW_ENFORCE: value }) === false, `${value} must disable`);
  }
});

runCase("CASE 24: before_agent_start never sets and never deletes model_roster", () => {
  const requiredPackages = ["npm:pi-subagents", "npm:pi-boomerang", "npm:context-mode"];

  const absent = injectWorkflow({ packages: requiredPackages, providers: ["failover"] });
  assert(!absent.beforeRoster, "model_roster must be absent before the handler runs");
  assert(!absent.afterRoster, "model_roster must be absent after the handler runs");

  const preset = injectWorkflow({
    packages: requiredPackages,
    providers: ["failover"],
    presetRoster: "pi-failover roster section",
  });
  assert(preset.beforeRoster, "model_roster should be present before the handler runs");
  assert(preset.afterRoster, "handler must not delete a pre-existing model_roster");
  assert(
    preset.sections.model_roster === "pi-failover roster section",
    `handler must not alter a pre-existing model_roster, got:\n${preset.sections.model_roster}`,
  );
});

// Drive the real handlers through a fake pi: before_agent_start, then a
// sequence of tool_call / tool_execution_end events for named sessions.
function gateHarness({ userFile = "# workflow\ndelegate first\n", packages = null, providers = ["failover"], messageType = "user", tools = ["subagent", "read", "grep", "bash", "edit", "write"] } = {}) {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-orch-gate-"));
  const workDir = mkdtempSync(join(tmpdir(), "pi-orch-gatew-"));
  if (userFile !== null) writeFileSync(join(workDir, "ORCHESTRATOR.md"), userFile);
  writeFileSync(
    join(agentDir, "settings.json"),
    JSON.stringify({ packages: packages ?? ["npm:pi-subagents", "npm:pi-boomerang", "npm:context-mode"] }),
  );
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const handlers = new Map();
  const pi = {
    on(event, cb) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
    },
    getAllTools: () => tools.map((name) => ({ name })),
    registerCommand() {},
  };
  piRoster(pi);

  const ctxFor = (sessionId) => ({
    cwd: workDir,
    sessionManager: { getSessionId: () => sessionId },
    modelRegistry: { getProvider: (name) => (providers.includes(name) ? { name } : undefined) },
  });

  const call = async (event, sessionId, payload) => {
    let result;
    for (const handler of handlers.get(event) ?? []) {
      const outcome = await handler(payload, ctxFor(sessionId));
      if (outcome !== undefined) result = outcome;
    }
    return result;
  };

  return {
    start: (sessionId, type = messageType) =>
      call("before_agent_start", sessionId, {
        messageType: type,
        systemPromptOptions: { sections: {}, contextFiles: [] },
      }),
    toolCall: (sessionId, toolName) => call("tool_call", sessionId, { toolName, input: {} }),
    toolEnd: (sessionId, toolName, isError = false) =>
      call("tool_execution_end", sessionId, { toolName, isError, toolCallId: "t" }),
    cleanup: () => {
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(workDir, { recursive: true, force: true });
    },
  };
}

await runCaseAsync("CASE 29: a user run arms the gate until a spawn, then re-arms after a mutation", async () => {
  const h = gateHarness();
  try {
    await h.start("s-arith");

    const blockedRead = await h.toolCall("s-arith", "read");
    assert(blockedRead?.block === true, "first read must be blocked");
    assert(/scout|oracle/.test(blockedRead.reason ?? ""), `reason must name the roles:\n${blockedRead.reason}`);

    assert((await h.toolCall("s-arith", "subagent")) === undefined, "spawning must never be blocked");
    assert((await h.toolCall("s-arith", "read")) === undefined, "read must pass after a spawn");
    assert((await h.toolCall("s-arith", "edit")) === undefined, "edit must pass after a spawn");

    await h.toolEnd("s-arith", "subagent");
    await h.toolEnd("s-arith", "edit");
    const rearmed = await h.toolCall("s-arith", "write");
    assert(rearmed?.block === true, "a completed top-level mutation must re-arm the gate");
  } finally {
    h.cleanup();
  }
});

await runCaseAsync("CASE 30: child sessions and in-flight spawns are never blocked", async () => {
  const h = gateHarness();
  try {
    await h.start("s-parent");
    await h.start("s-other");
    assert((await h.toolCall("s-child", "read")) === undefined, "a child session must read freely");
    assert((await h.toolCall("s-child", "bash")) === undefined, "a child session must run bash freely");

    assert((await h.toolCall("s-other", "read"))?.block === true, "another top-level session must stay gated");
    await h.toolCall("s-parent", "subagent");
    assert(
      (await h.toolCall("s-other", "read")) === undefined,
      "while a spawn is in flight, tool calls must pass",
    );
    await h.toolEnd("s-parent", "subagent");
    assert((await h.toolCall("s-other", "read"))?.block === true, "after the spawn ends, the gate closes again");
  } finally {
    h.cleanup();
  }
});

await runCaseAsync("CASE 31: two sessions do not share delegation", async () => {
  const h = gateHarness();
  try {
    await h.start("s-a");
    await h.start("s-b");
    await h.toolCall("s-a", "subagent");
    await h.toolEnd("s-a", "subagent");
    assert((await h.toolCall("s-a", "read")) === undefined, "the delegating session must be open");
    assert((await h.toolCall("s-b", "read"))?.block === true, "the other session must stay armed");
  } finally {
    h.cleanup();
  }
});

await runCaseAsync("CASE 32: a withheld workflow is never enforced", async () => {
  // No user file, and required extensions missing, so the packaged default is withheld.
  const h = gateHarness({ packages: [], userFile: null });
  try {
    await h.start("s-withheld");
    assert((await h.toolCall("s-withheld", "read")) === undefined, "nothing to enforce means nothing to block");
  } finally {
    h.cleanup();
  }
});

await runCaseAsync("CASE 33: a user turn re-arms the session gate", async () => {
  const h = gateHarness();
  try {
    await h.start("s-turn");
    await h.toolCall("s-turn", "subagent");
    await h.toolEnd("s-turn", "subagent");
    assert((await h.toolCall("s-turn", "read")) === undefined, "open after delegation");
    await h.start("s-turn");
    assert((await h.toolCall("s-turn", "read"))?.block === true, "a new user turn must re-arm");
  } finally {
    h.cleanup();
  }
});

await runCaseAsync("CASE 34: a process without the subagent tool is never gated", async () => {
  // This is the review-child case: no way to spawn, so blocking a read would wedge it.
  const h = gateHarness({ tools: ["read", "grep", "bash"] });
  try {
    await h.start("s-reviewer");
    assert((await h.toolCall("s-reviewer", "read")) === undefined, "a session that cannot delegate must not be blocked");
    assert((await h.toolCall("s-reviewer", "bash")) === undefined, "nor may its shell be blocked");
  } finally {
    h.cleanup();
  }
});

await runCaseAsync("CASE 35: an unknown run type never arms the gate", async () => {
  const h = gateHarness();
  try {
    await h.start("s-nomt", "other");
    assert((await h.toolCall("s-nomt", "read")) === undefined, "only an explicit user run may arm the gate");
  } finally {
    h.cleanup();
  }
});

if (failures > 0) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log("ALL PASS");
