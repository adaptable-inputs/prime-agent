# Qwen Code subscription

Prime Agent supports native Qwen Code subscription sign-in. No API key, Bun helper, or Qwen Code installation is required. This uses Qwen's modern Plus/Pro subscription service, not legacy Qwen OAuth or Alibaba Model Studio API keys.

1. Start `prime-agent` and run `/login`.
2. Choose **Qwen Code (Plus/Pro Subscription)**, marked **subscription**.
3. Open the authorization link shown in the panel, sign in to Qwen, and approve the device code. Press Escape to cancel.
4. After sign-in, run `/model` and select a model under `qwen-coder-subscription`.

The built-in default is `qwen3.8-max`. You can also select it on startup after signing in:

```bash
prime-agent --provider qwen-coder-subscription --model qwen3.8-max
```

Model access depends on your subscription. Prime Agent uses its normal model catalog and `models.json` overrides; this integration does not fetch your account's `/models` list. A catalog that predates this provider retains the built-in default. Additional model IDs can use the same provider's transport through the normal model configuration.

## Credentials and recovery

Prime Agent saves the OAuth access/refresh token pair in its private `auth.json` and refreshes it automatically before expiry. Refresh replaces both tokens using the existing locked auth store. The subscription gateway is fixed to `https://api.qwen.ai/compatible-mode/v1`; native requests do not follow redirects, and custom headers cannot replace the serving bearer token.

Sign-in checks Plus/Pro membership after saving the token pair. A Free/Lite account or failed membership check reports an error, not successful subscription activation. The credentials remain saved so a temporary membership failure does not discard a rotating grant. A saved credential alone is not proof of paid entitlement; the inference gateway remains authoritative. Run `/login` to sign in again or `/logout` to remove the saved credential.

The existing optional [Omo helper](../integrations/omo/qwen-subscription.md) remains separate. A native login replaces that provider's stored command credential with OAuth. Native credentials take precedence over a `models.json` helper command; a native refresh failure reports an authentication error rather than silently switching accounts through that command. Signing out leaves custom `models.json` settings unchanged, including any independently configured helper.

Subscription web search, quota UI, and importing Qwen Code's credential files are not included.
