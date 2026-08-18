# dsh-plugin-thinking-api

<div align="center">

[English](./README.md) · **简体中文**

</div>

<p align="center">
  DeepSeek Harness 插件：一键配置任意 OpenAI 兼容 API 并自动带思考模式，同时规避 <code>developer</code> 角色被第三方端点拒绝（<code>content_filter</code>）的问题。
</p>

<p align="center">
  <img src="https://badgen.net/badge/license/MIT/blue" alt="license">
  <img src="https://badgen.net/badge/node/%3E%3D20/green" alt="node">
  <img src="https://badgen.net/badge/dsh/0.1.0--rc.6/purple" alt="dsh">
</p>

---

## 解决什么问题

一个插件解决三件事：

1. **任意 OpenAI 兼容 API 一键配置** —— 腾讯 CodeBuddy、自建 vLLM、各类中转站，一个配置块搞定，无需手写 `reasoningEfforts`、`thinkingFormat` 或 pi-ai provider 内部结构。
2. **开箱即用的思考模式** —— 模型上写 `thinking: true` 就自动获得思考档位。
3. **修复 `content_filter` / `developer` 角色 bug** —— 这是最隐蔽的一个。

### 它修复的 bug

当模型声明了 reasoning（思考）时，pi-ai 会把 system prompt 改写成 OpenAI 的 `developer` 角色——除非它把该端点识别为「非标厂商」。不在 pi-ai 内置白名单里的第三方 API（腾讯 CodeBuddy 就是典型）因此会收到 `developer` 消息，而很多端点会硬拒绝它并返回 `content_filter`；同样的请求换成 `system` 角色则完全正常。

官方 `dsh-llm-pi-ai` 适配器在组装模型时**丢弃**了 `compat.supportsDeveloperRole` 字段，所以单靠 `settings.yaml` 无法修复。本插件自己组装 pi-ai 模型，直接注入 `compat.supportsDeveloperRole: false`，强制走 `system` 角色。

### 为什么它好维护

插件**复用**官方 `PiAiAdapter` 类（由 `@deepseek-ai/dsh-llm-pi-ai` 导出）：它的流式输出、chunk 翻译、凭据解析、空闲超时看门狗、图片处理都随 DSH 升级自动演进。本插件只负责「模型 / Provider 组装」这一小层——把正确的 `compat` 写进去。

## 安装

在 profile 的 `package.json` 里加入依赖和 bundle 列表：

```jsonc
// ~/.dsh/profiles/<profile>/package.json
{
  "dependencies": {
    "dsh-plugin-thinking-api": "github:qjf44/dsh-plugin-thinking-api"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ...你已有的 bundles...
        "dsh-plugin-thinking-api"
      ]
    }
  }
}
```

重装依赖并重启 Harness。插件的 `cordis.patch.yml` 会自动注册自身（`insert: [{ id: thinking-api }]`），**无需**手动改 `cordis.patch.yml`。

## 配置

在 `~/.dsh/settings.yaml` 里加一个 `thinking-api` 区块：

```yaml
thinking-api:
  providers:
    codebuddy:                                   # 路由 id（任意唯一名称）
      displayName: CodeBuddy                     # 可选，选择器里显示的名字
      baseURL: https://copilot.tencent.com/v2
      apiKeyEnv: CODEBUDDY_API_KEY               # 环境变量名；通过 Web 模型页存储或 export
      thinkingFormat: deepseek                   # 可选，默认 deepseek
      models:
        deepseek-v4-pro:
          name: DeepSeek V4 Pro
          thinking: true                         # ← 开启思考模式
        deepseek-v4-flash:
          name: DeepSeek V4 Flash
          thinking: false
```

存储密钥（**不要把明文 key 写进配置**）：

```bash
# 方式一：在启动环境里导出
export CODEBUDDY_API_KEY=ck_xxxxxxxx

# 方式二：通过 Web 界面 → 模型页写入（credentials 服务）
```

重启后，从模型选择器里选你的 API 模型即可。

## Web 界面一键配置

插件还注册了 **设置 → 思考 API** 面板，内置一个统一的接入向导，不用手写 YAML 就能接入 API：

1. **来源** —— 选模板（CodeBuddy / DeepSeek / OpenRouter / …）或「自定义」。
2. **API 密钥** —— 粘贴一次即可。模板自带常用默认模型，填完 key 就能直接保存开始对话。
3. **模型**（可选）—— 点「获取模型列表」拉取端点模型，向导会按名称自动预判思考模型（每条都能用勾选框微调）；也可以手动添加模型 id。
4. **保存** —— 完成。该 provider 会出现在模型选择器里，并走修复版适配器（`supportsDeveloperRole: false`）。

已接入的 provider 可以点「编辑」回填进向导修改，也可以删除。

