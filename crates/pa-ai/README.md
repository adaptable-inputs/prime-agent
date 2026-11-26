# pa-ai

Provider APIs and model registry.

## Scope
Provider trait + per-provider streaming clients (anthropic, openai-completions/responses, google, bedrock, mistral, azure, prime-inference), model registry/resolution, usage accounting, stream-failure retry, provider-error shapes (per-SDK user-facing texts, diagnostic error names, connection-error profiles), bedrock transport selection (h2c prior-knowledge HTTP/2 cleartext, h2-preferred TLS ALPN, the http1 AWS_BEDROCK_FORCE_HTTP1/proxy mode), overflow handling, JSON repair parsing, subscription OAuth protocol flows (including modern Qwen Code device grants and paid-membership verification), faux provider for tests.

## Non-goals
No agent loop, no tool execution, no session state, no UI, no durable OAuth credential storage or account activation. Receives/returns `pa-types` messages.

## Public API
`Provider` trait, `ProviderRegistry`, model lookup/resolution, faux provider. `utils::tls::http_client_builder` lets caller-owned HTTP transports apply the shared extra-CA trust configuration. `oauth` exposes transport/UI seams and subscription login/refresh flows. Qwen Code adds `login_qwen_subscription`, `refresh_qwen_subscription_token`, `QwenSubscriptionCredentials`, `QWEN_SUBSCRIPTION_LOGIN_CANCELLED`, `QWEN_SUBSCRIPTION_BASE_URL`, and `check_qwen_subscription_membership` (only Plus/Pro qualifies). Callers must persist rotating pairs before checking membership; refresh never depends on membership availability. Per-provider internals are `pub(crate)`.

## Depends on
pa-types (one-way).
