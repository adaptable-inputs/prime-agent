import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Read-only bridge. Never execute source commands, refresh OAuth, or write state.
const home = homedir();
const omo = process.env.PRIME_OMO_SOURCE_DIR ?? join(home, ".omo", "agent");
const agent = process.env.PRIME_OMO_AGENT_DIR ?? join(home, ".prime", "agent");
const readJson = (name) => JSON.parse(readFileSync(join(omo, name), "utf8"));
const fileValue = (path) =>
  readFileSync(path.replace(/^~\//, `${home}/`), "utf8").trim();
const readOptionalJson = (path) => existsSync(path)
  ? JSON.parse(readFileSync(path, "utf8")) : {};

function usable(value) {
  return typeof value === "string" && value.trim() !== "" &&
    !/^(?:undefined|null|none|oauth|ambient|anthropic-subscription|claude-sdk-oauth|__.*__)$/i.test(value.trim()) &&
    !/(?:^|[-_])(sentinel|placeholder|redacted)(?:$|[-_])/i.test(value);
}

// Descriptors contain references, never copied credentials. This field belongs to
// Prime's models.json; the native loader ignores unknown top-level fields.
export function claudeAccounts() {
  const auth = readJson("auth.json");
  const manifest = readOptionalJson(join(agent, "models.json"))
    .claudeSubscriptionAccounts ?? {};
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("invalid-claude-manifest");
  }
  const accounts = [];
  for (const [provider, prefix] of [
    ["anthropic-subscription", "omo"], ["claude-sdk-oauth", "legacy"],
  ]) {
    if (!auth[provider]) continue;
    for (const account of new Set(["default", ...(auth[provider].accounts ?? []).map((row) => row.name)])) {
      accounts.push({ name: `${prefix}-${account}`, provider, account });
    }
  }
  for (const name of Object.keys(process.env).filter((key) =>
    /^CLAUDE_CODE_OAUTH_TOKEN(?:_[1-9]\d*)?$/.test(key)
  ).sort((a, b) => a.localeCompare(b, "en", { numeric: true }))) {
    accounts.push({ name: name === "CLAUDE_CODE_OAUTH_TOKEN" ? "env" : `env-${name.split("_").at(-1)}`, env: name });
  }
  accounts.push({ name: "ambient", profileFile: join(home, ".claude", ".credentials.json") });
  for (const [name, reference] of Object.entries(manifest)) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name) || !reference ||
      typeof reference !== "object" || Array.isArray(reference) ||
      Object.keys(reference).some((key) => !["profileFile", "env", "expires"].includes(key)) ||
      Number(typeof reference.profileFile === "string") + Number(typeof reference.env === "string") !== 1 ||
      (reference.profileFile !== undefined && !/^(?:\/|~\/)/.test(reference.profileFile)) ||
      (reference.env !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(reference.env)) ||
      (reference.expires !== undefined && !Number.isFinite(reference.expires))) {
      throw new Error("invalid-claude-profile-reference");
    }
    accounts.push({ name: `profile-${name}`, ...reference });
  }
  return accounts;
}

export function accountNames(provider) {
  if (["anthropic-subscription", "claude-sdk-oauth"].includes(provider)) {
    return claudeAccounts().map((row) => row.name);
  }
  const stored = readJson("auth.json")[provider];
  return stored ? [...new Set(["default", ...(stored.accounts ?? []).map((row) => row.name)])] : [];
}

function claudeCredential(account) {
  const accounts = claudeAccounts();
  const candidates = account ? accounts.filter((row) => row.name === account) : accounts;
  if (!candidates.length) throw new Error("unknown-account");
  for (const candidate of candidates) {
    if (candidate.expires !== undefined && candidate.expires <= Date.now()) continue;
    try {
      let value, expires = candidate.expires;
      if (candidate.provider) {
        const stored = readJson("auth.json")[candidate.provider];
        const selected = candidate.account === "default" ? stored :
          stored.accounts?.find((row) => row.name === candidate.account);
        value = selected?.access ?? selected?.accessToken ?? resolveSource(selected?.key);
        expires = selected?.expires ?? selected?.expiresAt;
        // Stored OAuth accounts and profile files must declare expiry.
        if (!Number.isFinite(expires)) continue;
      } else if (candidate.profileFile) {
        const profile = JSON.parse(fileValue(candidate.profileFile)).claudeAiOauth;
        value = profile?.accessToken;
        expires = profile?.expiresAt;
        if (!Number.isFinite(expires)) continue;
      } else {
        value = process.env[candidate.env]?.trim();
      }
      if (!usable(value) || !/^sk-ant-oat[A-Za-z0-9_-]+$/.test(value) ||
        (expires !== undefined && expires <= Date.now())) continue;
      return { value, source: `account:${candidate.name}`, ...(expires === undefined ? {} : { expires }) };
    } catch {
      // One broken read-only source must not hide the other discovered profiles.
      // Explicit selection has just one candidate and never falls back.
    }
  }
  return { value: "", source: "none", reason: "claude-oauth-unavailable-no-refresh" };
}

