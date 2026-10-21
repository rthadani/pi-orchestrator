// pi-orchestrator render harness: exercises renderRoster (pure) and loadRoster
// (mtime-cached config loading) in extensions/pi-orchestrator.ts with offline
// fixtures. No framework; throws on failure; prints PASS lines.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
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
function classLine(text, name) {
  const line = text.split("\n").find((l) => l.startsWith(`- ${name}:`));
  assert(line !== undefined, `missing "${name}" class line in roster:\n${text}`);
  return line;
}
function inOrder(line, names) {
  let prev = -1;
  for (const name of names) {
    const i = line.indexOf(name);
    assert(i >= 0, `missing "${name}" in line: ${line}`);
    assert(i > prev, `"${name}" out of order in line: ${line}`);
    prev = i;
  }
}

// Point the module's initial load at the real default config, not an inherited
// FAILOVER_CONFIG from the environment.
delete process.env.FAILOVER_CONFIG;

const { renderRoster, loadRoster, findOrchestratorFile, renderDefaultSections, loadWorkflow, detectExtensions, missingRequired, renderDoctorReport, default: piRoster } = await import("../extensions/pi-orchestrator.ts");

const here = dirname(fileURLToPath(import.meta.url));

// --print: audit the real config's rendered roster (fresh process, before cases).
if (process.argv.includes("--print")) {
  const state = loadRoster();
  console.log(state.section);
  console.log(`config: ${state.path}`);
  console.log(`mtime: ${state.mtimeMs ?? "missing"}`);
  process.exit(state.section ? 0 : 1);
}

// Fixture mirroring the real failover.json catalog shape (values are enough to
// prove ordering, dedup, and modalities without reading the real file).
const fixture = {
  sets: [
    {
      name: "opus",
      models: [
        { name: "glm-5.3", cost: { input: 1.4, output: 4.4 } },
        { name: "kimi-k3", input: ["text", "image"], cost: { input: 3, output: 15 } },
      ],
    },
    {
      name: "sonnet",
      models: [
        {
          name: "deepseek-v4-pro",
          cost: { input: 0.435, output: 0.87 },
          thinkingLevelMap: { minimal: "high", xhigh: "max" },
        },
        { name: "kimi-k2.6", input: ["text", "image"], cost: { input: 0.95, output: 4 } },
      ],
    },
    {
      name: "flash",
      models: [
        { name: "deepseek-flash", cost: { input: 0.14, output: 0.28 } },
        { name: "MiniMax-M3.1-Flash", input: ["text", "image"], cost: { input: 0.15, output: 0.6 } },
        { name: "glm-5.3-flash", input: ["text", "image"], cost: { input: 0.15, output: 0.5 } },
      ],
    },
    {
      name: "coding",
      models: [
        { name: "kimi-k2.7-code", input: ["text", "image"], cost: { input: 0.95, output: 4 } },
        {
          name: "deepseek-v4-pro",
          cost: { input: 0.435, output: 0.87 },
          thinkingLevelMap: { minimal: "high", xhigh: "max" },
        },
        { name: "MiniMax-M3.1-Flash", input: ["text", "image"], cost: { input: 0.15, output: 0.6 } },
        { name: "glm-5.3-flash", input: ["text", "image"], cost: { input: 0.15, output: 0.5 } },
      ],
    },
  ],
};

runCase("CASE 1: renders all four classes with the expected member order", () => {
  const text = renderRoster(fixture);
  inOrder(classLine(text, "opus"), ["glm-5.3", "kimi-k3"]);
  inOrder(classLine(text, "sonnet"), ["deepseek-v4-pro", "kimi-k2.6"]);
  inOrder(classLine(text, "flash"), ["deepseek-flash", "MiniMax-M3.1-Flash", "glm-5.3-flash"]);
  inOrder(classLine(text, "coding"), [
    "kimi-k2.7-code",
    "deepseek-v4-pro",
    "MiniMax-M3.1-Flash",
    "glm-5.3-flash",
  ]);
});

runCase("CASE 2: sonnet's first-listed model is deepseek-v4-pro", () => {
  const text = renderRoster(fixture);
  const sonnet = classLine(text, "sonnet");
  assert(sonnet.startsWith("- sonnet: deepseek-v4-pro"), `sonnet does not lead with deepseek-v4-pro: ${sonnet}`);
});

runCase("CASE 3: a model in two sets is bare after its first occurrence", () => {
  const text = renderRoster(fixture);
  const sonnet = classLine(text, "sonnet");
  const coding = classLine(text, "coding");
  assert(sonnet.includes("deepseek-v4-pro ($"), "first occurrence should carry cost detail");
  assert(coding.includes("-> deepseek-v4-pro ->"), "coding's deepseek-v4-pro should be a bare name");
  assert(!coding.includes("deepseek-v4-pro ("), "coding should not repeat deepseek-v4-pro details");
  assert(!coding.includes("MiniMax-M3.1-Flash ("), "coding should not repeat MiniMax-M3.1-Flash details");
});

