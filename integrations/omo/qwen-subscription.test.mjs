import { afterEach, expect, test } from "bun:test";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const adjacentHelper = join(import.meta.dir, "qwen-subscription.mjs");
const modulePath = process.env.PRIME_QWEN_HELPER ?? (existsSync(adjacentHelper) ?
  adjacentHelper : join(homedir(), ".prime", "agent", "qwen-subscription.mjs"));
const {
  AUTH_ORIGIN, CLIENT_ID, GATEWAY, SOURCE_PROVIDER,
  createQwenSubscription, runCli, status,
} = await import(pathToFileURL(modulePath).href);

const cleanups = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const json = (body, status = 200, headers = {}) => Response.json(body, { status, headers });
const pair = (access = "fixture-access", refresh = "fixture-refresh", expires_in = 3600) => ({
  access_token: access, refresh_token: refresh, token_type: "Bearer",
  scope: "model:invoke profile:read", expires_in,
});
const device = {
  device_code: "private-device-code", user_code: "SAFE-CODE", expires_in: 60,
  interval: 2, verification_uri: "https://chat.qwen.ai/authorize",
  verification_uri_complete: "https://chat.qwen.ai/authorize?user_code=SAFE-CODE",
};
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

function fixture(fetcher = async () => { throw new Error("Unexpected network"); }) {
  const directory = mkdtempSync(join(tmpdir(), "prime-qwen-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  let clock = 1_800_000_000_000;
  const waits = [];
  const options = {
    directory, omoAuthPath: null, fetch: fetcher, now: () => clock,
    schedule: async (ms) => { waits.push(ms); clock += ms; },
  };
  const file = join(directory, "qwen-subscription.json");
  function seed(overrides = {}) {
    const state = {
      version: 1, authOrigin: options.authOrigin ?? AUTH_ORIGIN, clientId: CLIENT_ID,
      gateway: options.gateway ?? GATEWAY, revision: "existing-login",
      tokens: { ...pair("old-access", "old-refresh"), expiresAt: clock + 3600_000 },
      memberType: "Pro", ...overrides,
    };
    writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    return state;
  }
  return {
    directory, options, file, waits, seed,
    client: () => createQwenSubscription(options),
    state: () => JSON.parse(readFileSync(file, "utf8")),
    advance: (ms) => { clock += ms; },
  };
}

test("modern device login waits, slows down, stores an independent pair privately, and checks paid membership", async () => {
  const calls = [];
  let polls = 0;
  const f = fixture(async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, form: init.body ? Object.fromEntries(new URLSearchParams(init.body)) : undefined });
    expect(init.redirect).toBe("error");
    if (url.endsWith("/device/code")) return json(device);
    if (url.endsWith("/token")) {
      if (++polls === 1) return json({ error: "authorization_pending" }, 400);
      if (polls === 2) return json({ error: "slow_down" }, 400);
      return json(pair());
    }
    if (url.endsWith("/userinfo")) {
      expect(f.state().tokens.refresh_token).toBe("fixture-refresh");
      return json({ sub: "account-id", name: "Not persisted", email: "private@example.test", member_type: "pRo" });
    }
    throw new Error("Unexpected route");
  });
  let visible;
  const result = await f.client().login({ onDevice: (value) => { visible = value; } });
  expect(f.waits).toEqual([2000, 2000, 7000]);
  expect(calls.map(({ url }) => url)).toEqual([
    `${AUTH_ORIGIN}/api/oauth/device/code`, ...Array(3).fill(`${AUTH_ORIGIN}/api/oauth/token`),
    `${AUTH_ORIGIN}/api/oauth/userinfo`,
  ]);
  expect(calls[0].form).toEqual({ client_id: CLIENT_ID, scope: "model:invoke profile:read" });
  expect(calls[1].form).toEqual({
    client_id: CLIENT_ID, device_code: device.device_code,
    grant_type: "urn:ietf:params:oauth:grant-type:device_code",
  });
  expect(calls[4].headers.Authorization).toBe("Bearer fixture-access");
  expect(visible).toEqual({
    userCode: "SAFE-CODE",
    verificationUri: "https://chat.qwen.ai/authorize?user_code=SAFE-CODE&client=cli&entry=qwen_code&paywallScene=cli",
    expiresAt: 1_800_000_060_000,
  });
  expect(result.available).toBe(true);
  expect(await f.client().key()).toBe("fixture-access");
  expect(f.state().tokens).toEqual({ ...pair(), expiresAt: 1_800_003_611_000 });
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(statSync(join(f.directory, "qwen-subscription.lock")).mode & 0o777).toBe(0o600);
  expect(readFileSync(f.file, "utf8")).not.toContain("private@example.test");
  expect(JSON.stringify(visible)).not.toContain("private-device-code");
});

