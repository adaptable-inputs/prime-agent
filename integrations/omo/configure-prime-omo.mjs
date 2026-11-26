import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

// Inventory, emit apply_patch input, or check. This script never writes files.
const home = homedir();
const agent = process.env.PRIME_OMO_AGENT_DIR ?? join(home, ".prime", "agent");
const omo = process.env.PRIME_OMO_SOURCE_DIR ?? join(home, ".omo", "agent");
let registryPath = process.env.PRIME_OMO_REGISTRY_PATH;
if (!registryPath) {
  const root = join(omo, "runtime");
  const candidates = existsSync(root) ? readdirSync(root).map((name) =>
    join(root, name, "node_modules/@earendil-works/pi-ai/dist/providers/all.js")
  ).filter(existsSync) : [];
  if (candidates.length !== 1) throw new Error("Set PRIME_OMO_REGISTRY_PATH to the pi-ai providers/all.js module");
  [registryPath] = candidates;
}
const registry = await import(registryPath);
const { status, accountNames } = await import(join(agent, "omo-credentials.mjs"));
const source = JSON.parse(readFileSync(join(omo, "models.json"), "utf8"));
const auth = JSON.parse(readFileSync(join(omo, "auth.json"), "utf8"));
const settings = JSON.parse(readFileSync(join(omo, "settings.json"), "utf8"));
const targetId = (id) => id === "chatgpt-subscription" ? "openai-codex" : id;
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const commandFor = (id, account) => `!${[
  process.execPath, join(agent, "omo-credentials.mjs"), "key", id,
  ...(account === undefined ? ["--default"] : ["--account", account]),
].map(quote).join(" ")}`;
const modelFields = new Set([
  "id", "name", "api", "reasoning", "input", "cost", "contextWindow",
  "maxTokens", "headers", "thinkingLevelMap",
]);
const compatFields = {
  "openai-completions": new Set([
    "supportsStore", "supportsDeveloperRole", "supportsReasoningEffort",
    "supportsUsageInStreaming", "maxTokensField", "requiresToolResultName",
    "requiresAssistantAfterToolResult", "requiresThinkingAsText",
    "requiresReasoningContentOnAssistantMessages", "thinkingFormat",
    "openRouterRouting", "vercelGatewayRouting", "zaiToolStream",
    "supportsStrictMode", "cacheControlFormat", "sendSessionAffinityHeaders",
    "supportsLongCacheRetention",
  ]),
  "openai-responses": new Set(["sendSessionIdHeader", "supportsLongCacheRetention"]),
  "openai-codex-responses": new Set(["sendSessionIdHeader", "supportsLongCacheRetention"]),
  "anthropic-messages": new Set([
    "supportsEagerToolInputStreaming", "supportsLongCacheRetention", "requiresThinkingSignature",
  ]),
};
const dropped = {};
const note = (id, field) => (dropped[id] ??= new Set()).add(field);
const providers = {};
const targetAuth = {};
const inventory = [];
const aliases = [];
const subscriptionIds = new Set(["anthropic-subscription", "claude-sdk-oauth"]);
const ids = [...new Set([...Object.keys(source.providers), ...Object.keys(auth)])]
  .filter((id) => !subscriptionIds.has(id));
