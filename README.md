# dsh-plugin-thinking-api

<div align="center">

[简体中文](./README.zh-CN.md) · **English**

</div>

<p align="center">
  DeepSeek Harness plugin: configure any OpenAI-compatible API in one block and get thinking mode for free — while dodging the <code>developer</code>-role rejection that breaks such APIs.
</p>

<p align="center">
  <img src="https://badgen.net/badge/license/MIT/blue" alt="license">
  <img src="https://badgen.net/badge/node/%3E%3D20/green" alt="node">
  <img src="https://badgen.net/badge/dsh/0.1.0--rc.6/purple" alt="dsh">
</p>

---

## What it solves

Three problems in one plugin:

1. **Configure any OpenAI-compatible API in one block** — Tencent CodeBuddy, self-hosted vLLM, or any relay — no hand-writing `reasoningEfforts`, `thinkingFormat`, or pi-ai provider internals.
2. **Thinking mode out of the box** — set `thinking: true` on a model and it gains reasoning levels automatically.
3. **Fixes the `content_filter` / `developer`-role bug** — this is the subtle one.

### The bug this fixes

When a model declares reasoning, pi-ai rewrites the system prompt into the OpenAI `developer` role *unless* it recognizes the endpoint as a non-standard vendor. Third-party APIs that are not on pi-ai's built-in allowlist (Tencent CodeBuddy is a prime example) therefore receive a `developer` message, which many endpoints hard-reject with `content_filter` — while the exact same request using `system` succeeds.

The official `dsh-llm-pi-ai` adapter *drops* the `compat.supportsDeveloperRole` field when it builds models, so you cannot fix this from `settings.yaml` alone. This plugin builds the pi-ai models itself and injects `compat.supportsDeveloperRole: false` directly, forcing the `system` role.

### How it stays maintainable

The plugin reuses the official `PiAiAdapter` class (exported by `@deepseek-ai/dsh-llm-pi-ai`): its streaming, chunk translation, credential resolution, idle-timeout watchdog, and image handling all keep evolving with DSH. This plugin only owns the small "model/provider assembly" layer where the correct `compat` is written in.

## Install

Add to your profile's `package.json` dependencies and bundle list:

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-plugin-thinking-api": "github:qjf44/dsh-plugin-thinking-api"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ... your existing bundles ...
        "dsh-plugin-thinking-api"
      ]
    }
  }
}
```

Then reinstall and restart the Harness. The plugin's `cordis.patch.yml` registers itself (`insert: [{ id: thinking-api }]`), so no manual `cordis.patch.yml` edit is needed.

## Configure

Add a `thinking-api` section to `~/.dsh/settings.yaml`:

```yaml
thinking-api:
  providers:
    codebuddy:                                   # route id (any unique name)
      displayName: CodeBuddy                     # optional, shown in pickers
      baseURL: https://copilot.tencent.com/v2
      apiKeyEnv: CODEBUDDY_API_KEY               # env-var reference; store via the Web Models page or export it
      thinkingFormat: deepseek                   # optional, default deepseek
      models:
        deepseek-v4-pro:
          name: DeepSeek V4 Pro
          thinking: true                         # ← enables thinking mode
        deepseek-v4-flash:
          name: DeepSeek V4 Flash
          thinking: false
```

Store the key (never paste raw keys into the config):

```bash
# either export it in the launching environment
export CODEBUDDY_API_KEY=ck_xxxxxxxx