test("refresh rotates only Prime's complete pair once and respects persisted Retry-After", async () => {
  const forms = [];
  let fail = true;
  const f = fixture(async (url, init) => {
    forms.push(Object.fromEntries(new URLSearchParams(init.body)));
    if (fail) return json({ error: "server_error", error_description: "SECRET" }, 429, { "Retry-After": "10" });
    return json(pair("rotated-access", "rotated-refresh"));
  });
  f.seed({ tokens: { ...pair("old-access", "old-refresh"), expiresAt: f.options.now() - 1 } });
  await expect(f.client().key()).rejects.toMatchObject({ status: 429, stage: "refresh", retryAfterMs: 10_000 });
  await expect(f.client().key()).rejects.toMatchObject({ code: "rate_limited", stage: "refresh" });
  expect(forms.length).toBe(1);
  expect(f.state().tokens.refresh_token).toBe("old-refresh");
  fail = false;
  f.advance(10_000);
  expect(await f.client().key()).toBe("rotated-access");
  expect(await f.client().key()).toBe("rotated-access");
  expect(forms).toEqual(Array(2).fill({
    grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: "old-refresh",
  }));
  expect(f.state().tokens).toEqual({ ...pair("rotated-access", "rotated-refresh"), expiresAt: f.options.now() + 3600_000 });
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
});

test("refresh invalid_grant clears only Prime tokens and CLI errors never echo descriptions or secrets", async () => {
  const f = fixture(async () => json({
    error: "invalid_grant", error_description: "old-refresh private-device-code",
    access_token: "LEAKED-SERVER-ACCESS",
  }, 400));
  f.seed({ tokens: { ...pair("old-access", "old-refresh"), expiresAt: f.options.now() - 1 } });
  const out = [], err = [];
  const code = await runCli(["key"], f.options, {
    stdout: { write: (value) => out.push(value) }, stderr: { write: (value) => err.push(value) },
  });
  expect(code).toBe(1);
  expect(out).toEqual([]);
  expect(err.join("")).toContain("refresh/invalid_grant");
  expect(err.join("")).not.toMatch(/old-refresh|private-device-code|LEAKED-SERVER-ACCESS/);
  expect(f.state().tokens).toBeUndefined();
  expect(f.client().status().reason).toBe("refresh_invalid_grant");
});

test("denial, malformed exchange, and device expiry retain the previous working login without leaking secrets", async () => {
  for (const mode of ["access_denied", "malformed", "expiry", "unknown_error"]) {
    let polls = 0;
    const f = fixture(async (url) => {
      if (url.endsWith("/device/code")) return json({ ...device, expires_in: mode === "expiry" ? 3 : 60 });
      polls++;
      if (mode === "malformed") return json({ ...pair(), refresh_token: "" });
      if (mode === "expiry") return json({ error: "authorization_pending" }, 400);
      return json({
        error: mode === "unknown_error" ? "private-device-code" : "access_denied",
        error_description: "old-refresh", secret: "old-access",
      }, 400);
    });
    const original = f.seed();
    let output = "";
    const io = { stdout: { write: (v) => { output += v; } }, stderr: { write: (v) => { output += v; } } };
    expect(await runCli(["login"], f.options, io)).toBe(1);
    expect(output).toContain("https://chat.qwen.ai/authorize?");
    expect(output).not.toMatch(/private-device-code|old-refresh|old-access/);
    expect(f.state().tokens).toEqual(original.tokens);
    expect(polls).toBe(1);
    if (mode === "expiry") expect(f.waits).toEqual([2000, 1000]);
  }
});

test("transient device poll backoff honors Retry-After without exceeding grant lifetime", async () => {
  let attempts = 0;
  const f = fixture(async (url) => {
    if (url.endsWith("/device/code")) return json(device);
    if (url.endsWith("/userinfo")) return json({ sub: "id", member_type: "Plus" });
    if (++attempts === 1) return json({ error: "server_error" }, 503, { "Retry-After": "9" });
    return json(pair());
  });
  await f.client().login();
  expect(f.waits).toEqual([2000, 9000]);
});

