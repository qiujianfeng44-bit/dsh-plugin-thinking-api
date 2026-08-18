# Thinking API 插件 · 「一键配置」GUI 面板技术方案

> 目标：让用户**不用手写 YAML**，在 DSH Web 界面里点几下就能：
> 1. **模板一键启用**常见第三方 API（CodeBuddy / DeepSeek / OpenRouter / SiliconFlow …），只填 API Key；
> 2. **自由添加**任意 OpenAI 兼容 API（填 route id + baseURL + key + 模型 + 思考模式）；
> 3. 两条路径都走本插件的**修复版适配器**（`supportsDeveloperRole: false` + 思考模式），彻底规避 `developer → content_filter`。

---

## 0. 背景与约束（为什么不能直接用官方「模型」页）

官方「设置 → 模型」页（`@deepseek-ai/dsh-client-ui-settings-models`）存在**硬编码限制**：

```js
// dsh-client-ui-settings-models/lib/client.js
function layoutOf(ns) {
  if (ns === "llm-deepseek") return "deepseek";
  if (ns === "llm-pi-ai")   return "pi-ai";
  return "unknown";  // ← 第三方 namespace 落这里
}
```

- 当 provider 的 `settingsNs` 不是 `llm-deepseek` / `llm-pi-ai` 时，编辑器渲染成 `layout === "unknown"` 分支，只显示一行「其余字段在 settings.yaml 中，请直接编辑对应段」，**没有表单、提交按钮禁用**。
- 官方「添加自定义提供方」按钮（`customAdd`）硬编码写入 `llm-pi-ai` namespace（`const NS$1 = "llm-pi-ai"`），走的是官方适配器 → **会丢 `supportsDeveloperRole`**，content_filter 复发。

**结论**：本插件的 namespace 是 `thinking-api`，无法复用官方模型页的表单。必须**自建一个独立的设置面板**。

---

## 1. 技术可行性（已验证）

DSH 设置页通过 **`settings.section` slot** 开放扩展。任何插件（含第三方）都能注册自定义设置面板。官方 models 页本身就是这么挂上去的：

```js
ctx.slots.inject("settings.section", () => ctx.slots.register({
  name: "settings.section",
  id: "models",          // 面板唯一 id
  order: 10,             // 排序
  label: () => t("nav"), // 导航栏文案
  inject: injected,      // 返回 { controller, useSnapshot, api, t }
}, ModelsSection))       // 渲染组件
```

**注入契约**（`injected()` 返回，作为组件的 props）：

| 字段 | 来源 | 用途 |
|---|---|---|
| `api` | `connection.api` | wire face：`api.settings` / `api.credentials` / `api.llm` |
| `t` | `ctx.locale.bind(NS)` | 文案 |
| `useSnapshot` | `bindSnapshotSelector(store)` | 响应式读取 store 快照 |
| `controller` | 自建 store | 面板数据源 |

**关键 wire 方法（面板读写配置全靠它们）**：

```js
// 读
api.settings.describe({})            // → { writable, namespaces: [{ns, schema, value, user, base, revision}] }
api.credentials.describe({ refs })   // → { credentials: { [ref]: {configured, writable} } }
api.llm.providers({})                // → { providers: LlmConfigurableProvider[] }

// 写
api.settings.mutate({ ns, ops: [{op:"set"|"unset", path:[...], value}] })
api.credentials.set({ ref, value })
api.credentials.unset({ ref })

// 探测
api.llm.discoverModels({ provider?, baseURL?, api?, apiKey?, signal? })
```

> 已在官方 models 页源码（`ModelsSettingsStore.load`、`ProviderEditor`、`CustomProviderCard`）中逐行确认。

---

## 2. 目标形态（面板长什么样）

在「设置」导航里新增一项 **「Thinking API」**（与「模型」「通用」「插件」并列），点进去是一个独立面板：

```
┌───────────────────────────────────────────────┐
│  Thinking API   一键接入带思考模式的第三方 API  │
│                                               │
│  ── 快速模板 ────────────────────────────────  │
│  [CodeBuddy ▾]  API Key: [________]  [启用]   │
│  [OpenRouter ▾] API Key: [________]  [启用]   │
│  [SiliconFlow▾] API Key: [________]  [启用]   │
│  ...                                          │
│                                               │
│  ── 已接入 ──────────────────────────────────  │
│  ▪ CodeBuddy Thinking API          [编辑][删除]│
│  ▪ 我的中转站 (my-proxy)           [编辑][删除]│
│                                               │
│  ── 自由添加 ─────────────────────────────────  │
│  [+ 添加自定义 API]                            │
│    Route ID:    [my-proxy]                     │
│    显示名:      [我的中转站]                    │
│    Base URL:    [https://...]                  │
│    API Key:     [________]                     │
│    思考模式:    ☑ 开启   格式:[deepseek ▾]     │
│    模型:        [获取模型列表] / 手动添加       │
│    [保存]                                      │
└───────────────────────────────────────────────┘
```