> client 半通过 `exports["./client"]` 作为浏览器 bundle 被发现；修改插件源码后需重建 Web 产物，本 URL 才会加载新 bundle。

## 配置参考

### Provider（`providers.<id>` 下）

| 字段 | 类型 | 必填 | 默认 | 含义 |
|---|---|---|---|---|
| `baseURL` | string | ✅ | — | API 端点 base URL |
| `apiKeyEnv` | string | — | — | 存放 API key 的环境变量名 |
| `displayName` | string | — | 路由 id | 选择器里显示的名字 |
| `thinkingFormat` | enum | — | `deepseek` | `deepseek` \| `openai` \| `openrouter` \| `together` \| `zai` \| `qwen` \| `string-thinking` |
| `models` | dict | ✅ | — | 模型 id → 模型条目 |

### Model（`models.<id>` 下）

| 字段 | 类型 | 必填 | 默认 | 含义 |
|---|---|---|---|---|
| `name` | string | — | 模型 id | 显示名 |
| `thinking` | boolean | — | `false` | 是否开启思考档位 |
| `thinkingEfforts` | dict | — | 自动 | 自定义档位 → 线上参数映射，如 `{ off: null, high: high, max: xhigh }` |
| `contextWindow` | number | — | `262144` | 上下文窗口大小 |
| `maxTokens` | number | — | `32768` | 最大输出 token |

`thinking: true` 且未给 `thinkingEfforts` 时，插件自动填充已验证可用的 DeepSeek 兼容档位（`off` / `high` / `max`，分别对应关闭 / `reasoning_effort: high` / `reasoning_effort: xhigh`）。需要更多档位（`low`/`medium`）或按 API 定制时，用 `thinkingEfforts` 显式覆盖。

## 为什么不用内置 `llm-pi-ai`？

内置 `llm-pi-ai` 适配器本来就支持自定义 API，只是它无法表达 `supportsDeveloperRole`（它的 `compat` schema 没这个字段，解析器也会丢弃它），于是「白名单外 API + 思考模式」就会撞上 `developer` 角色拒绝。本插件存在的意义，就是补上这缺失的一个字段，其余全部复用。

## 支持的 DSH 版本

基于 DSH `0.1.0-rc.6+`（`@deepseek-ai/dsh-llm-pi-ai`）、pi-ai `0.82.1` 构建。插件对 `PiAiAdapter` 的构造器形状做了防御性依赖；若未来 DSH 改变该内部契约，插件会给出清晰报错而非静默出错——升级 DSH 前请先看本插件的 release notes。

## 升级 DSH 后 CodeBuddy / 第三方 API 用不了？先跑自检

插件依赖 pi-ai 与 DSH 的若干内部契约（provider auth 形状、`PiAiAdapter` 构造器、`llm` 服务注册方法等）。这些契约**不在官方语义版本保证内**，所以每次升级 DSH（或 pi-ai）后，如果模型突然报 `Provider is not configured`、`content_filter`、`MISSING_CREDENTIAL` 之类，先跑一次兼容性自检：

```bash
# 在插件仓库目录下（DSH workspace 会自动向上查找；找不到时显式指定）
node scripts/check-compat.mjs --workspace ~/.workbuddy/binaries/node/workspace
```

它会逐项核对：插件能否在真实依赖下 import、`PiAiAdapter` 构造器形状、pi-ai provider auth 形状、`llm` 服务注册方法、settings/credentials 辅助函数。**全部 ✓ 才能继续用；有任何 ✗ 就说明需要升级插件**（报错信息会点名是哪个契约变了、去哪改）。

### 历史踩坑记录（2026-08-18，DSH rc.6 → rc.7）

升级后 codebuddy 请求 100% 报 `PI_AI_ERROR: Provider is not configured: codebuddy`，根因是 **pi-ai 0.82.1 改了 provider auth 契约**：

- 旧（0.82.1 之前）：`auth: { name, resolve }`（顶层 `resolve`）。
- 新（0.82.1 起）：`resolveProviderAuth` 只认 `auth.apiKey.resolve`，顶层 `resolve` 被当作「无认证方式」→ `getAuth` 返回空 → 上述报错。

修复：`buildProvider` 把 auth 组装成 `{ apiKey: { name, resolve } }`，与官方 `dsh-llm-pi-ai` 的 `routeAuth`/`harnessApiKeyAuth` 形态一致。插件现在启动时会自检该契约，版本不匹配会在启动时直接报错，而不是等你发消息。

另一个坑：**GUI 向导编辑 provider 时 key 留空会抹掉已有的 `apiKeyEnv`**，导致升级/重配后密钥引用丢失（报 `MISSING_CREDENTIAL` 或认证失效）。已修复：编辑模式 key 留空表示「不改」，沿用原有 `apiKeyEnv`。

## License

[MIT](./LICENSE)