test("failed membership retains fresh credentials and status --online recovers without another authorization", async () => {
  let recover = false;
  let devices = 0;
  const f = fixture(async (url) => {
    if (url.endsWith("/device/code")) { devices++; return json(device); }
    if (url.endsWith("/token")) return json(pair());
    if (!recover) return json({ error: "server_error", error_description: "fixture-refresh" }, 503);
    return json({ sub: "id", member_type: "Plus" });
  });
  await expect(f.client().login()).rejects.toMatchObject({ stage: "userinfo", status: 503 });
  expect(f.state().tokens.refresh_token).toBe("fixture-refresh");
  expect(f.client().status().available).toBe(false);
  recover = true;
  const out = [];
  expect(await runCli(["status", "--online"], f.options, {
    stdout: { write: (v) => out.push(v) }, stderr: { write: () => {} },
  })).toBe(0);
  expect(JSON.parse(out[0]).available).toBe(true);
  expect(out.join("")).not.toMatch(/fixture-access|fixture-refresh/);
  expect(devices).toBe(1);
});

test("Free and Lite authorization never becomes advertised paid access", async () => {
  for (const memberType of ["Free", "Lite"]) {
    const f = fixture(async (url) => url.endsWith("/device/code") ? json(device) :
      url.endsWith("/token") ? json(pair()) : json({ sub: "id", member_type: memberType }));
    expect((await f.client().login()).available).toBe(false);
    await expect(f.client().key()).rejects.toMatchObject({ code: "subscription_required" });
    expect(f.state().memberType).toBe(memberType);
  }
});

test("Omo fallback refuses expired or legacy tokens and never refreshes, copies, or modifies the source pair", async () => {
  const calls = [];
  let compatible = false;
  const f = fixture(async (url, init) => {
    calls.push({ url, init });
    if (!compatible) return json({ error: "invalid_grant", error_description: "SOURCE-REFRESH" }, 401);
    return url.endsWith("/userinfo") ? json({ sub: "id", member_type: "Pro" }) : json({ data: [{ id: "paid-model" }] });
  });
  f.options.omoAuthPath = join(f.directory, "omo-auth.json");
  function source(expires) {
    const contents = JSON.stringify({
      [SOURCE_PROVIDER]: { type: "oauth", access: "SOURCE-ACCESS", refresh: "SOURCE-REFRESH", expires },
    });
    writeFileSync(f.options.omoAuthPath, contents, { mode: 0o600 });
    return contents;
  }
  let original = source(f.options.now() - 1);
  expect(status(f.options).reason).toBe("omo_oauth_expired");
  await expect(f.client().key()).rejects.toMatchObject({ code: "omo_oauth_expired" });
  expect(calls).toEqual([]);
  expect(readFileSync(f.options.omoAuthPath, "utf8")).toBe(original);
  original = source(f.options.now() + 60_000);
  expect(status(f.options).available).toBe(false);
  await expect(f.client().key()).rejects.toMatchObject({ status: 401, stage: "userinfo" });
  compatible = true;
  expect(await f.client().key()).toBe("SOURCE-ACCESS");
  expect(calls.map(({ url }) => url)).toEqual([
    `${AUTH_ORIGIN}/api/oauth/userinfo`, `${AUTH_ORIGIN}/api/oauth/userinfo`, `${GATEWAY}/models`,
  ]);
  expect(calls[2].init.headers.Authorization).toBe("Bearer SOURCE-ACCESS");
  expect(calls[2].init.headers["User-Agent"]).toMatch(/^QwenCode\/unknown \(/);
  expect(readFileSync(f.options.omoAuthPath, "utf8")).toBe(original);
  expect(existsSync(f.file)).toBe(false);
});

test("superseded device authorization cannot overwrite a newer independent login", async () => {
  const firstExchange = deferred();
  const continueFirst = deferred();
  let deviceCount = 0;
  const f = fixture(async (url, init) => {
    if (url.endsWith("/device/code")) return json({ ...device, device_code: `device-${++deviceCount}` });
    if (url.endsWith("/userinfo")) return json({ sub: "id", member_type: "Pro" });
    const form = new URLSearchParams(init.body);
    if (form.get("device_code") === "device-1") {
      firstExchange.resolve();
      await continueFirst.promise;
      return json(pair("first-access", "first-refresh"));
    }
    return json(pair("second-access", "second-refresh"));
  });
  const first = f.client().login().then(
    (value) => ({ value }), (error) => ({ error }),
  );
  await firstExchange.promise;
  await f.client().login();
  continueFirst.resolve();
  expect((await first).error).toMatchObject({ code: "session_changed" });
  expect(f.state().tokens.access_token).toBe("second-access");
});

test("multiple real CLI processes serialize refresh and re-read the rotated pair", async () => {
  const entered = deferred();
  const release = deferred();
  const forms = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      forms.push(Object.fromEntries(new URLSearchParams(await request.text())));
      entered.resolve();
      await release.promise;
      if (forms.length > 1) return json({ error: "invalid_grant" }, 400);
      return json(pair("process-access", "process-refresh"));
    },
  });
  cleanups.push(() => server.stop(true));
  const f = fixture();
  f.options.authOrigin = server.url.origin;
  f.seed({ tokens: { ...pair("old-access", "old-refresh"), expiresAt: Date.now() - 1 } });
  const config = { directory: f.directory, omoAuthPath: null, authOrigin: server.url.origin };
  function worker() {
    const source = `import {createQwenSubscription} from ${JSON.stringify(modulePath)}; ` +
      `process.stdout.write("READY\\n"); const value = await createQwenSubscription(${JSON.stringify(config)}).key(); process.stdout.write(value);`;
    const process = Bun.spawn([Bun.which("bun"), "--eval", source], { stdout: "pipe", stderr: "pipe" });
    const reader = process.stdout.getReader();
    const ready = reader.read().then(({ value }) => {
      expect(new TextDecoder().decode(value)).toContain("READY");
    });
    const done = (async () => {
      await ready;
      let output = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        output += new TextDecoder().decode(value);
      }
      return { output, code: await process.exited, error: await new Response(process.stderr).text() };
    })();
    cleanups.push(() => { process.kill(); });
    return { ready, done };
  }
  const first = worker();
  await entered.promise;
  const others = Array.from({ length: 4 }, worker);
  await Promise.all(others.map((worker) => worker.ready));
  release.resolve();
  expect(await Promise.all([first, ...others].map((worker) => worker.done))).toEqual(
    Array(5).fill({ output: "process-access", code: 0, error: "" }),
  );
  expect(forms).toEqual([{ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: "old-refresh" }]);
  expect(f.state().tokens.refresh_token).toBe("process-refresh");
}, 15_000);