for (const id of ids) {
  if (!/^[a-z0-9-]+$/.test(id)) throw new Error("Unexpected source provider ID");
  const custom = source.providers[id] ?? {};
  const origin = id.startsWith("anthropic-") ? "anthropic" : id;
  const sourceModels = custom.models ?? registry.getBuiltinModels(origin);
  const rows = sourceModels.filter((model) => !model.upstreamModelId);
  if (!rows.length) throw new Error(`No source models: ${id}`);
  const api = custom.api ?? rows[0].api;
  const baseUrl = custom.baseUrl ?? rows[0].baseUrl;
  if (!compatFields[api] || !baseUrl) throw new Error(`Unsupported route: ${id}`);
  // Prime's custom loader consumes provider compat, not models[].compat.
  // Promote only fields identical across every model; report differences.
  const compat = {};
  for (const key of new Set(rows.flatMap((model) => Object.keys(model.compat ?? {})))) {
    const value = rows[0].compat?.[key];
    if (!compatFields[api].has(key)) {
      note(id, `compat.${key}`);
    } else if (value !== undefined && rows.every((model) =>
      isDeepStrictEqual(model.compat?.[key], value)
    )) {
      compat[key] = value;
    } else {
      note(id, `per-model-compat.${key}`);
    }
  }
  for (const [key, value] of Object.entries(custom.compat ?? {})) {
    if (compatFields[api].has(key)) compat[key] = value;
    else note(id, `compat.${key}`);
  }
  const command = commandFor(id);
  const models = rows.map((row) => {
    const result = {};
    for (const [key, value] of Object.entries(row)) {
      if (["provider", "baseUrl", "type", "compat", "upstreamModelId", "serviceTier"].includes(key)) continue;
      if (modelFields.has(key)) result[key] = value;
      else note(id, key);
    }
    // A custom provider URL overrides the registry URL, as it does in Omo.
    if (!custom.baseUrl && row.baseUrl && row.baseUrl !== baseUrl) result.baseUrl = row.baseUrl;
    return result;
  });
  providers[targetId(id)] = {
    baseUrl, api, apiKey: command,
    ...(custom.headers ? { headers: custom.headers } : {}),
    ...(custom.authHeader !== undefined ? { authHeader: custom.authHeader } : {}),
    ...(Object.keys(compat).length ? { compat } : {}),
    models,
  };
  targetAuth[targetId(id)] = { type: "api_key", key: command };
  for (const alias of sourceModels.filter((model) => model.upstreamModelId)) {
    if (!rows.some((row) => row.id === alias.upstreamModelId)) throw new Error("Missing canonical model");
    const eligible = alias.upstreamModelId === "gpt-5.4" ||
      alias.upstreamModelId === "gpt-5.5" ||
      alias.upstreamModelId === "gpt-5.6" ||
      alias.upstreamModelId === "gpt-6-astra" ||
      alias.upstreamModelId.startsWith("gpt-5.6-");
    aliases.push({
      sourceProvider: id, sourceModel: alias.id,
      targetProvider: targetId(id), targetModel: alias.upstreamModelId,
      tier: alias.serviceTier,
      supported: alias.serviceTier === "priority" && eligible,
      selection: alias.serviceTier === "priority" && eligible ? "/tier priority" : null,
    });
  }
  inventory.push({
    sourceProvider: id, targetProvider: targetId(id),
    custom: Object.hasOwn(source.providers, id), storedAuth: Object.hasOwn(auth, id),
    sourceModels: sourceModels.length, configuredModels: rows.length, api, baseUrl,
    credential: status(id),
    accounts: (auth[id]?.accounts ?? []).map((account) => ({
      name: account.name, credential: status(id, { account: account.name }),
    })),
    order: auth[id]?.order ?? [],
    slots: Object.keys(custom.credentials?.slots ?? {}).map((slot) => ({
      name: slot, credential: status(id, { slot }),
    })),
    rotationRequested: custom.credentials?.rotation === true,
    affinityRequested: custom.credentials?.affinity,
  });
}
const qwenPath = join(agent, "qwen-subscription.mjs");
if (existsSync(qwenPath) && providers["qwen-coder-subscription"]) {
  const qwen = await import(qwenPath);
  const command = `!${[process.execPath, qwenPath, "key"].map(quote).join(" ")}`;
  Object.assign(providers["qwen-coder-subscription"], {
    api: "openai-completions",
    baseUrl: qwen.GATEWAY,
    apiKey: command,
    authHeader: true,
    headers: { ...providers["qwen-coder-subscription"].headers, ...qwen.INFERENCE_HEADERS },
  });
  targetAuth["qwen-coder-subscription"] = { type: "api_key", key: command };
  inventory.find((row) => row.sourceProvider === "qwen-coder-subscription").credential =
    qwen.status({ directory: agent, omoAuthPath: join(omo, "auth.json") });
}
const namedRoutes = [];
for (const id of ["chatgpt-subscription", "kimi-coding"]) {
  const base = providers[targetId(id)];
  if (!base) continue;
  for (const account of accountNames(id)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(account)) throw new Error("Unexpected account name");
    const alias = `${targetId(id)}-${account}`;
    if (providers[alias]) throw new Error("Account provider collision");
    const command = commandFor(id, account);
    providers[alias] = { ...base, apiKey: command };
    targetAuth[alias] = { type: "api_key", key: command };
    namedRoutes.push({ sourceProvider: id, account, targetProvider: alias,
      credential: status(id, { account }) });
  }
}
const claudeModels = registry.getBuiltinModels("anthropic").map((row) =>
  Object.fromEntries(Object.entries(row).filter(([key]) => modelFields.has(key)))
);
const claudeBase = {
  api: "anthropic-messages", baseUrl: "https://api.anthropic.com",
  apiKey: commandFor("anthropic-subscription"), models: claudeModels,
};
providers["claude-subscription"] = claudeBase;
targetAuth["claude-subscription"] = { type: "api_key", key: claudeBase.apiKey };
for (const account of accountNames("anthropic-subscription")) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(account)) throw new Error("Unexpected Claude account name");
  const alias = `claude-subscription-${account}`;
  if (providers[alias]) throw new Error("Claude provider collision");
  const command = commandFor("anthropic-subscription", account);
  providers[alias] = { ...claudeBase, apiKey: command };
  targetAuth[alias] = { type: "api_key", key: command };
  namedRoutes.push({ sourceProvider: "anthropic-subscription", account, targetProvider: alias,
    credential: status("anthropic-subscription", { account }) });
}
const primeModelsPath = join(agent, "models.json");
const claudeSubscriptionAccounts = existsSync(primeModelsPath)
  ? JSON.parse(readFileSync(primeModelsPath, "utf8")).claudeSubscriptionAccounts ?? {} : {};