runCase("CASE 4: modalities reflect the input field", () => {
  const text = renderRoster(fixture);
  const sonnet = classLine(text, "sonnet");
  assert(/kimi-k2\.6 \([^)]*image/.test(sonnet), `kimi-k2.6 should show image: ${sonnet}`);
  const opus = classLine(text, "opus");
  assert(/glm-5\.3 \([^)]*text/.test(opus), `glm-5.3 should show text: ${opus}`);
  assert(!/glm-5\.3 \([^)]*image/.test(opus), `glm-5.3 should not show image: ${opus}`);
});

const tmp = mkdtempSync(join(tmpdir(), "pi-roster-harness-"));

runCase("CASE 5: malformed JSON yields an empty section without throwing", () => {
  const bad = join(tmp, "bad.json");
  writeFileSync(bad, "{ not json");
  process.env.FAILOVER_CONFIG = bad;
  let state;
  let threw = false;
  try {
    state = loadRoster();
  } catch {
    threw = true;
  }
  assert(!threw, "loadRoster threw on malformed JSON");
  assert(state.section === "", `expected empty section, got: ${state.section}`);
  assert(state.disabled, "expected a disabled reason");
});

runCase("CASE 6: missing file yields an empty section without throwing", () => {
  const missing = join(tmp, "nope.json");
  process.env.FAILOVER_CONFIG = missing;
  let state;
  let threw = false;
  try {
    state = loadRoster();
  } catch {
    threw = true;
  }
  assert(!threw, "loadRoster threw on a missing file");
  assert(state.section === "", `expected empty section, got: ${state.section}`);
  assert(state.disabled, "expected a disabled reason");
});

runCase("CASE 7: FAILOVER_CONFIG is honoured", () => {
  const custom = join(tmp, "custom.json");
  writeFileSync(
    custom,
    JSON.stringify({ sets: [{ name: "customset", models: [{ name: "custom-model", input: ["text"] }] }] }),
  );
  process.env.FAILOVER_CONFIG = custom;
  const state = loadRoster();
  assert(state.section.includes("- customset:"), `FAILOVER_CONFIG ignored, got:\n${state.section}`);
  assert(state.section.includes("custom-model"), "custom model missing from rendered roster");
});

runCase("CASE 8: wrong-shaped entries are skipped without throwing", () => {
  const nullSet = renderRoster({ sets: [null] });
  assert(typeof nullSet === "string", `null set: expected string, got ${typeof nullSet}`);
  const nullModel = renderRoster({ sets: [{ models: [null] }] });
  assert(typeof nullModel === "string", `null model: expected string, got ${typeof nullModel}`);
  const noName = renderRoster({
    sets: [{ name: "s", models: [{ cost: { input: 1, output: 2 } }] }],
  });
  assert(typeof noName === "string", `missing name: expected string, got ${typeof noName}`);
  assert(!noName.includes("undefined"), `missing name rendered "undefined": ${noName}`);
});

runCase("CASE 9: mtime change reloads the config", () => {
  const p = join(tmp, "reload.json");
  const later = new Date(Date.now() + 1000);
  writeFileSync(p, JSON.stringify({ sets: [{ name: "s", models: [{ name: "model-A" }] }] }));
  process.env.FAILOVER_CONFIG = p;
  const first = loadRoster();
  assert(first.section.includes("model-A"), `first load missing model-A:\n${first.section}`);
  writeFileSync(p, JSON.stringify({ sets: [{ name: "s", models: [{ name: "model-B" }] }] }));
  utimesSync(p, later, later);
  const second = loadRoster();
  assert(second.section.includes("model-B"), `reload missing model-B:\n${second.section}`);
  assert(!second.section.includes("model-A"), `stale model-A still present:\n${second.section}`);
});

runCase("CASE 10: malformed config warns exactly once at load", () => {
  const bad = join(tmp, "warn.json");
  writeFileSync(bad, "{ not json");
  const extPath = join(here, "..", "extensions", "pi-orchestrator.ts");
  const script = `import(${JSON.stringify(extPath)}).catch(() => process.exit(1));`;
  const res = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: here,
    env: { ...process.env, FAILOVER_CONFIG: bad },
    encoding: "utf8",
  });
  const warns = (res.stderr || "").split("\n").filter((l) => l.includes("[pi-orchestrator]"));
  assert(warns.length === 1, `expected one [pi-orchestrator] warn, got ${warns.length}:\n${res.stderr}`);
});

