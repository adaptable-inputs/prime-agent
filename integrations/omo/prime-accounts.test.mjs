import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const workspace = dirname(fileURLToPath(import.meta.url));
const generator = join(workspace, "configure-prime-omo.mjs");
const installedHelper = join(workspace, "omo-credentials.mjs");
const runtime = "synthetic-runtime";
const now = 2_000_000_000_000;
const fresh = now + 60_000;
const jwt = (account, expires = fresh) => `e30.${Buffer.from(JSON.stringify({
  exp: expires / 1000, "https://api.openai.com/auth": { chatgpt_account_id: account },
})).toString("base64url")}.signature`;
const model = { id: "fixture-model", name: "fixture-model", api: "anthropic-messages",
  reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000, maxTokens: 1000 };
const homes = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function fixture({ env = {}, storedClaude = false, manifest = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "prime-accounts-"));
  homes.push(home);
  const put = (path, value) => {
    const target = join(home, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 });
    return target;
  };
  const tokens = {
    codexDefault: jwt("account-one"), codexOther: jwt("account-two"),
    codexExpired: jwt("account-old", now - 1), kimiDefault: "kimi-one-secret",
    kimiOther: "kimi-two-secret", claudeAmbient: "sk-ant-oat-ambient-value",
    claudeWork: "sk-ant-oat-work-value", claudeEnv: "sk-ant-oat-env-value",
    claudeNumbered: "sk-ant-oat-numbered-value", claudeStored: "sk-ant-oat-stored-value",
    claudeLegacy: "sk-ant-oat-legacy-value",
  };
  const auth = {
    "chatgpt-subscription": { type: "oauth", access: tokens.codexDefault, expires: fresh,
      order: ["default", "login-3"], accounts: [
        { name: "default", access: tokens.codexDefault, expires: fresh },
        { name: "login-2", access: tokens.codexExpired, expires: now - 1 },
        { name: "login-3", access: tokens.codexOther, expires: fresh },
        { name: "login-4", access: tokens.codexExpired, expires: now - 1 },
      ] },
    "kimi-coding": { type: "api_key", key: tokens.kimiDefault, accounts: [
      { name: "default", key: tokens.kimiDefault }, { name: "login-2", key: tokens.kimiOther },
      { name: "duplicate", key: tokens.kimiOther },
    ] },
    "qwen-coder-subscription": { type: "oauth", access: "qwen-old-secret", expires: now - 1 },
  };
  if (storedClaude) {
    auth["anthropic-subscription"] = { type: "oauth", access: "__CLAUDE_SDK_OAUTH__",
      expires: fresh, accounts: [{ name: "second", access: tokens.claudeStored, expires: fresh }] };
    auth["claude-sdk-oauth"] = { type: "oauth", access: tokens.claudeLegacy, expires: fresh };
  }
  put(".omo/agent/auth.json", auth);
  const providers = {
    "chatgpt-subscription": { api: "openai-codex-responses",
      baseUrl: "https://chatgpt.com/backend-api", models: [{ ...model, api: "openai-codex-responses" }] },
    "kimi-coding": { api: "anthropic-messages", baseUrl: "https://api.kimi.ai/coding", models: [model] },
    "qwen-coder-subscription": { api: "openai-completions",
      baseUrl: "https://api.qwen.ai/compatible-mode/v1", models: [{ ...model, api: "openai-completions" }] },
    "literal": { api: "anthropic-messages", baseUrl: "https://api.anthropic.com",
      apiKey: "env:LITERAL_KEY", models: [model] },
  };
  put(".omo/agent/models.json", { providers });
  put(".omo/agent/settings.json", { defaultProvider: "chatgpt-subscription",
    defaultModel: model.id, defaultThinkingLevel: "max" });
  put(".claude/.credentials.json", { claudeAiOauth: {
    accessToken: tokens.claudeAmbient, refreshToken: "never-copy-refresh", expiresAt: fresh,
  } });
  const profile = put("profiles/work.json", { claudeAiOauth: {
    accessToken: tokens.claudeWork, expiresAt: fresh,
  } });
  put("profiles/old.json", { claudeAiOauth: { accessToken: "sk-ant-oat-old-value", expiresAt: now - 1 } });
  put(".prime/agent/models.json", { providers: {}, claudeSubscriptionAccounts: manifest ? {
    work: { profileFile: profile }, old: { profileFile: "~/profiles/old.json" },
    team: { env: "TEAM_CLAUDE_TOKEN" }, absent: { env: "MISSING_CLAUDE_TOKEN" },
  } : {} });
  const helper = put(".prime/agent/omo-credentials.mjs", readFileSync(installedHelper, "utf8"));
  put(`.omo/agent/runtime/${runtime}/node_modules/@earendil-works/pi-ai/dist/providers/all.js`,
    `export const getBuiltinModels = () => ${JSON.stringify([model])};`);
  const clock = put("clock.mjs", `Date.now = () => ${now};`);
  mkdirSync(join(home, ".bun/bin"), { recursive: true });
  symlinkSync(process.execPath, join(home, ".bun/bin/bun"));
  // Do not inherit the workstation's real credential environment.
  const environment = { HOME: home, PATH: process.env.PATH, DO_NOT_TRACK: "1",
    LITERAL_KEY: "literal-fixture-key", TEAM_CLAUDE_TOKEN: tokens.claudeEnv,
    BUN_OPTIONS: `--preload ${clock}`, ...env };
  return { home, helper, tokens, auth, put, environment };
}

