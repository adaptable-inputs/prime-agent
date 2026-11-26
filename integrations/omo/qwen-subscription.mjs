import {
  closeSync, constants, fchmodSync, fsyncSync, fstatSync, mkdirSync,
  openSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export const PROVIDER = "qwen-coder-subscription";
export const SOURCE_PROVIDER = "qwen-coder-subscription";
export const AUTH_ORIGIN = "https://auth.qwen.ai";
export const CLIENT_ID = "qwen-code-cli";
export const GATEWAY = "https://api.qwen.ai/compatible-mode/v1";
export const INFERENCE_HEADERS = {
  "User-Agent": `QwenCode/unknown (${process.platform}; ${process.arch})`,
};
const oauthCodes = new Set([
  "authorization_pending", "slow_down", "access_denied", "expired_token",
  "invalid_grant", "invalid_client", "invalid_request", "invalid_scope",
  "unsupported_grant_type", "temporarily_unavailable", "server_error",
]);
const paid = (type) => typeof type === "string" && /^(plus|pro)$/i.test(type);
const text = (value) => typeof value === "string" && value.trim().length > 0 &&
  !/[\r\n\0]/.test(value);
const positive = (value) => Number.isFinite(value) && value > 0;

// Only client-owned codes reach logs. Server descriptions and thrown messages may
// contain credentials, HTML, or device codes and must never be copied to errors.
export class QwenSubscriptionError extends Error {
  constructor(code, stage, status, retryAfterMs) {
    super(`Qwen subscription: ${stage}/${code}${status ? ` (HTTP ${status})` : ""}`);
    this.name = "QwenSubscriptionError";
    Object.assign(this, { code, stage, status, retryAfterMs });
  }
}
const failure = (code, stage, status, retryAfterMs) =>
  new QwenSubscriptionError(code, stage, status, retryAfterMs);
const safeError = (error, stage) => error instanceof QwenSubscriptionError ? error :
  failure(error?.name === "AbortError" ? "cancelled" :
    error?.name === "TimeoutError" ? "request_timeout" : "operation_failed", stage);

function paths(options) {
  const directory = options.directory ?? process.env.PRIME_OMO_AGENT_DIR ??
    join(homedir(), ".prime", "agent");
  return {
    directory,
    file: join(directory, "qwen-subscription.json"),
    lock: join(directory, "qwen-subscription.lock"),
    omo: options.omoAuthPath === undefined
      ? join(process.env.PRIME_OMO_SOURCE_DIR ?? join(homedir(), ".omo", "agent"), "auth.json")
      : options.omoAuthPath,
  };
}

function readJson(path, privateFile = false) {
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (privateFile && (stat.mode & 0o077))) {
      throw failure("credentials_insecure", "storage");
    }
    return JSON.parse(readFileSync(fd, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw safeError(error, "storage");
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function validTokens(tokens) {
  return tokens && text(tokens.access_token) && text(tokens.refresh_token) &&
    tokens.token_type === "Bearer" && typeof tokens.scope === "string" &&
    positive(tokens.expires_in) && positive(tokens.expiresAt);
}

function readState(options) {
  const state = readJson(paths(options).file, true);
  if (!state) return null;
  if (state.version !== 1 || state.authOrigin !== (options.authOrigin ?? AUTH_ORIGIN) ||
    state.clientId !== CLIENT_ID || state.gateway !== (options.gateway ?? GATEWAY) ||
    !text(state.revision) || (state.tokens !== undefined && !validTokens(state.tokens))) {
    throw failure("credentials_invalid", "storage");
  }
  return state;
}

function fallback(options) {
  const path = paths(options).omo;
  if (!path) return null;
  const auth = readJson(path);
  const record = auth?.[SOURCE_PROVIDER];
  if (record?.type !== "oauth" || !text(record.access) ||
    !Number.isFinite(record.expires)) return null;
  // The returned object deliberately excludes Omo's rotating refresh token.
  return { access: record.access, expires: record.expires };
}

// Synchronous and offline so the existing config generator can import it. An Omo
// token is not declared usable until key() checks modern membership and gateway.
export function status(options = {}) {
  try {
    const state = readState(options);
    const now = (options.now ?? Date.now)();
    if (state?.tokens) {
      const unexpired = state.tokens.expiresAt > now;
      return {
        provider: PROVIDER, source: "prime", signedIn: true,
        available: paid(state.memberType),
        accessValid: unexpired, refreshable: true,
        expires: state.tokens.expiresAt,
        memberType: state.memberType ?? null,
        reason: !paid(state.memberType) ? "membership_unverified_or_unpaid" :
          unexpired ? "ready" : "refresh_required",
      };
    }
    const source = fallback(options);
    return {
      provider: PROVIDER, source: source ? "omo-read-only" : "none",
      signedIn: false, available: false, refreshable: false,
      ...(source ? { expires: source.expires } : {}),
      reason: source ? source.expires <= now ? "omo_oauth_expired" :
        "omo_compatibility_unverified" : state?.invalidReason ?? "login_required",
    };
  } catch (error) {
    return {
      provider: PROVIDER, source: "none", signedIn: false, available: false,
      refreshable: false, reason: safeError(error, "storage").code,
    };
  }
}

function writeState(options, state) {
  const { directory, file } = paths(options);
  const temporary = join(directory, `.qwen-subscription-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT |
      constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, file);
  } catch (error) {
    throw safeError(error, "storage");
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temporary); } catch (error) {
      if (error?.code !== "ENOENT") throw safeError(error, "storage");
    }
  }
}

// Linux flock owns the kernel lock, not a PID/age heuristic. A holder dying closes
// stdin and releases it; contenders re-read rotated credentials after acquiring.
async function locked(options, run) {
  const { directory, lock } = paths(options);
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const fd = openSync(lock, constants.O_CREAT | constants.O_RDWR |
      constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    closeSync(fd);
    const holder = spawn("/usr/bin/flock", [
      "-x", "-w", "35", lock, process.execPath, "-e",
      "process.stdin.resume(); process.stdout.write('locked\\n');",
    ], { stdio: ["pipe", "pipe", "ignore"] });
    const exited = new Promise((resolve) => {
      holder.once("error", () => resolve(-1));
      holder.once("exit", (code) => resolve(code ?? -1));
    });
    try {
      await new Promise((resolve, reject) => {
        holder.once("error", () => reject(failure("lock_failed", "storage")));
        holder.stdout.once("data", () => resolve());
        holder.once("exit", () => reject(failure("lock_timeout", "storage")));
      });
      return await run();
    } finally {
      holder.stdin.end();
      await exited;
    }
  } catch (error) {
    throw safeError(error, "storage");
  }
}

export function createQwenSubscription(options = {}) {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? ((ms, signal) => delay(ms, undefined, { signal }));
  const fetcher = options.fetch ?? fetch;
  const authOrigin = options.authOrigin ?? AUTH_ORIGIN;
  const gateway = options.gateway ?? GATEWAY;
  // Endpoint injection is exclusively for local fixtures, never environment or
  // command-line overrides that could send production grants to another origin.
  for (const [actual, production] of [[authOrigin, AUTH_ORIGIN], [gateway, GATEWAY]]) {
    const url = new URL(actual);
    if (actual !== production &&
      !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname))) {
      throw failure("unsupported_endpoint", "configuration");
    }
  }
  const baseState = () => ({
    version: 1, authOrigin, clientId: CLIENT_ID, gateway, revision: randomUUID(),
  });

  async function request(stage, url, { form, token, signal } = {}) {
    const timeout = AbortSignal.timeout(options.requestTimeoutMs ?? 30_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetcher(url, {
        method: form ? "POST" : "GET", redirect: "error", signal: combined,
        headers: {
          Accept: "application/json",
          ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(url.startsWith(`${gateway}/`) ? INFERENCE_HEADERS : {}),
        },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}),
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        const value = response.headers.get("Retry-After");
        const retryAfterMs = value === null ? undefined :
          Math.max(0, Number.isFinite(Number(value)) ? Number(value) * 1000 : Date.parse(value) - now());
        throw failure(oauthCodes.has(data?.error) ? data.error : "http_error",
          stage, response.status, Number.isFinite(retryAfterMs) ? retryAfterMs : undefined);
      }
      return data;
    } catch (error) {
      if (combined.aborted) throw failure(signal?.aborted ? "cancelled" : "request_timeout", stage);
      throw safeError(error, stage);
    }
  }

  function tokens(data) {
    const result = { ...data, expiresAt: now() + data?.expires_in * 1000 };
    if (!validTokens(result)) throw failure("invalid_response", "token");
    // Do not persist arbitrary response properties, even on successful responses.
    return Object.fromEntries(["access_token", "refresh_token", "token_type", "scope",
      "expires_in", "expiresAt"].map((key) => [key, result[key]]));
  }

  async function cooldownRequest(stage, run) {
    const state = readState(options);
    const remaining = (state?.retryAfter?.[stage] ?? 0) - now();
    if (remaining > 0) throw failure("rate_limited", stage, 429, remaining);
    try {
      return await run();
    } catch (error) {
      if (error.status === 429 && error.retryAfterMs > 0) {
        const current = readState(options) ?? baseState();
        current.retryAfter = { ...current.retryAfter, [stage]: now() + error.retryAfterMs };
        writeState(options, current);
      }
      throw error;
    }
  }

  async function access(signal) {
    return locked(options, async () => {
      const state = readState(options);
      if (!state?.tokens) return null;
      if (state.tokens.expiresAt <= now() + 30_000) {
        try {
          const next = await cooldownRequest("refresh", () => request("refresh",
            `${authOrigin}/api/oauth/token`, {
              signal, form: {
                grant_type: "refresh_token", client_id: CLIENT_ID,
                refresh_token: state.tokens.refresh_token,
              },
            }));
          state.tokens = tokens(next);
          writeState(options, state);
        } catch (error) {
          if (error.code === "invalid_grant" && error.stage === "refresh") {
            delete state.tokens;
            delete state.memberType;
            state.invalidReason = "refresh_invalid_grant";
            writeState(options, state);
          }
          throw error;
        }
      }
      return { token: state.tokens.access_token, revision: state.revision, memberType: state.memberType };
    });
  }

  async function membership(token, signal) {
    const info = await request("userinfo", `${authOrigin}/api/oauth/userinfo`, { token, signal });
    if (!text(info?.sub) || !text(info?.member_type)) throw failure("invalid_response", "userinfo");
    return info.member_type;
  }

  async function check(signal) {
    const current = await access(signal);
    if (!current) throw failure("login_required", "credentials");
    const memberType = await membership(current.token, signal);
    await locked(options, async () => {
      const state = readState(options);
      if (state?.revision !== current.revision || !state.tokens) throw failure("session_changed", "credentials");
      state.memberType = memberType;
      writeState(options, state);
    });
    return status(options);
  }

  async function key({ signal } = {}) {
    const current = await access(signal);
    if (current) {
      if (current.memberType === undefined) {
        await check(signal);
        // Re-read: another process may have rotated tokens during membership.
        return key({ signal });
      }
      if (!paid(current.memberType)) throw failure("subscription_required", "membership");
      return current.token;
    }
    const source = fallback(options);
    if (!source) throw failure("login_required", "credentials");
    if (source.expires <= now()) throw failure("omo_oauth_expired", "credentials");
    if (!paid(await membership(source.access, signal))) {
      throw failure("subscription_required", "membership");
    }
    // Modern userinfo and gateway acceptance are both required, so a legacy
    // unexpired OAuth token cannot silently become a paid subscription credential.
    const catalog = await request("models", `${gateway}/models`, { token: source.access, signal });
    if (!Array.isArray(catalog?.data) || !catalog.data.length ||
      !catalog.data.every((model) => text(model?.id))) throw failure("invalid_response", "models");
    if (source.expires <= now()) throw failure("omo_oauth_expired", "credentials");
    return source.access;
  }

  async function login({ onDevice = () => {}, signal } = {}) {
    const attempt = randomUUID();
    await locked(options, async () => {
      const state = readState(options) ?? baseState();
      state.signInAttempt = attempt;
      writeState(options, state);
    });
    const issuedAt = now();
    const device = await locked(options, () => cooldownRequest("device", () =>
      request("device", `${authOrigin}/api/oauth/device/code`, {
        signal, form: { client_id: CLIENT_ID, scope: "model:invoke profile:read" },
      })));
    if (!text(device?.device_code) || !/^[A-Za-z0-9-]+$/.test(device?.user_code ?? "") ||
      !positive(device.expires_in) || !positive(device.interval)) {
      throw failure("invalid_response", "device");
    }
    const expiresAt = issuedAt + device.expires_in * 1000;
    const verification = new URL("https://chat.qwen.ai/authorize");
    for (const [name, value] of Object.entries({
      user_code: device.user_code, client: "cli", entry: "qwen_code", paywallScene: "cli",
    })) verification.searchParams.set(name, value);
    onDevice({
      userCode: device.user_code, verificationUri: verification.toString(), expiresAt,
    });
    let interval = device.interval * 1000;
    let wait = interval;
    let grant;
    while (now() < expiresAt) {
      signal?.throwIfAborted();
      await schedule(Math.min(wait, expiresAt - now()), signal);
      if (now() >= expiresAt) break;
      try {
        const bounded = AbortSignal.timeout(Math.max(1, Math.ceil(expiresAt - now())));
        grant = tokens(await request("exchange", `${authOrigin}/api/oauth/token`, {
          signal: signal ? AbortSignal.any([signal, bounded]) : bounded,
          form: {
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            client_id: CLIENT_ID, device_code: device.device_code,
          },
        }));
        break;
      } catch (error) {
        if (error.status === 400 && error.code === "authorization_pending") wait = interval;
        else if (error.status === 400 && error.code === "slow_down") {
          interval += 5000;
          wait = interval;
        } else if (error.status === 429 || error.status >= 500 ||
          ["operation_failed", "request_timeout"].includes(error.code)) {
          wait = Math.max(interval, wait * 2, error.retryAfterMs ?? 0);
        } else throw error;
      }
    }
    if (!grant || now() >= expiresAt) throw failure("expired_token", "exchange");
    await locked(options, async () => {
      const previous = readState(options);
      if (previous?.signInAttempt !== attempt) throw failure("session_changed", "credentials");
      writeState(options, { ...baseState(), revision: attempt, tokens: grant });
    });
    // Save the independent rotating pair before membership; a temporary userinfo
    // failure can be recovered with status --online without repeating login.
    return check(signal);
  }

  return { login, key, check, status: () => status(options) };
}

export async function runCli(args, options = {}, io = process) {
  const [command, flag, ...extra] = args;
  if (!["login", "status", "key"].includes(command) || extra.length ||
    (flag !== undefined && !(command === "status" && flag === "--online"))) {
    io.stderr.write("Usage: qwen-subscription.mjs login|status [--online]|key\n");
    return 2;
  }
  try {
    const client = createQwenSubscription(options);
    if (command === "key") io.stdout.write(await client.key());
    else if (command === "login") {
      const result = await client.login({
        onDevice: ({ verificationUri, expiresAt }) => io.stderr.write(
          `Authorize Prime Agent's Qwen subscription:\n${verificationUri}\n` +
          `Expires: ${new Date(expiresAt).toISOString()}\n`),
      });
      io.stdout.write(`${JSON.stringify(result)}\n`);
      return result.available ? 0 : 1;
    } else io.stdout.write(`${JSON.stringify(flag ? await client.check() : client.status())}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${safeError(error, "command").message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runCli(process.argv.slice(2));