runCase("CASE 11: /roster command reports the roster or a disabled reason", () => {
  let handler;
  let notifyText = "";
  const pi = {
    on() {},
    registerCommand(name, opts) {
      if (name === "roster") handler = opts.handler;
    },
  };
  piRoster(pi);
  assert(handler, "registerCommand('roster') was not called");
  const ctx = { ui: { notify(text) { notifyText = text; } } };
  handler({}, ctx);
  assert(typeof notifyText === "string", "roster handler did not notify");
  assert(
    notifyText.includes("## Model roster") || notifyText.startsWith("roster disabled:"),
    `unexpected roster report:\n${notifyText}`,
  );
});

runCase("CASE 12: rendered roster carries no policy text", () => {
  const text = renderRoster(fixture);
  assert(text.length > 0, "rendered roster is empty");
  assert(
    !/must|should|escalate|review discipline|carve-out/i.test(text),
    `policy text leaked into roster:\n${text}`,
  );
});

runCase("CASE 13: roster section starts with the header", () => {
  const text = renderRoster(fixture);
  assert(text.startsWith("## Model roster"), `missing roster header:\n${text}`);
});

runCase("CASE 14: sonnet's xhigh model shows :xhigh->max", () => {
  const text = renderRoster(fixture);
  const sonnet = classLine(text, "sonnet");
  assert(/:xhigh->max/.test(sonnet), `missing :xhigh->max in sonnet line: ${sonnet}`);
});

const sampleRoster = { section: "roster section", path: "", mtimeMs: null, disabled: null };