**核心交互**：
- 模板区：选一个模板 → 填 key → 「启用」，即写入 `thinking-api.providers.<route>`，立即可在模型选择器里用。
- 已接入区：列出所有已配置 provider，可编辑/删除。
- 自由添加：填表单 → 「获取模型列表」自动探测端点 /models → 勾选 → 保存。

---

## 3. 文件与结构

插件从「纯 host」升级为「host + client」双端。参考 `@dsh-external/dsh-plugin-tts` 的 `dsh.client` 声明。

```
dsh-plugin-thinking-api/
├── lib/
│   ├── index.mjs        # host 端（现有，微调：暴露 templates 供 client 复用）
│   └── client.js        # ★ 新增：client 端设置面板（settings.section 组件）
├── package.json         # 增加 dsh.client 声明
├── cordis.patch.yml     # 不变（bundles insert 已含 client 注入由 dsh.client 驱动）
├── README.md / README.zh-CN.md
└── DESIGN-GUI.md        # 本文档
```

### 3.1 `package.json` 变更

在 `dsh` 块加 `client` 声明（对齐 tts 插件）：

```json
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": {
    "platform": "web",
    "inject": [
      "@deepseek-ai/dsh-client-runtime",
      "@deepseek-ai/dsh-client-ui-slots",
      "@deepseek-ai/dsh-client-connection",
      "@deepseek-ai/dsh-client-locale"
    ]
  }
}
```

peerDependencies 增加 client 端依赖：

```json
"peerDependencies": {
  ...（现有 host peer 不变）,
  "@deepseek-ai/dsh-web": "^0.1.0-rc.6",
  "react": "^18.2.0"
}
```

### 3.2 host 端 `lib/index.mjs` 微调

- 新增导出 `templates`：内置模板定义（route id、displayName、baseURL、默认模型、thinkingFormat、模型思考档位），供 client 面板复用，也保证 host/client 行为一致。
- `directoryEntries` / `registerConfigurableProviders` **保留**：让「设置 → 模型」页仍能显示已配置的 provider 行（只读展示 + 删除），但编辑表单由本插件的独立面板承担。
- `registerModelDiscovery` **保留**：供「获取模型列表」按钮复用。

### 3.3 client 端 `lib/client.js`（新增，核心）

按 `settings.section` slot 契约实现：

1. **`export const inject`**：`["slots","locale","connection","runtime"]`（对齐官方 models 插件的 inject）。
2. **`apply(ctx)`**：
   - `ctx.effect` 注册 locale 字典（zh/en）；
   - 建立 `ThinkingApiStore`（仿 `ModelsSettingsStore`：`load()` 并行拉 `settings.describe` + `credentials.describe` + `llm.providers`，`mutate()` 写回）；
   - `ctx.slots.inject("settings.section", ...)` 注册面板（`id: "thinking-api"`, `order: 20`, `label: () => t("nav")`）。
3. **面板组件 `ThinkingApiSection`**：
   - **模板区**：遍历 `templates`，每个模板一个「选模板 + 填 key + 启用」行；
   - **已接入区**：列 `thinking-api.providers`，编辑/删除；
   - **自由添加区**：表单 + 「获取模型列表」（调 `api.llm.discoverModels`）+ 保存。

### 3.4 模板定义（`templates`，host/client 共享）

> 已确认：**多加点国产模板**。模板只提供**默认值**（baseURL、默认模型、思考档位），key 由用户填写，模型列表用户可「获取模型列表」刷新。模板本身不绑定 key。

| route id | displayName | baseURL | thinkingFormat | 说明 |
|---|---|---|---|---|
| `codebuddy` | CodeBuddy | `https://copilot.tencent.com/v2` | deepseek | 腾讯 CodeBuddy 网关 |
| `deepseek` | DeepSeek | `https://api.deepseek.com` | deepseek | DeepSeek 官方 |
| `openrouter` | OpenRouter | `https://openrouter.ai/api/v1` | openrouter | 聚合网关 |
| `siliconflow` | SiliconFlow | `https://api.siliconflow.cn/v1` | deepseek | 硅基流动 |
| `moonshot` | Moonshot | `https://api.moonshot.cn/v1` | openai | 月之暗面 |
| `zhipu` | 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | openai | 智谱清言 |
| `qwen` | 通义千问 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | qwen | 阿里 DashScope |
| `volcengine` | 火山引擎 | `https://ark.cn-beijing.volces.com/api/v3` | deepseek | 字节豆包 |
| `baichuan` | 百川 | `https://api.baichuan-ai.com/v1` | openai | 百川智能 |
| `minimax` | MiniMax | `https://api.minimax.chat/v1` | openai | MiniMax |
| `stepfun` | 阶跃星辰 | `https://api.stepfun.com/v1` | openai | StepFun |
| `hunyuan` | 腾讯混元 | `https://api.hunyuan.cloud.tencent.com/v1` | openai | 腾讯混元 |

