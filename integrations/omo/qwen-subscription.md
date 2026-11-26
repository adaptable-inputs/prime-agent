# Prime Agent Qwen subscription helper

This helper implements Qwen's modern paid subscription device grant separately from legacy Qwen OAuth. It does not add a native Rust OAuth provider. Install `qwen-subscription.mjs` in `$HOME/.prime/agent/` and use Bun to run it. Linux `/usr/bin/flock` is required for cross-process credential locking.

## Commands

```sh
bun "$HOME/.prime/agent/qwen-subscription.mjs" login
bun "$HOME/.prime/agent/qwen-subscription.mjs" status
bun "$HOME/.prime/agent/qwen-subscription.mjs" status --online
```

`login` always starts a new independent grant. It prints a browser verification URI to stderr and polls until authorization, denial, or the server-provided expiry. The user must open the URI and authenticate their Qwen account. No browser callback or copied refresh token is used. Only confirmed Plus/Pro membership is reported available. Free/Lite sign-ins retain their credentials but are not represented as paid support. A membership request failure also retains the newly acquired pair; `status --online` checks again without another device grant.

`status` is synchronous, offline, and secret-free. An expired Prime access token with an independent refresh token can be available with `reason: "refresh_required"`; the next key request refreshes it. Offline status never claims an unverified Omo token is compatible.

The credential command, intended for Prime rather than a terminal, is:

```sh
bun "$HOME/.prime/agent/qwen-subscription.mjs" key
```

It writes only the access token to stdout on success. Failure writes a client-owned error code to stderr and exits 1, with no token, device code, response body, or server description. Misuse exits 2. Do not run this command in a transcript that records stdout.

## Generator integration

Override only the existing `qwen-coder-subscription` route when the installed helper exists. Preserve the source model IDs and all other provider mappings. The model list remains the generator's responsibility; this helper does not invent or replace a catalog.

```js
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const helper = join(homedir(), ".prime", "agent", "qwen-subscription.mjs");
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
if (existsSync(helper)) {
  const qwen = await import(pathToFileURL(helper).href);
  const command = `!${[bunExecutable, helper, "key"].map(quote).join(" ")}`;
  providers[qwen.PROVIDER] = {
    ...providers[qwen.PROVIDER],
    api: "openai-completions",
    baseUrl: qwen.GATEWAY,
    apiKey: command,
    authHeader: true,
    headers: {
      ...providers[qwen.PROVIDER].headers,
      ...qwen.INFERENCE_HEADERS,
    },
  };
  targetAuth[qwen.PROVIDER] = { type: "api_key", key: command };
  // Use qwen.status() for this route's inventory instead of the generic bridge.
}
```

`bunExecutable` is the generator's discovered absolute Bun path. The existing synchronous `credential(provider, selection)` must not call this async helper or copy its rotating credentials. Apply the same override to generated models, auth, and inventory so `--check` compares the desired mapping consistently. No changes to the Omo source stores are needed.

The fixed inference transport is `POST https://api.qwen.ai/compatible-mode/v1/chat/completions`, with JSON OpenAI Chat Completions requests, `Authorization: Bearer <access token>`, and `User-Agent: QwenCode/unknown (<platform>; <arch>)`. There is no subscription-specific API key, cookie, legacy client ID, or additional authentication header. Official Qwen clients also use this user agent for `GET /models`. Preserve Prime's existing streaming and OpenAI compatibility behavior.

The external-key bridge refreshes before token expiry. Unlike Qwen Code's native transport wrapper, it cannot observe an inference HTTP 401 and replay that request with a rejected-token refresh. Prime's transport redirect policy remains Prime's responsibility; all helper HTTP calls explicitly reject redirects. Subscription search, quota UI, and full native-host OAuth are not provided by this helper.

## JavaScript API and storage

Exports: `PROVIDER`, `SOURCE_PROVIDER`, `AUTH_ORIGIN`, `CLIENT_ID`, `GATEWAY`, `INFERENCE_HEADERS`, `status(options = {})`, `createQwenSubscription(options = {})`, `runCli(args, options = {}, io = process)`, and `QwenSubscriptionError`.