function run(args, environment, { input, command = process.execPath } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: environment, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("credential subprocess exceeded bounded timeout"));
    }, 10000);
    child.on("error", (error) => { clearTimeout(deadline); reject(error); });
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => { clearTimeout(deadline); resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}

test("installer refuses implicit replacement of existing configuration", async () => {
  // Given existing Prime configuration.
  const f = fixture();
  const path = join(f.home, ".prime/agent/models.json");
  const before = readFileSync(path, "utf8");
  // When installation is requested without the explicit update flag.
  const result = await run([join(workspace, "install.mjs")], f.environment);
  // Then existing configuration remains byte-identical.
  expect(result.code).not.toBe(0);
  expect(readFileSync(path, "utf8")).toBe(before);
});

test("installer backs up configuration and installs private named and Qwen routes", async () => {
  // Given Omo sources and unrelated Prime preferences.
  const f = fixture();
  f.put(".prime/agent/settings.json", { theme: "fixture-theme" });
  const source = readFileSync(join(f.home, ".omo/agent/auth.json"), "utf8");
  // When the user explicitly updates the integration.
  const result = await run([join(workspace, "install.mjs"), "--update"], f.environment);
  // Then named routes, Qwen OAuth, backups, and preferences all survive.
  expect(result.code, result.stderr).toBe(0);
  const agent = join(f.home, ".prime/agent");
  const config = JSON.parse(readFileSync(join(agent, "models.json"), "utf8"));
  expect(config.providers["qwen-coder-subscription"].apiKey).toContain("qwen-subscription.mjs");
  expect(config.providers["openai-codex-login-3"].apiKey).toContain("--account");
  expect(JSON.parse(readFileSync(join(agent, "settings.json"), "utf8")).theme).toBe("fixture-theme");
  expect(readdirSync(agent).some((name) => name.startsWith("omo-backup-"))).toBe(true);
  expect(statSync(agent).mode & 0o777).toBe(0o700);
  for (const name of ["models.json", "auth.json", "settings.json", "omo-credentials.mjs", "qwen-subscription.mjs"]) {
    expect(statSync(join(agent, name)).mode & 0o777).toBe(0o600);
  }
  expect(readFileSync(join(f.home, ".omo/agent/auth.json"), "utf8")).toBe(source);
  const checked = await run([generator, "--check"], f.environment);
  expect(checked.code, checked.stderr).toBe(0);
});

test("named commands select independent accounts concurrently despite shared selectors", async () => {
  // Given a shared HOME with distinct credentials and conflicting old selectors.
  const f = fixture({ env: {
    PRIME_OMO_ACCOUNT_CHATGPT_SUBSCRIPTION: "login-2", PRIME_OMO_SLOT_CHATGPT_SUBSCRIPTION: "bad",
    PRIME_OMO_ACCOUNT_KIMI_CODING: "unknown", PRIME_OMO_SLOT_KIMI_CODING: "bad",
  } });
  const rendered = await run([generator, "--render"], f.environment);
  expect(rendered.code).toBe(0);
  const config = JSON.parse(rendered.stdout);
  const cases = [
    ["openai-codex-default", f.tokens.codexDefault], ["openai-codex-login-3", f.tokens.codexOther],
    ["kimi-coding-default", f.tokens.kimiDefault], ["kimi-coding-login-2", f.tokens.kimiOther],
    ["claude-subscription-ambient", f.tokens.claudeAmbient],
    ["claude-subscription-profile-work", f.tokens.claudeWork],
    ["claude-subscription-profile-team", f.tokens.claudeEnv],
  ];
  const before = readFileSync(join(f.home, ".omo/agent/auth.json"), "utf8");
  // When all credential commands start before awaiting any result.
  const results = await Promise.all(cases.map(([id]) =>
    run(["-c", config["models.json"].providers[id].apiKey.slice(1)], f.environment, { command: "/bin/bash" })
  ));
  // Then each captures only its own secret, with no diagnostic output or shared writes.
  results.forEach((result, index) => {
    expect({ code: result.code, correctSecret: result.stdout === cases[index][1], stderr: result.stderr })
      .toEqual({ code: 0, correctSecret: true, stderr: "" });
  });
  expect(before === readFileSync(join(f.home, ".omo/agent/auth.json"), "utf8")).toBe(true);
  expect(Object.values(f.tokens).some((secret) => rendered.stdout.includes(secret))).toBe(false);
});

