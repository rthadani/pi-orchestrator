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

const { renderRoster, loadRoster, findOrchestratorFile, renderDefaultSections, loadWorkflow, default: piRoster } = await import("../extensions/pi-orchestrator.ts");

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
    !/kimi|deepseek|glm|minimax|moonshot|anthropic|openai|failover\//i.test(text),
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

rmSync(tmp, { recursive: true, force: true });

if (failures > 0) {
  console.error(`${failures} case(s) failed`);
  process.exit(1);
}
console.log("ALL PASS");