test.each(["prime", "omo-read-only"])("CLI honors the relocated %s store instead of HOME defaults", async (expectedSource) => {
  // Given a Prime grant and an Omo source in separately relocated stores.
  const f = fixture();
  if (expectedSource === "prime") f.seed({ tokens: { ...pair(), expiresAt: Number.MAX_SAFE_INTEGER } });
  const source = join(f.directory, "omo-source");
  mkdirSync(source);
  writeFileSync(join(source, "auth.json"), JSON.stringify({
    [SOURCE_PROVIDER]: { type: "oauth", access: "expired-source-token", expires: 1 },
  }));
  const environment = {
    PATH: process.env.PATH,
    HOME: join(f.directory, "unused-home"),
    PRIME_OMO_AGENT_DIR: f.directory,
    PRIME_OMO_SOURCE_DIR: source,
  };
  const defaultDirectory = join(environment.HOME, ".prime", "agent");
  mkdirSync(defaultDirectory, { recursive: true });
  const defaultFile = join(defaultDirectory, "qwen-subscription.json");
  writeFileSync(defaultFile, "invalid-default-store", { mode: 0o600 });
  const run = async () => {
    const child = Bun.spawn([process.execPath, modulePath, "status"], {
      env: environment, stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).not.toMatch(/fixture-access|fixture-refresh|expired-source-token/);
    return JSON.parse(out);
  };
  // When the public CLI resolves status.
  const result = await run();
  // Then it identifies the explicitly configured store only.
  expect(result).toMatchObject(expectedSource === "prime"
    ? { source: "prime", signedIn: true, available: true }
    : { source: "omo-read-only", expires: 1, reason: "omo_oauth_expired" });
  expect(readFileSync(defaultFile, "utf8")).toBe("invalid-default-store");
}, 10000);

test("offline status, CLI misuse, insecure persistence, and endpoint validation expose no token values", async () => {
  const f = fixture();
  f.seed();
  const out = [];
  const io = { stdout: { write: (v) => out.push(v) }, stderr: { write: (v) => out.push(v) } };
  expect(await runCli(["status"], f.options, io)).toBe(0);
  expect(out.join("")).not.toMatch(/old-access|old-refresh/);
  expect(await runCli(["key", "--account", "unexpected"], f.options, io)).toBe(2);
  chmodSync(f.file, 0o644);
  expect(f.client().status().reason).toBe("credentials_insecure");
  expect(await runCli(["key"], f.options, io)).toBe(1);
  expect(() => createQwenSubscription({ ...f.options, authOrigin: "https://attacker.invalid" })).toThrow();
  expect(out.join("")).not.toMatch(/old-access|old-refresh/);
});