runCase("CASE 15: ORCHESTRATOR.md search order (cwd, parents, agent dir, nearest wins)", () => {
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

runCase("CASE 16: AGENTS.md alone does not suppress the default workflow", () => {
  const agentsHit = "/proj/AGENTS.md";
  const found = findOrchestratorFile("/proj/sub", "/agents", (p) => p === agentsHit);
  assert(found === undefined, `AGENTS.md must not suppress; got ${found}`);
});

runCase("CASE 17: malformed failover leaves roster out but workflow in", () => {
  const bad = join(tmp, "bad2.json");
  writeFileSync(bad, "{ not json");
  process.env.FAILOVER_CONFIG = bad;
  const roster = loadRoster();
  assert(roster.section === "", "malformed config should yield an empty roster");
  assert(roster.disabled, "malformed config should carry a disabled reason");
  const sections = renderDefaultSections("workflow", roster);
  assert(sections.roster === null, "disabled roster should be omitted");
  assert(sections.workflow === "workflow", "workflow must be independent of roster failure");
});

runCase("CASE 18: missing workflow asset yields no section and no throw", () => {
  const missingDir = mkdtempSync(join(tmpdir(), "pi-roster-missing-"));
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

runCase("CASE 19: shipped workflow asset names no models or providers", () => {
  const asset = join(here, "..", "assets", "ORCHESTRATOR.example.md");
  const text = readFileSync(asset, "utf8");
  assert(
    !/kimi|deepseek|glm|minimax|moonshot|anthropic|openai/i.test(text),
    "workflow asset leaks a model or provider name",
  );
});

runCase("CASE 20: injected workflow is non-empty when present", () => {
  const state = loadWorkflow();
  assert(state.section.length > 0, "shipped workflow asset should be non-empty");
  const sections = renderDefaultSections(state.section, sampleRoster);
  assert(
    typeof sections.workflow === "string" && sections.workflow.length > 0,
    "workflow section should be non-empty when injected",
  );
});

runCase("CASE 21: /workflow command reports the workflow source and roster", () => {
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
  assert(
    /## Model roster|roster disabled/.test(notifyText),
    `workflow report missing roster:\n${notifyText}`,
  );
});

runCase("CASE 22: ORCHESTRATOR.md in cwd replaces the packaged default", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-cwd-"));
  const userFile = join(dir, "ORCHESTRATOR.md");
  writeFileSync(userFile, "# my workflow\ncustom rule\n");
  const state = loadWorkflow(dir, dir);
  assert(state.source === "user", `expected user source, got ${state.source}`);
  assert(state.path === userFile, `expected cwd path, got ${state.path}`);
  assert(state.section === "# my workflow\ncustom rule\n", `unexpected section: ${state.section}`);
  rmSync(dir, { recursive: true, force: true });
});

runCase("CASE 23: ORCHESTRATOR.md in a parent directory replaces the default", () => {
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

runCase("CASE 24: ORCHESTRATOR.md in the agent dir replaces the default", () => {
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

runCase("CASE 25: nearer parent beats the agent dir when both have ORCHESTRATOR.md", () => {
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

runCase("CASE 26: AGENTS.md alone does not suppress the default workflow", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-orch-agents-"));
  writeFileSync(join(dir, "AGENTS.md"), "use tabs\n");
  const state = loadWorkflow(dir, dir);
  assert(state.source === "default", `expected default source, got ${state.source}`);
  assert(state.section.length > 0, "default workflow should inject");
  assert(!state.section.includes("use tabs"), "AGENTS.md content must not be treated as the workflow");
  rmSync(dir, { recursive: true, force: true });
});

await runCaseAsync("CASE 27: /workflow init writes the template and refuses to overwrite", async () => {
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

  const asset = readFileSync(join(here, "..", "assets", "ORCHESTRATOR.example.md"), "utf8");

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

runCase("CASE 28: shipped asset contains no requires: markers", () => {
  const asset = readFileSync(join(here, "..", "assets", "ORCHESTRATOR.example.md"), "utf8");
  assert(!asset.includes("requires:"), `asset must not contain capability markers:\n${asset}`);
});

runCase("CASE 29: shipped asset retains the full workflow detail", () => {
  const asset = readFileSync(join(here, "..", "assets", "ORCHESTRATOR.example.md"), "utf8");
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
  ]) {
    assert(asset.includes(needle), `asset lost detail: ${needle}`);
  }
});

// Exercise the before_agent_start handler with a controlled installed-package
// set (settings.json `packages`) and model-registry provider set. Returns the
// injected workflow and roster sections (undefined when omitted).
function injectWorkflow({ packages = [], providers = [], userFile = null, settings = null }) {
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
    modelRegistry: {
      getProvider: (name) => (providers.includes(name) ? { name } : undefined),
    },
  };
  const sections = {};
  onBefore({ systemPromptOptions: { sections } }, ctx);
  const result = { workflow: sections.orchestrator_workflow, roster: sections.model_roster };
  process.chdir(prevCwd);
  if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
  return result;
}

runCase("CASE 30: packaged workflow injects only when all four required extensions are installed", () => {
  const asset = readFileSync(join(here, "..", "assets", "ORCHESTRATOR.example.md"), "utf8");
  const required = ["npm:pi-subagents", "npm:pi-boomerang", "npm:context-mode"];
  const allPresent = injectWorkflow({ packages: required, providers: ["failover"] });
  assert(allPresent.workflow === asset, "all required installed should inject the full asset");
  const missing = injectWorkflow({ packages: required, providers: [] });
  assert(missing.workflow === undefined, "missing pi-failover should withhold the workflow");
});

runCase("CASE 33: a user ORCHESTRATOR.md is injected verbatim even with all four required extensions missing", () => {
  const userText = "# my workflow\ncustom rule\n";
  const result = injectWorkflow({ packages: [], providers: [], userFile: userText });
  assert(
    result.workflow === userText,
    `user workflow was withheld instead of injected verbatim:\n${result.workflow}`,
  );
});

runCase("CASE 34: doctor marks the four required extensions and reports the withheld state", () => {
  const missing = renderDoctorReport({
    available: new Set(),
    workflowSource: "default",
    workflowPath: "/assets/ORCHESTRATOR.example.md",
    failoverFound: false,
    failoverPath: "/none/failover.json",
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

  const present = renderDoctorReport({
    available: new Set(["pi-subagents", "pi-boomerang", "context-mode", "pi-failover", "ask_user"]),
    workflowSource: "default",
    workflowPath: "/assets/ORCHESTRATOR.example.md",
    failoverFound: true,
    failoverPath: "/ok/failover.json",
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

runCase("CASE 35: detectExtensions maps installed packages and providers to capabilities", () => {
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

runCase("CASE 36: detectExtensions returns the four required capabilities only when predicates report present", () => {
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

runCase("CASE 37: the required set is exactly the four, with ask_user excluded", () => {
  const required = missingRequired(new Set());
  const names = required.map((def) => def.capability).sort();
  assert(
    names.join(",") === "context-mode,pi-boomerang,pi-failover,pi-subagents",
    `unexpected required set: ${names.join(",")}`,
  );
  assert(!required.some((def) => def.capability === "ask_user"), "ask_user must not be required");
});

runCase("CASE 38: missing any one required extension withholds; installed packages without tools still inject", () => {
  const asset = readFileSync(join(here, "..", "assets", "ORCHESTRATOR.example.md"), "utf8");
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

runCase("CASE 39: unreadable settings or missing modelRegistry fails open and still injects", () => {
  const asset = readFileSync(join(here, "..", "assets", "ORCHESTRATOR.example.md"), "utf8");

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
    const sections = {};
    onBefore({ systemPromptOptions: { sections } }, {});
    assert(sections.orchestrator_workflow === asset, "missing modelRegistry should fail open and inject");
  } finally {
    process.chdir(prevCwd);
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
  }
  rmSync(agentDir, { recursive: true, force: true });
  rmSync(workDir, { recursive: true, force: true });
});

rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log("ALL PASS");