test("expired explicit OAuth accounts fail closed without default fallback or secret logs", async () => {
  // Given usable defaults alongside expired and unknown explicit selections.
  const f = fixture();
  const config = JSON.parse(readFileSync(join(f.home, ".prime/agent/models.json"), "utf8"));
  config.claudeSubscriptionAccounts.expired = { env: "TEAM_CLAUDE_TOKEN", expires: now - 1 };
  f.put(".prime/agent/models.json", config);
  // When independent workers ask for unavailable accounts.
  const results = await Promise.all([
    ["chatgpt-subscription", "login-2"], ["chatgpt-subscription", "login-4"],
    ["chatgpt-subscription", "unknown"], ["anthropic-subscription", "profile-old"],
    ["anthropic-subscription", "profile-absent"], ["anthropic-subscription", "profile-expired"],
  ].map(([provider, account]) => run([f.helper, "key", provider, "--account", account], f.environment)));
  // Then failure contains no token, source exception or refresh attempt.
  expect(results).toEqual(Array(6).fill({ code: 1, stdout: "", stderr: "" }));
});

test("Claude discovery covers stored legacy env ambient and Prime-owned profile references", async () => {
  // Given every supported source, including a sentinel stored default.
  const f = fixture({ storedClaude: true });
  const environment = { ...f.environment, CLAUDE_CODE_OAUTH_TOKEN: f.tokens.claudeEnv,
    CLAUDE_CODE_OAUTH_TOKEN_2: f.tokens.claudeNumbered };
  // When each explicitly discovered account resolves in a subprocess.
  const names = ["omo-second", "legacy-default", "env", "env-2", "ambient", "profile-work", "profile-team"];
  const results = await Promise.all(names.map((name) =>
    run([f.helper, "key", "anthropic-subscription", "--account", name], environment)));
  // Then source names match the public API and no source is copied or refreshed.
  const expected = [f.tokens.claudeStored, f.tokens.claudeLegacy, f.tokens.claudeEnv,
    f.tokens.claudeNumbered, f.tokens.claudeAmbient, f.tokens.claudeWork, f.tokens.claudeEnv];
  expect(results.map((r, i) => ({ code: r.code, correctSecret: r.stdout === expected[i], stderr: r.stderr })))
    .toEqual(names.map(() => ({ code: 0, correctSecret: true, stderr: "" })));
  const discovery = await run(["-e", `const h=await import(${JSON.stringify(f.helper)}); console.log(JSON.stringify(h.accountNames("anthropic-subscription")));`], environment);
  expect(discovery.code).toBe(0);
  expect(JSON.parse(discovery.stdout)).toEqual(["omo-default", "omo-second", "legacy-default",
    "env", "env-2", "ambient", "profile-work", "profile-old", "profile-team", "profile-absent"]);
});

test("sentinel malformed and missing Claude credentials never become usable tokens", async () => {
  // Given no valid ambient credential and malformed or sentinel references.
  const f = fixture({ manifest: false });
  f.put(".claude/.credentials.json", "{ broken");
  const environment = { ...f.environment, CLAUDE_CODE_OAUTH_TOKEN: "__CLAUDE_SDK_OAUTH__",
    CLAUDE_CODE_OAUTH_TOKEN_2: "sk-ant-oat-sentinel", CLAUDE_CODE_OAUTH_TOKEN_3: "not-an-oauth-token" };
  // When the base route and every named source resolve.
  const results = await Promise.all([[], ["--account", "env"], ["--account", "env-2"],
    ["--account", "env-3"], ["--account", "ambient"]]
    .map((selection) => run([f.helper, "key", "anthropic-subscription", ...selection], environment)));
  // Then no fallback invents a credential.
  expect(results).toEqual(Array(5).fill({ code: 1, stdout: "", stderr: "" }));
});