function resolveSource(value) {
  if (typeof value !== "string") return "";
  const cat = value.match(/^!cat ([^;\n|&<>]+)$/);
  if (cat) return fileValue(cat[1]);
  // Omo's Anthropic expiry selector: parse its data, never evaluate its script.
  const selector = value.match(/^!bun -e 'const entries=(\[\[.*?\]\]);const today=/);
  if (selector) {
    const today = new Date().toISOString().slice(0, 10);
    const entries = JSON.parse(selector[1]);
    if (!entries.every((row) =>
      Array.isArray(row) && row.length === 2 &&
      /^\d{4}-\d{2}-\d{2}$/.test(row[0]) && typeof row[1] === "string"
    )) throw new Error("invalid-selector");
    const entry = entries.find(([expires]) => today < expires);
    return entry ? fileValue(entry[1]) : "";
  }
  if (value.startsWith("!")) throw new Error("unsupported-source-command");
  if (value.startsWith("file:")) return fileValue(value.slice(5));
  if (value.startsWith("env:")) return process.env[value.slice(4)]?.trim() ?? "";
  return (process.env[value] ?? value).trim();
}

export function credential(provider, selection = {}) {
  if (provider === "anthropic-subscription" || provider === "claude-sdk-oauth") {
    if (selection.slot) throw new Error("unknown-slot");
    return claudeCredential(selection.account);
  }
  const models = readJson("models.json").providers;
  const auth = readJson("auth.json");
  if (!Object.hasOwn(models, provider) && !Object.hasOwn(auth, provider)) {
    throw new Error("unknown-provider");
  }
  const config = models[provider] ?? {};
  const stored = auth[provider];
  const suffix = provider.toUpperCase().replaceAll("-", "_");
  // An explicit selector is immutable, including against the *other* legacy
  // environment selector. Unqualified calls retain the old environment behavior.
  const explicit = Object.hasOwn(selection, "account") || Object.hasOwn(selection, "slot") || selection.fixed;
  const account = explicit ? selection.account : process.env[`PRIME_OMO_ACCOUNT_${suffix}`];
  const slot = explicit ? selection.slot : process.env[`PRIME_OMO_SLOT_${suffix}`];
  if (account && slot) throw new Error("choose-account-or-slot");
  if (slot) {
    const entry = config.credentials?.slots?.[slot];
    if (!entry) throw new Error("unknown-slot");
    return { value: resolveSource(entry.value), source: `slot:${slot}` };
  }
  if (!account && config.apiKey !== undefined) {
    return { value: resolveSource(config.apiKey), source: "models.apiKey" };
  }
  const names = account ? [account] : stored?.order?.length ? stored.order : ["default"];
  for (const name of names) {
    const selected = name === "default"
      ? stored
      : stored?.accounts?.find((entry) => entry.name === name);
    if (!selected) throw new Error("unknown-account");
    if (stored.type === "oauth") {
      if (!Number.isFinite(selected.expires) || selected.expires <= Date.now()) continue;
      const value = selected.access?.trim() ?? "";
      if (!usable(value)) continue;
      return {
        value,
        source: `account:${name}`,
        expires: selected.expires,
      };
    }
    return { value: resolveSource(selected.key), source: `account:${name}` };
  }
  return { value: "", source: "none", reason: "oauth-expired-no-refresh" };
}

export function status(provider, selection = {}) {
  try {
    const { value, ...metadata } = credential(provider, selection);
    return { provider, available: usable(value), ...metadata };
  } catch {
    return { provider, available: false, reason: "credential-source-failed" };
  }
}

if (import.meta.main) {
  const [operation, provider, flag, name, ...extra] = process.argv.slice(2);
  const valid = flag === undefined || (flag === "--default" && name === undefined) ||
    (["--account", "--slot"].includes(flag) && typeof name === "string" && name.length > 0);
  const selection = flag === "--default" ? { fixed: true } :
    flag === "--account" ? { account: name } : flag === "--slot" ? { slot: name } : {};
  if (!["key", "status"].includes(operation) || !provider || !valid || extra.length) {
    process.stderr.write("Usage: omo-credentials.mjs key|status SOURCE_PROVIDER [--default|--account NAME|--slot NAME]\n");
    process.exitCode = 2;
  } else if (operation === "status") {
    process.stdout.write(`${JSON.stringify(status(provider, selection))}\n`);
  } else {
    try {
      const result = credential(provider, selection);
      if (!usable(result.value)) process.exitCode = 1;
      else process.stdout.write(result.value);
    } catch {
      // Never expose source values, subprocess output, or exception details.
      process.exitCode = 1;
    }
  }
}