# or write it through the Web UI → Models page (credentials service)
```

Restart, then pick your API's models from the model picker.

## One-click setup in the Web GUI

The plugin also registers a **Settings → Thinking API** panel with a single setup wizard. Open it to connect an API without touching YAML:

1. **Source** — pick a template (CodeBuddy / DeepSeek / OpenRouter / …) or *Custom*.
2. **API key** — paste it once. Templates ship sensible default models, so you can save immediately and start chatting.
3. **Models** (optional) — click *Fetch models* to list the endpoint's models; the wizard pre-flags reasoning models by name (and you can adjust each one with a checkbox). Or add model ids manually.
4. **Save** — done. The provider appears in the model picker and uses the fixed adapter (`supportsDeveloperRole: false`).

Existing providers can be edited (the *Edit* button reloads them into the wizard) or removed.

> The client half ships as a browser bundle discovered through `exports["./client"]`; after changing plugin source, rebuild the Web artifacts so this URL picks up the new bundle.

## Configuration reference

### Provider (per `providers.<id>`)

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `baseURL` | string | ✅ | — | API endpoint base URL |
| `apiKeyEnv` | string | — | — | Env-var name holding the API key |
| `displayName` | string | — | route id | Name shown in pickers |
| `thinkingFormat` | enum | — | `deepseek` | `deepseek` \| `openai` \| `openrouter` \| `together` \| `zai` \| `qwen` \| `string-thinking` |
| `models` | dict | ✅ | — | Model id → model entry |

### Model (per `models.<id>`)

| Field | Type | Required | Default | Meaning |
|---|---|---|---|---|
| `name` | string | — | model id | Display name |
| `thinking` | boolean | — | `false` | Enable reasoning levels |
| `thinkingEfforts` | dict | — | auto | Custom level → wire-value mapping, e.g. `{ off: null, high: high, max: xhigh }` |
| `contextWindow` | number | — | `262144` | Context window size |
| `maxTokens` | number | — | `32768` | Max output tokens |

When `thinking: true` and no `thinkingEfforts` is given, the plugin fills a verified DeepSeek-compatible level map (`off` / `high` / `max`, mapping to disabled / `reasoning_effort: high` / `reasoning_effort: xhigh`). Provide `thinkingEfforts` to add levels (`low`/`medium`) or override per API.

## Why not `llm-pi-ai`?

The built-in `llm-pi-ai` adapter already supports custom APIs. It just cannot express `supportsDeveloperRole` (its `compat` schema omits the field and its resolver drops it), so thinking-mode models on allowlist-less APIs hit the `developer`-role rejection. This plugin exists purely to inject that one missing bit, while reusing everything else.

## Supported DSH

Built against DSH `0.1.0-rc.6+` (`@deepseek-ai/dsh-llm-pi-ai`), pi-ai `0.82.1`. The plugin defensively reuses `PiAiAdapter`'s constructor shape; if a future DSH changes that internal contract, the plugin fails with a clear error rather than silently misbehaving — check the release notes before upgrading DSH.

## After upgrading DSH, CodeBuddy / third-party APIs stop working? Run the compat check

The plugin depends on several *internal* contracts of pi-ai and DSH (provider auth shape, `PiAiAdapter` constructor, `llm` service registration methods). These are **not covered by semver**. So after every DSH (or pi-ai) upgrade, if models suddenly fail with `Provider is not configured`, `content_filter`, or `MISSING_CREDENTIAL`, run the compat check first:

```bash
# from the plugin repo (DSH workspace is auto-detected upward; pass --workspace when needed)
node scripts/check-compat.mjs --workspace ~/.workbuddy/binaries/node/workspace
```

It verifies, item by item: the plugin imports under the real dependencies, the `PiAiAdapter` constructor shape, the pi-ai provider auth shape, the `llm` service registration methods, and the settings/credentials helpers. **All ✓ means you can keep using it; any ✗ means the plugin needs an update** (each failure names the changed contract and where to fix it).

### Incident log (2026-08-18, DSH rc.6 → rc.7)

After the upgrade, codebuddy requests failed 100% with `PI_AI_ERROR: Provider is not configured: codebuddy`. Root cause: **pi-ai 0.82.1 changed the provider auth contract**:

- Before 0.82.1: `auth: { name, resolve }` (top-level `resolve`).
- From 0.82.1: `resolveProviderAuth` only recognizes `auth.apiKey.resolve`; a top-level `resolve` is treated as "no auth method" → `getAuth` returns nothing → the error above.

Fix: `buildProvider` now assembles auth as `{ apiKey: { name, resolve } }`, matching the official `dsh-llm-pi-ai` `routeAuth`/`harnessApiKeyAuth` shape. The plugin also self-checks this contract at startup, so a version mismatch now fails loudly at boot instead of on your first message.

Second pitfall: **editing a provider in the GUI wizard with the key field left blank wiped the existing `apiKeyEnv`**, losing the credential reference after an upgrade/reconfigure (reported as `MISSING_CREDENTIAL` or auth failures). Fixed: in edit mode, a blank key means "keep unchanged" and the previous `apiKeyEnv` is preserved.

## License

[MIT](./LICENSE)