const desired = {
  "models.json": { providers, claudeSubscriptionAccounts },
  "auth.json": targetAuth,
  "settings.json": {
    defaultProvider: targetId(settings.defaultProvider),
    defaultModel: settings.defaultModel,
    defaultThinkingLevel: settings.defaultThinkingLevel,
  },
};
const serialized = JSON.stringify(desired);
function forbidSecrets(value, key = "") {
  if (value && typeof value === "object") {
    for (const [name, child] of Object.entries(value)) forbidSecrets(child, name);
  } else if (typeof value === "string" && value.length > 8 &&
    /^(key|access|refresh|accessToken|refreshToken)$/.test(key) && serialized.includes(value)) {
    throw new Error("Refusing embedded source credential");
  }
}
forbidSecrets(auth);
for (const id of ids) {
  const sourceKey = source.providers[id]?.apiKey;
  if (typeof sourceKey === "string" && sourceKey.length > 8 &&
    !sourceKey.startsWith("!") && serialized.includes(sourceKey)) throw new Error("Embedded source key");
}
for (const config of Object.values(providers)) {
  for (const model of config.models) {
    if (!model.id || !Number.isFinite(model.contextWindow) || model.contextWindow <= 0 ||
      !Number.isFinite(model.maxTokens) || model.maxTokens <= 0) throw new Error("Invalid model limits");
  }
}
if (!providers[desired["settings.json"].defaultProvider]?.models.some(
  (model) => model.id === settings.defaultModel
)) throw new Error("Default model missing");
const report = {
  customProviders: Object.keys(source.providers).length,
  authProviders: Object.keys(auth).length,
  sourceProviders: ids.length,
  configuredProviders: Object.keys(providers).length,
  sourceModels: inventory.reduce((sum, row) => sum + row.sourceModels, 0),
  originalConfiguredModels: inventory.reduce((sum, row) => sum + row.configuredModels, 0),
  configuredModels: Object.values(providers).reduce((sum, row) => sum + row.models.length, 0),
  availableCredentialProviders: inventory.filter((row) => row.credential.available).length,
  accountPools: inventory.filter((row) => row.accounts.length).length,
  namedAccountRecords: inventory.reduce((sum, row) => sum + row.accounts.length, 0),
  credentialSlots: inventory.reduce((sum, row) => sum + row.slots.length, 0),
  recommendedDefault: desired["settings.json"],
  namedRoutes,
  namedRouteCount: namedRoutes.length,
  namedRoutesRepresentDistinctCredentials: false,
  runtimeRegistry: registryPath,
  ambientClaudeSdk: {
    sourceProvider: "anthropic-subscription",
    enabled: settings.anthropicSubscriptionProvider?.enabled === true,
    tokenInjection: settings.anthropicSubscriptionProvider?.tokenInjection,
    maxUsagePercent: settings.anthropicSubscriptionProvider?.maxUsagePercent,
    sourceModels: registry.getBuiltinModels("anthropic").length,
    targetProvider: "claude-subscription",
    transport: "native-anthropic-oauth",
    credential: status("anthropic-subscription", { fixed: true }),
    status: "configured-native-oauth-read-only",
  },
  providers: inventory, servingAliases: aliases,
  droppedFields: Object.fromEntries(Object.entries(dropped).map(([id, fields]) => [id, [...fields].sort()])),
};
const operation = process.argv[2] ?? "--check";
if (operation === "--patch") {
  const patch = ["*** Begin Patch"];
  for (const [name, value] of Object.entries(desired)) {
    if (name === "settings.json") continue;
    const path = join(agent, name);
    const next = JSON.stringify(value, null, 2);
    if (existsSync(path)) {
      const previous = readFileSync(path, "utf8");
      if (isDeepStrictEqual(JSON.parse(previous), value)) continue;
      patch.push(`*** Update File: ${path}`, "@@",
        ...previous.trimEnd().split("\n").map((line) => `-${line}`),
        ...next.split("\n").map((line) => `+${line}`));
    } else {
      patch.push(`*** Add File: ${path}`, ...next.split("\n").map((line) => `+${line}`));
    }
  }
  patch.push("*** End Patch");
  process.stdout.write(`${patch.join("\n")}\n`);
} else if (operation === "--render") {
  process.stdout.write(`${JSON.stringify(desired, null, 2)}\n`);
} else if (operation === "--check" || operation === "--inventory") {
  if (operation === "--check") {
    for (const [name, expected] of Object.entries(desired)) {
      const actual = JSON.parse(readFileSync(join(agent, name), "utf8"));
      const comparable = name === "settings.json"
        ? Object.fromEntries(Object.keys(expected).map((key) => [key, actual[key]])) : actual;
      if (!isDeepStrictEqual(comparable, expected)) {
        throw new Error(`Configuration differs: ${name}`);
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ checked: operation === "--check", ...report }, null, 2)}\n`);
} else {
  throw new Error("Usage: configure-prime-omo.mjs --check|--inventory|--patch|--render");
}