> 模板清单可随时增删；每个模板的 `thinkingFormat` 按厂商最兼容的方言标注，用户可在面板「格式」下拉里改。

---

## 4. 关键实现细节

### 4.1 配置读写路径（全部走 `thinking-api` namespace）

- 读：`settings.describe()` 里取 `namespaces.find(n => n.ns === "thinking-api")` 的 `.value.providers`。
- 写：`settings.mutate({ ns: "thinking-api", ops: [{ op: "set", path: ["providers", route], value: profile }] })`。
- 删：`ops: [{ op: "unset", path: ["providers", route] }]`。
- Key：`credentials.set({ ref: "<ROUTE>_API_KEY", value })`（`deriveKeyRef(route)` = `${route.toUpperCase()}_API_KEY` 风格，或直接沿用 `apiKeyEnv` 字段名）。

### 4.2 思考模式字段（与现有 host schema 对齐）

每个 provider 的 `models.<id>.thinking`（bool）+ `thinkingEfforts`（档位映射）+ `thinkingFormat`（provider 级）。面板里的「思考模式开关」映射到 `models.<id>.thinking = true/false`；「格式」下拉映射 `provider.thinkingFormat`。

### 4.3 「获取模型列表」按钮

调 `api.llm.discoverModels({ baseURL, apiKey })`（host 端 `registerModelDiscovery` 已实现同逻辑，client 复用 wire 即可）。返回 `[{id, name?, contextWindow?, maxTokens?}]`，填充进「模型」列表，每个默认 `thinking: true`。

### 4.4 容错

- `settings.describe` / `credentials.describe` 失败 → 显示错误 + 重试，保留上次快照（对齐 `ModelsSettingsStore` 的 `generation` 最新写入胜出机制）。
- 写入失败 → toast 显示 `api.settings.mutate` 返回的 `result.error.message`。
- 空 providers → 面板正常显示模板区 + 自由添加区（host 端已修「空名单跳过」）。

---

## 5. 实现步骤（建议顺序）

1. **host 端**：导出 `templates`；确认现有 `registerConfigurableProviders` + `registerModelDiscovery` 逻辑不变。
2. **package.json**：加 `dsh.client` 声明 + client peer 依赖。
3. **client 端骨架**：`lib/client.js` 最小面板（只显示「已接入」列表 + 一个「自由添加」表单），先跑通 `settings.section` 注册 + 读写。
4. **模板区**：加入模板下拉 + 「启用」。
5. **模型探测**：接入「获取模型列表」。
6. **真机验证**：重装插件（`pnpm install` 重新复制 file 副本）→ 重启 DSH → 设置页看「Thinking API」面板 → 模板启用 + 自由添加 + 发消息验证无 content_filter + 思考模式。
7. **文档**：更新 README（中英）说明「一键配置」用法。

---

## 6. 风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| client 端构建/打包复杂度 | 面板不渲染 | 参考 tts 插件已跑通的 `dsh.client` 结构，最小可用先行 |
| `settings.section` 契约细节变化 | 面板挂载失败 | 逐字段对齐官方 models 插件的 `slots.register` 用法 |
| file: 依赖复制不同步 | 改了源码 DSH 还跑旧版 | 每次改完 `rm -rf node_modules/dsh-plugin-thinking-api && pnpm install` |
| 第三方端点 /models 不通 | 「获取模型列表」失败 | 允许手动填模型 ID，探测失败给明确提示 |
| `apiKeyEnv` 命名冲突 | 多 route 用同一 env 名 | 默认 `${route.toUpperCase()}_API_KEY`，可手动改 |

---

## 7. 已确认决策（2026-08-16）

1. **模板清单**：多加点国产模板（CodeBuddy / DeepSeek / OpenRouter / SiliconFlow / Moonshot / 智谱 / 通义千问 / 火山引擎 / 百川 / MiniMax / 阶跃星辰 / 腾讯混元）。
2. **面板命名**：设置导航项叫 **「思考 API」**（中文；英文 "Thinking API"）。locale 字典里 zh nav = "思考 API"，en nav = "Thinking API"。
3. **官方模型页**：**保留展示**——官方「模型」页仍显示已接入的 provider 行（只读展示 + 删除），编辑统一走本插件「思考 API」面板。