test("manifest rejects embedded secrets and executable references without leaking diagnostics", async () => {
  // Given an invalid Prime-owned profile descriptor.
  const f = fixture();
  f.put(".prime/agent/models.json", { providers: {}, claudeSubscriptionAccounts: {
    malicious: { env: "TEAM_CLAUDE_TOKEN", accessToken: f.tokens.claudeWork },
  } });
  // When a caller asks for a credential and its status.
  const results = await Promise.all(["key", "status"].map((op) =>
    run([f.helper, op, "anthropic-subscription", "--account", "profile-malicious"], f.environment)));
  // Then key capture is empty and status contains only machine-readable failure metadata.
  expect(results[0]).toEqual({ code: 1, stdout: "", stderr: "" });
  expect(JSON.parse(results[1].stdout)).toEqual({
    provider: "anthropic-subscription", available: false, reason: "credential-source-failed",
  });
  expect(results[1].stderr).toBe("");
});

test("generated aliases retain native transport and duplicate names are not distinct account evidence", async () => {
  // Given duplicate named records and native source transports.
  const f = fixture();
  // When configuration and inventory are generated concurrently.
  const [rendered, inventory] = await Promise.all([
    run([generator, "--render"], f.environment), run([generator, "--inventory"], f.environment),
  ]);
  // Then aliases preserve transports, distinct commands, and honest count metadata.
  expect([rendered.code, inventory.code]).toEqual([0, 0]);
  const config = JSON.parse(rendered.stdout);
  const report = JSON.parse(inventory.stdout);
  const providers = config["models.json"].providers;
  expect([providers["openai-codex-login-3"].api, providers["openai-codex-login-3"].baseUrl])
    .toEqual(["openai-codex-responses", "https://chatgpt.com/backend-api"]);
  expect(providers["kimi-coding-login-2"].api).toBe("anthropic-messages");
  expect(providers["claude-subscription-profile-work"].api).toBe("anthropic-messages");
  expect(providers["kimi-coding-login-2"].apiKey !== providers["kimi-coding-duplicate"].apiKey).toBe(true);
  expect(config["auth.json"]["kimi-coding-duplicate"].key).toBe(providers["kimi-coding-duplicate"].apiKey);
  expect(report.namedRoutesRepresentDistinctCredentials).toBe(false);
  expect(Object.keys(providers).some((id) => id.endsWith("-auto"))).toBe(false);
  expect(config["models.json"].claudeSubscriptionAccounts.work.profileFile)
    .toBe(join(f.home, "profiles/work.json"));
});

test("legacy key status and environment selectors remain compatible alongside fixed defaults", async () => {
  // Given legacy callers and an expired Qwen source.
  const f = fixture({ env: { PRIME_OMO_ACCOUNT_KIMI_CODING: "login-2" } });
  // When old and new selector forms run independently.
  const results = await Promise.all([
    run([f.helper, "key", "kimi-coding"], f.environment),
    run([f.helper, "key", "kimi-coding", "--default"], f.environment),
    run([f.helper, "status", "qwen-coder-subscription"], f.environment),
    run([f.helper, "key", "qwen-coder-subscription"], f.environment),
  ]);
  // Then old selectors still work and Qwen remains read-only and expired.
  expect([results[0].stdout === f.tokens.kimiOther, results[1].stdout === f.tokens.kimiDefault])
    .toEqual([true, true]);
  expect(JSON.parse(results[2].stdout)).toEqual({ provider: "qwen-coder-subscription",
    available: false, source: "none", reason: "oauth-expired-no-refresh" });
  expect(results[3]).toEqual({ code: 1, stdout: "", stderr: "" });
});

test("explicit source directory and registry paths work without the default Omo tree", async () => {
  // Given a source directory separate from HOME's default Omo state.
  const f = fixture();
  const source = join(f.home, "separate-source");
  mkdirSync(source);
  for (const name of ["models.json", "auth.json", "settings.json"]) {
    writeFileSync(join(source, name), readFileSync(join(f.home, ".omo/agent", name)));
  }
  const registry = join(f.home, ".omo/agent/runtime", runtime,
    "node_modules/@earendil-works/pi-ai/dist/providers/all.js");
  const explicitRegistry = f.put("explicit-registry.mjs", readFileSync(registry, "utf8"));
  rmSync(join(f.home, ".omo"), { recursive: true });
  const environment = { ...f.environment, PRIME_OMO_SOURCE_DIR: source,
    PRIME_OMO_REGISTRY_PATH: explicitRegistry };
  // When the portable generator and helper resolve through explicit references.
  const [rendered, key] = await Promise.all([
    run([generator, "--render"], environment),
    run([f.helper, "key", "chatgpt-subscription", "--account", "login-3"], environment),
  ]);
  // Then neither path depends on a workstation runtime hash or default source tree.
  expect(rendered.code).toBe(0);
  expect({ code: key.code, correctSecret: key.stdout === f.tokens.codexOther, stderr: key.stderr })
    .toEqual({ code: 0, correctSecret: true, stderr: "" });
});