`createQwenSubscription` returns `{ login, key, check, status }`. `login({onDevice, signal})` invokes `onDevice({userCode, verificationUri, expiresAt})`, never a device code or token. `key({signal})` resolves to the access token. `check(signal)` refreshes if needed and confirms membership. `status()` performs no HTTP work and returns metadata only. OAuth errors expose `{code, stage, status, retryAfterMs}` with no arbitrary server text.

The default private credential file is `$HOME/.prime/agent/qwen-subscription.json`; the kernel lock is `$HOME/.prime/agent/qwen-subscription.lock`. Both have mode 0600. Newly created parent directories use 0700. Credential writes use a private, fsynced temporary file and atomic rename. Refresh requests run under the cross-process lock and re-read current state before rotating the complete pair.

```json
{
  "version": 1,
  "authOrigin": "https://auth.qwen.ai",
  "clientId": "qwen-code-cli",
  "gateway": "https://api.qwen.ai/compatible-mode/v1",
  "revision": "<independent login UUID>",
  "tokens": {
    "access_token": "<private>",
    "refresh_token": "<private>",
    "token_type": "Bearer",
    "scope": "model:invoke profile:read",
    "expires_in": 3600,
    "expiresAt": 1800003600000
  },
  "memberType": "Pro"
}
```

`tokens` and `memberType` may be absent before authorization or after refresh-stage `invalid_grant`. Optional `signInAttempt` protects against an older authorization overwriting a newer one. Optional `retryAfter.device` and `retryAfter.refresh` are absolute millisecond cooldown deadlines. `invalidReason: "refresh_invalid_grant"` records rejection of Prime's own grant. A denied or expired device attempt preserves the previous active pair.

The read-only fallback examines only Omo's `qwen-coder-subscription` OAuth access token and expiry. It rejects expired tokens. Before returning an unexpired fallback, it requires successful modern `/userinfo`, Plus/Pro membership, and `/models` gateway validation. It never refreshes, copies, or persists an Omo token pair, even if the source record has a refresh token.

Options for isolated use and tests are `{directory, omoAuthPath, now, schedule, fetch, authOrigin, gateway, requestTimeoutMs}`. `omoAuthPath: null` disables fallback. `directory` relocates only Prime-owned state. `now` returns milliseconds; `schedule(ms, signal)` replaces protocol polling waits. `authOrigin` and `gateway` accept only their fixed production values or explicitly supplied loopback HTTP fixture endpoints; there are no endpoint environment or CLI overrides. HOME is resolved normally by the runtime.

## Verification

```sh
bun test ./qwen-subscription.test.mjs
```

Tests load an adjacent helper when packaged together, otherwise the installed HOME-relative helper. `PRIME_QWEN_HELPER=/absolute/path/to/qwen-subscription.mjs` selects a test copy. They use mock fetch/local HTTP endpoints, injected clocks and device scheduling, and real competing processes for refresh locking. They do not contact Qwen or prove acceptance of a real paid account.

## Official protocol sources

Verified against QwenLM/qwen-code main:

- https://github.com/QwenLM/qwen-code/blob/main/docs/design/qwen-subscription.md
- https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/qwen/oauth-config.ts
- https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/qwen/subscription-oauth-client.ts
- https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/qwen/subscription-session.ts
- https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/qwen/subscription-content-generator.ts
- https://github.com/QwenLM/qwen-code/blob/main/packages/core/src/core/openaiContentGenerator/provider/default.ts

Modern auth is `https://auth.qwen.ai/api/oauth/device/code`, `/api/oauth/token`, and `/api/oauth/userinfo`, with client `qwen-code-cli` and scope `model:invoke profile:read`. Polling uses the returned interval; `authorization_pending` repeats it and `slow_down` adds five seconds. Transient poll failures back off within grant expiry. Token exchange and refresh use URL-encoded forms. Refresh replaces both tokens. Legacy Qwen OAuth endpoints and client identifiers are intentionally not used.
