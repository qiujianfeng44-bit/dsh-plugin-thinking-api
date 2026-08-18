# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **GitHub Actions CI**（`.github/workflows/check.yml`）：每次 push/PR 自动跑语法检查
  （`npm run check`）+ npm 包体检（tarball 文件清单、版本号比对），升级 DSH 前的
  `check-compat` 契约自检仍建议在真实 DSH workspace 上手动跑。
- **示例配置** `examples/settings.yaml`：CodeBuddy / 自建 vLLM / 任意 OpenAI 兼容
  中转站三个可直接复制的模板。
- **Issue 模板** `.github/ISSUE_TEMPLATE/bug_report.yml`：报 bug 时自动收集 DSH 版本、
  插件版本、check-compat 输出。
- **README**：CI 徽章、示例配置引用、参与贡献指引（中英双语）。

## [0.1.2] - 2026-08-18

### Changed

- 仓库地址更新为新的 GitHub 用户名 `qjf44`（`repository.url`、README 安装命令、
  PUBLISH-CHECKLIST 中的链接全部同步）。旧地址会自动 301 重定向。

## [0.1.1] - 2026-08-18

### Fixed

- **pi-ai 0.82.1 auth 契约兼容**：`buildProvider` 的 provider auth 由顶层 `resolve`
  改为 `{ apiKey: { name, resolve } }`（与官方 `dsh-llm-pi-ai` 的
  `routeAuth`/`harnessApiKeyAuth` 形态一致）。旧形态在 pi-ai 0.82.1 下会被
  `resolveProviderAuth` 判定为「无认证方式」，请求 100% 报
  `PI_AI_ERROR: Provider is not configured: <route>`。
- **GUI 向导编辑时不再丢失 apiKeyEnv**：编辑已有 provider 时 API Key 输入框留空
  表示「不改」，保存时沿用原有的 `apiKeyEnv`（此前会把密钥引用直接抹掉，
  导致 `MISSING_CREDENTIAL` / 认证失效）。

### Added

- **启动时契约自检 `assertPiAiContract`**：`apply()` 开头用真实 `createProvider` +
  `openAICompletionsApi()` 探测 pi-ai 的 provider auth 形状与 Provider 流式接口；
  契约变化时在启动阶段直接报清晰错误（点名是哪个契约变了），而不是等用户
  发消息才看到迷惑报错。
- **`scripts/check-compat.mjs` 兼容性自检脚本**：逐项核对插件在真实依赖下的
  import、`PiAiAdapter` 构造器形状、pi-ai provider auth 形状、Provider 流式接口、
  `llm` 服务注册方法、settings/credentials 辅助函数。升级 DSH / pi-ai 后先跑
  `npm run check:compat`（只读、不挡启动），全 ✓ 再重启。运行方式：
  `node scripts/check-compat.mjs --workspace <DSH workspace 根>`。

## [0.1.0] - 2026-08-16

### Added

- 一键配置任意 OpenAI 兼容 API（腾讯 CodeBuddy / 自建 vLLM / 中转站等），
  自动带思考模式（`thinking: true` 即获得思考档位）。
- 修复 `content_filter` / `developer` 角色问题：自行组装 pi-ai 模型并注入
  `compat.supportsDeveloperRole: false`，强制走 `system` 角色，规避第三方端点
  对 `developer` 角色的硬性拦截。
- Web 面板「设置 → 思考 API」：模板/自定义接入向导、获取模型列表、编辑/删除。
- 复用官方 `PiAiAdapter`（流式、chunk 翻译、凭据解析、空闲超时看门狗随 DSH 演进）。
