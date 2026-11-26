# Omo subscriptions and named accounts

This optional integration imports Omo provider definitions into an installed Prime Agent. It adds explicit named routes for simultaneous Codex, Claude subscription, and Kimi sessions, and independent Qwen subscription device login. It uses Prime Agent's existing native transports; no Rust rebuild is required.

## Install

Requires Bun, an installed Prime Agent, and an existing Omo configuration under `~/.omo/agent`. Qwen token locking additionally requires Linux `/usr/bin/flock`.

```sh
bun integrations/omo/install.mjs
```

Existing configuration is preserved unless `--update` is supplied. That option backs up affected configuration files privately, replaces provider definitions and credential references, and preserves unrelated application preferences. Review existing custom Prime providers before replacing them.

```sh
bun integrations/omo/install.mjs --update
bun integrations/omo/configure-prime-omo.mjs --check
prime-agent model list
```

The installed files are `~/.prime/agent/{models.json,auth.json,settings.json,omo-credentials.mjs,qwen-subscription.mjs}`. Configuration contains executable credential references, never copied Omo tokens or refresh grants. The helpers read Omo stores without modifying them. Successful command results are cached within a Prime worker; restart that worker after changing its credential.

If more than one Omo runtime exists, set `PRIME_OMO_REGISTRY_PATH` to its `node_modules/@earendil-works/pi-ai/dist/providers/all.js`. Advanced paths can be set with `PRIME_OMO_SOURCE_DIR` and `PRIME_OMO_AGENT_DIR`; retain those environment variables when launching Prime workers, and set Prime's `PRIME_AGENT_CODING_AGENT_DIR` to the same target directory.

## Parallel named sessions

Account names become provider suffixes. Existing account names are preserved, including names whose credentials have expired; selecting such a route fails rather than silently using another account.

```sh
prime-agent --provider openai-codex-default --model gpt-6.1-sol
prime-agent --provider openai-codex-login-3 --model gpt-6.1-sol
prime-agent --provider kimi-coding-default --model k3
prime-agent --provider kimi-coding-login-3 --model k3
```

Run these in separate terminals, or select the matching provider in each Prime session. The provider identity binds an immutable `--account NAME` credential command. Parallel workers cannot overwrite one another's selection through shared environment variables. Two account names may refer to the same underlying credential; names alone do not establish separate quota.

The original unqualified providers remain available. There is no automatic account distribution or quota failover.

## Claude subscriptions

Prime already implements the Anthropic OAuth bearer transport. This integration discovers Omo subscription accounts, `CLAUDE_CODE_OAUTH_TOKEN` and numbered variants, and the ambient Claude CLI profile.

```sh
claude auth login --claudeai
bun integrations/omo/install.mjs --update
prime-agent --provider claude-subscription-ambient --model claude-sonnet-4-5
```

For multiple profiles, sign in with distinct `CLAUDE_CONFIG_DIR` directories and add references to the top-level `claudeSubscriptionAccounts` field in Prime's `models.json`, then rerun the integration installer:

```json
{
  "claudeSubscriptionAccounts": {
    "work": { "profileFile": "/absolute/path/to/work/.credentials.json" },
    "personal": { "profileFile": "/absolute/path/to/personal/.credentials.json" },
    "team": { "env": "TEAM_CLAUDE_TOKEN" }
  }
}
```

These produce `claude-subscription-profile-work`, `claude-subscription-profile-personal`, and `claude-subscription-profile-team`. References are not token values. Profile credentials must have a fresh expiry; environment tokens may optionally declare an `expires` timestamp in milliseconds. Explicit named selection never falls back.

This is native Anthropic OAuth, not Omo's Claude Agent SDK execution lane. It does not reproduce SDK tools, usage ceilings, or subscription quota accounting. Shared Claude and Codex grants are not refreshed by this integration; their owning CLI or Omo retains refresh ownership.

## Qwen subscriptions

```sh
bun "$HOME/.prime/agent/qwen-subscription.mjs" login
bun "$HOME/.prime/agent/qwen-subscription.mjs" status
prime-agent --provider qwen-coder-subscription --model qwen4-max
```

Open the authorization URI printed by `login` and authorize your Qwen account. The helper checks Plus/Pro membership and maintains its own rotating grant in a private `qwen-subscription.json`. It never refreshes Omo's grant. Device polling and cross-process refresh locking are implemented; a browser sign-in is still required.

See [Qwen protocol and storage details](qwen-subscription.md). Model IDs come from the imported Omo catalog and remain subject to account entitlement.

## Tests and limits

```sh
make test-subscriptions
make test-subscription-transports
# To test a specific local build:
PRIME_AGENT_BIN="$PWD/target/release/prime-agent" make test-subscription-transports
```

The first target runs hermetic credential, device-flow, persistence, and concurrent-refresh tests. The second runs seven overlapping installed CLI requests against a local HTTP server, checking Codex account headers, Claude OAuth bearer headers, Kimi API keys, Qwen bearer authentication, and independent output. Neither target claims that synthetic credentials authenticate to a live service.

Live account validity, quota, and entitlement remain upstream conditions. A readable API key can still return 401 or 429. Expired OAuth and missing credentials fail closed. Some Omo model metadata and serving tiers are not portable; `--inventory` reports omitted fields and explicit tier mappings.
