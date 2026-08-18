// dsh-plugin-thinking-api — Client half（浏览器 bundle）。
// 手写在 DSH module-loader 格式：`require` 回答平台外部依赖，其余内联。
// 注册「设置 → 思考 API」面板：统一接入向导（模板/自定义一处走完），走修复版适配器。
window.__ModuleLoader__.load({
  id: "dsh-plugin-thinking-api",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const { createSnapshotStore } = require("@deepseek-ai/dsh-client-runtime/client");
    // 不依赖 dsh-client-web-react（非独立 bundle），用 React 18 原生 useSyncExternalStore
    // 直接订阅 createSnapshotStore 返回的 { getSnapshot, subscribe }，与官方 bindSnapshotSelector 等价。
    const useSyncExternalStore = React.useSyncExternalStore;

    const NS = "thinking-api";

    // 注意：此表必须与 lib/index.mjs 里的 templates 保持一致（跨端无法直接 import）。
    /** 模板清单（含默认模型，「填 key 即用」的兜底）。 */
    const TEMPLATES = [
      { route: "codebuddy", displayName: "CodeBuddy", baseURL: "https://copilot.tencent.com/v2", thinkingFormat: "deepseek", models: { "deepseek-v4-pro": { name: "DeepSeek V4 Pro", thinking: true }, "deepseek-v4-flash": { name: "DeepSeek V4 Flash", thinking: false } } },
      { route: "deepseek", displayName: "DeepSeek", baseURL: "https://api.deepseek.com", thinkingFormat: "deepseek", models: { "deepseek-v4-pro": { name: "DeepSeek V4 Pro", thinking: true }, "deepseek-v4-flash": { name: "DeepSeek V4 Flash", thinking: false } } },
      { route: "openrouter", displayName: "OpenRouter", baseURL: "https://openrouter.ai/api/v1", thinkingFormat: "openrouter", models: { "deepseek/deepseek-chat-v3-0324": { name: "DeepSeek Chat V3", thinking: false } } },
      { route: "siliconflow", displayName: "SiliconFlow", baseURL: "https://api.siliconflow.cn/v1", thinkingFormat: "deepseek", models: { "deepseek-ai/DeepSeek-V3": { name: "DeepSeek V3", thinking: false }, "deepseek-ai/DeepSeek-R1": { name: "DeepSeek R1", thinking: true } } },
      { route: "moonshot", displayName: "Moonshot", baseURL: "https://api.moonshot.cn/v1", thinkingFormat: "openai", models: { "kimi-k2-thinking": { name: "Kimi K2 Thinking", thinking: true }, "kimi-k2-turbo-preview": { name: "Kimi K2 Turbo", thinking: false } } },
      { route: "zhipu", displayName: "智谱 GLM", baseURL: "https://open.bigmodel.cn/api/paas/v4", thinkingFormat: "openai", models: { "glm-4.5": { name: "GLM-4.5", thinking: false }, "glm-4.5-air": { name: "GLM-4.5 Air", thinking: false } } },
      { route: "qwen", displayName: "通义千问", baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1", thinkingFormat: "qwen", models: { "qwen-max": { name: "Qwen Max", thinking: false }, "qwen3-max": { name: "Qwen3 Max", thinking: true } } },
      { route: "volcengine", displayName: "火山引擎", baseURL: "https://ark.cn-beijing.volces.com/api/v3", thinkingFormat: "deepseek", models: { "deepseek-v4-pro": { name: "DeepSeek V4 Pro", thinking: true } } },
      { route: "baichuan", displayName: "百川", baseURL: "https://api.baichuan-ai.com/v1", thinkingFormat: "openai", models: { "Baichuan4": { name: "Baichuan4", thinking: false } } },
      { route: "minimax", displayName: "MiniMax", baseURL: "https://api.minimax.chat/v1", thinkingFormat: "openai", models: { "MiniMax-M1": { name: "MiniMax M1", thinking: true } } },
      { route: "stepfun", displayName: "阶跃星辰", baseURL: "https://api.stepfun.com/v1", thinkingFormat: "openai", models: { "step-2-16k": { name: "Step 2 16K", thinking: false } } },
      { route: "hunyuan", displayName: "腾讯混元", baseURL: "https://api.hunyuan.cloud.tencent.com/v1", thinkingFormat: "openai", models: { "hunyuan-turbo": { name: "Hunyuan Turbo", thinking: false }, "hunyuan-t1-latest": { name: "Hunyuan T1", thinking: true } } },
    ];

    const THINKING_FORMATS = [
      "deepseek", "openai", "openrouter", "together", "zai", "qwen", "string-thinking",
    ];

    /** 从 provider route 派生凭证名（对齐官方 deriveKeyRef）。 */
    function deriveKeyRef(provider) {
      return `${provider.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
    }

    /** 按模型 id/名启发式推断是否思考模型（探测结果用；模板预置以模板元数据为准）。 */
    function guessThinking(id, name) {
      const s = `${id || ""} ${name || ""}`.toLowerCase();
      if (/(think|reasoning|\br1\b|-r1\b|\bo1\b|\bo3\b|-pro\b)/.test(s)) return true;
      if (/(flash|lite|mini|turbo|air|small|nano)/.test(s)) return false;
      return false;
    }

    /** 极简 CSS（内联，避免引入构建链）。 */
    const CSS = `
      .thinking-api-root { max-width: 720px; display: flex; flex-direction: column; gap: 16px; }
      .thinking-api-card { border: 1px solid var(--dsw-alias-border-l2); border-radius: 12px; padding: 14px 16px; display: flex; flex-direction: column; gap: 12px; }
      .thinking-api-title { margin: 0; font-size: 16px; font-weight: 500; color: var(--dsw-alias-label-primary); }
      .thinking-api-sub { margin: 0; font-size: 13px; color: var(--dsw-alias-label-tertiary); }
      .thinking-api-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .thinking-api-field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 200px; }
      .thinking-api-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
      .thinking-api-input, .thinking-api-select { height: 32px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); padding: 0 10px; font-size: 14px; font-family: inherit; }
      .thinking-api-btn { height: 32px; padding: 0 14px; border: none; border-radius: 16px; cursor: pointer; font-size: 13px; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
      .thinking-api-btn:disabled { opacity: 0.4; cursor: default; }
      .thinking-api-btn-ghost { background: transparent; border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
      .thinking-api-btn-danger { background: transparent; border: 1px solid var(--dsw-alias-state-error-primary); color: var(--dsw-alias-state-error-primary); }
      .thinking-api-err { font-size: 12px; color: var(--dsw-alias-state-error-primary); margin: 0; }
      .thinking-api-ok { font-size: 12px; color: var(--dsw-alias-state-success-primary); margin: 0; }
      .thinking-api-list { display: flex; flex-direction: column; gap: 8px; }
      .thinking-api-item { display: flex; align-items: center; gap: 10px; border: 1px solid var(--dsw-alias-border-l2); border-radius: 10px; padding: 10px 12px; }
      .thinking-api-item-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 14px; }
      .thinking-api-item-route { font-size: 12px; color: var(--dsw-alias-label-tertiary); }
      .thinking-api-divider { border: none; border-top: 1px solid var(--dsw-alias-border-l2); margin: 4px 0; }
      .thinking-api-model-id { flex: 1; min-width: 140px; }
      .thinking-api-model-name { flex: 1.4; min-width: 140px; }
      .thinking-api-x { width: 28px; height: 28px; padding: 0; border-radius: 14px; display: inline-flex; align-items: center; justify-content: center; }
    `;

    /** 面板数据 store（对齐 ModelsSettingsStore 的「最新写入胜出」策略）。 */
    class ThinkingApiStore {
      constructor(api) {
        this.api = api;
        this.generation = 0;
        this.store = createSnapshotStore({
          status: "idle",
          error: null,
          writable: false,
          providers: {},
          credentials: {},
        });
      }
      async load() {
        const generation = ++this.generation;
        this.store.update((s) => { s.status = "loading"; s.error = null; });
        try {
          const settingsResponse = await this.api.settings.describe({});
          if (generation !== this.generation) return;
          if (!settingsResponse.result.ok) throw new Error(settingsResponse.result.error.message);
          const namespaces = settingsResponse.result.value.namespaces;
          const view = namespaces.find((n) => n.ns === NS);
          const providers = (view && view.value && view.value.providers) || {};
          const writable = settingsResponse.result.value.writable;

          // 根据本次拿到的 providers 派生凭证引用，再查凭证状态。
          const refs = Object.values(providers)
            .map((p) => p && p.apiKeyEnv)
            .filter((ref) => typeof ref === "string" && ref.length > 0);
          let credentials = {};
          if (refs.length > 0) {
            const credsResponse = await this.api.credentials.describe({ refs });
            if (credsResponse.result.ok) credentials = credsResponse.result.value.credentials;
          }

          this.store.update((s) => {
            s.status = "ready";
            s.error = null;
            s.writable = writable;
            s.providers = providers;
            s.credentials = credentials;
          });
        } catch (error) {
          if (generation !== this.generation) return;
          this.store.update((s) => { s.status = "error"; s.error = error.message || String(error); });
        }
      }
      /** 写入一个 provider（set path op），返回失败信息或 undefined。 */
      async saveProvider(route, profile, keyValue) {
        const keyRef = deriveKeyRef(route);
        const storesKey = keyValue && keyValue.trim().length > 0;
        const response = await this.api.settings.mutate({
          ns: NS,
          ops: [{ op: "set", path: ["providers", route], value: profile }],
        });
        if (!response.result.ok) return response.result.error.message;
        if (storesKey) {
          const stored = await this.api.credentials.set({ ref: keyRef, value: keyValue.trim() });
          // settings 已落盘但密钥未写入：明确提示（重试保存即可，密钥 set 是幂等的）。
          if (!stored.result.ok) return `Provider saved, but the API key could not be stored (${stored.result.error.message}). Re-save to retry.`;
        }
        await this.load();
        return undefined;
      }
      /** 删除一个 provider（unset path op + 清凭证）。 */
      async removeProvider(route) {
        const keyRef = deriveKeyRef(route);
        await this.api.credentials.unset({ ref: keyRef }).catch(() => {});
        const response = await this.api.settings.mutate({
          ns: NS,
          ops: [{ op: "unset", path: ["providers", route] }],
        });
        if (!response.result.ok) return response.result.error.message;
        await this.load();
        return undefined;
      }
      /** 探测模型列表。 */
      async discoverModels(baseURL, apiKey, settingsNs) {
        const response = await this.api.llm.discoverModels({
          settingsNs: settingsNs || NS,
          baseURL,
          ...(apiKey && apiKey.trim().length > 0 ? { apiKey: apiKey.trim() } : {}),
        });
        if (!response.result.ok) throw new Error(response.result.error.message);
        return response.result.value.models;
      }
    }

    const e = React.createElement;

    /**
     * 统一接入向导：一个入口服务「模板」和「自定义」两种来源，也复用为「编辑」表单。
     * 流程：选来源 → 填 key → 模型（模板兜底 / 探测自动标思考 / 手填追加）→ 保存。
     */
    function Wizard({ api, store, t, existingRoutes, editTarget, onSaved, onEditCancel }) {
      const [source, setSource] = React.useState("custom"); // 模板 route id 或 "custom"
      const [route, setRoute] = React.useState("");
      const [displayName, setDisplayName] = React.useState("");
      const [baseURL, setBaseURL] = React.useState("");
      const [thinkingFormat, setThinkingFormat] = React.useState("deepseek");
      const [key, setKey] = React.useState("");
      const [rows, setRows] = React.useState([]); // [{id, name, thinking}]
      const [addText, setAddText] = React.useState("");
      const [busy, setBusy] = React.useState(false);
      const [fetching, setFetching] = React.useState(false);
      const [failure, setFailure] = React.useState(undefined);
      const [saved, setSaved] = React.useState(false);
      const [editingRoute, setEditingRoute] = React.useState(undefined);

      // 选择模板：带出 route / baseURL / displayName / thinkingFormat / 默认模型。
      const pickTemplate = (templateRoute) => {
        setSource(templateRoute);
        setSaved(false);
        setFailure(undefined);
        if (templateRoute === "custom") {
          setRoute("");
          setDisplayName("");
          setBaseURL("");
          setThinkingFormat("deepseek");
          setRows([]);
          setKey("");
          return;
        }
        const tpl = TEMPLATES.find((x) => x.route === templateRoute);
        if (!tpl) return;
        setRoute(tpl.route);
        setDisplayName(tpl.displayName);
        setBaseURL(tpl.baseURL);
        setThinkingFormat(tpl.thinkingFormat);
        setRows(Object.entries(tpl.models || {}).map(([id, m]) => ({
          id, name: m && m.name || id, thinking: !!(m && m.thinking),
        })));
        setKey("");
      };

      // 编辑已有 provider：回填表单，route 只读，key 留空表示「不改」。
      React.useEffect(() => {
        if (editTarget === undefined || editTarget === null) {
          setEditingRoute(undefined);
          return;
        }
        const p = editTarget.provider || {};
        setEditingRoute(editTarget.route);
        setSource("custom");
        setRoute(editTarget.route);
        setDisplayName(p.displayName || editTarget.route);
        setBaseURL(p.baseURL || "");
        setThinkingFormat(p.thinkingFormat || "deepseek");
        setKey("");
        setRows(Object.entries(p.models || {}).map(([id, m]) => ({
          id, name: (m && m.name) || id, thinking: !!(m && m.thinking),
        })));
        setFailure(undefined);
        setSaved(false);
      }, [editTarget]);

      const isEditing = editingRoute !== undefined;
      const routeInvalid = route.trim().length === 0 || !/^[a-zA-Z0-9_-]+$/.test(route.trim());
      const routeTaken = !isEditing && existingRoutes.includes(route.trim());
      const ready = !routeInvalid && !routeTaken && baseURL.trim().length > 0 && rows.length > 0;

      const fetchModels = async () => {
        setFetching(true);
        setFailure(undefined);
        try {
          const found = await store.discoverModels(baseURL.trim(), key);
          const next = found.map((m) => ({ id: m.id, name: m.name || m.id, thinking: guessThinking(m.id, m.name) }));
          setRows(next);
        } catch (err) {
          setFailure(err.message || String(err));
        } finally {
          setFetching(false);
        }
      };

      const addRows = () => {
        const ids = addText.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
        if (ids.length === 0) return;
        const known = new Map(rows.map((r) => [r.id, r]));
        const next = rows.slice();
        for (const id of ids) {
          if (known.has(id)) continue;
          next.push({ id, name: id, thinking: guessThinking(id, "") });
          known.set(id, true);
        }
        setRows(next);
        setAddText("");
      };

      const patchRow = (index, patch) => setRows(rows.map((r, i) => (i === index ? { ...r, ...patch } : r)));
      const removeRow = (index) => setRows(rows.filter((_, i) => i !== index));

      const save = async () => {
        setBusy(true);
        setFailure(undefined);
        const modelEntries = {};
        for (const r of rows) {
          const id = r.id.trim();
          if (!id) continue;
          modelEntries[id] = {
            name: (r.name && r.name.trim()) || id,
            ...(r.thinking ? { thinking: true } : {}),
          };
        }
        const profile = {
          ...(displayName.trim().length > 0 ? { displayName: displayName.trim() } : {}),
          baseURL: baseURL.trim(),
          // ★ 防丢 key：编辑模式下 key 留空表示「不改」，必须沿用已有的 apiKeyEnv，
          //   否则保存会把原凭证引用抹掉（这正是上次更新后 codebuddy 报
          //   MISSING_CREDENTIAL / 认证失效的根因之一）。
          ...(key.trim().length > 0
            ? { apiKeyEnv: deriveKeyRef(route.trim()) }
            : isEditing && editTarget.provider && editTarget.provider.apiKeyEnv
              ? { apiKeyEnv: editTarget.provider.apiKeyEnv }
              : {}),
          thinkingFormat,
          models: modelEntries,
        };
        const failure = await store.saveProvider(route.trim(), profile, key);
        setBusy(false);
        if (failure !== undefined) { setFailure(failure); return; }
        setSaved(true);
        setKey("");
        // 保存成功后重置向导（编辑模式退出）。
        if (isEditing) { setEditingRoute(undefined); onEditCancel && onEditCancel(); }
        setSource("custom");
        setRoute("");
        setDisplayName("");
        setBaseURL("");
        setRows([]);
        onSaved && onSaved();
      };

      const templateOptions = [
        e("option", { value: "custom", key: "custom" }, t("customOption")),
      ].concat(TEMPLATES.map((tpl) => e("option", { value: tpl.route, key: tpl.route }, tpl.displayName)));

      return e("div", { className: "thinking-api-card" },
        // 来源
        e("div", { className: "thinking-api-row" },
          e("div", { className: "thinking-api-field", style: { maxWidth: 240 } },
            e("span", { className: "thinking-api-label" }, t("source")),
            e("select", {
              className: "thinking-api-select",
              value: isEditing ? "custom" : source,
              disabled: isEditing,
              onChange: (ev) => pickTemplate(ev.target.value),
            }, templateOptions),
          ),
          e("div", { className: "thinking-api-field" },
            e("span", { className: "thinking-api-label" }, t("routeId")),
            e("input", {
              className: "thinking-api-input",
              value: route,
              placeholder: "my-proxy",
              disabled: isEditing || source !== "custom",
              onChange: (ev) => setRoute(ev.target.value),
            }),
          ),
          e("div", { className: "thinking-api-field" },
            e("span", { className: "thinking-api-label" }, t("displayNameLabel")),
            e("input", { className: "thinking-api-input", value: displayName, placeholder: t("displayNamePlaceholder"), onChange: (ev) => setDisplayName(ev.target.value) }),
          ),
        ),
        // 地址 / key / 方言
        e("div", { className: "thinking-api-row" },
          e("div", { className: "thinking-api-field" },
            e("span", { className: "thinking-api-label" }, t("baseURL")),
            e("input", { className: "thinking-api-input", value: baseURL, placeholder: "https://...", onChange: (ev) => setBaseURL(ev.target.value) }),
          ),
          e("div", { className: "thinking-api-field" },
            e("span", { className: "thinking-api-label" }, t("apiKey") + (isEditing ? " (" + t("leaveBlank") + ")" : "")),
            e("input", { className: "thinking-api-input", type: "password", value: key, placeholder: t("apiKeyPlaceholder"), onChange: (ev) => setKey(ev.target.value) }),
          ),
          e("div", { className: "thinking-api-field", style: { maxWidth: 220 } },
            e("span", { className: "thinking-api-label" }, t("thinkingFormat")),
            e("select", { className: "thinking-api-select", value: thinkingFormat, onChange: (ev) => setThinkingFormat(ev.target.value) },
              THINKING_FORMATS.map((f) => e("option", { value: f, key: f }, f)),
            ),
          ),
        ),
        // 模型区
        e("div", { className: "thinking-api-row" },
          e("div", { className: "thinking-api-field" },
            e("span", { className: "thinking-api-label" }, t("models")),
            e("input", { className: "thinking-api-input", value: addText, placeholder: t("modelsPlaceholder"), onChange: (ev) => setAddText(ev.target.value), onKeyDown: (ev) => { if (ev.key === "Enter") addRows(); } }),
          ),
          e("button", { className: "thinking-api-btn thinking-api-btn-ghost", onClick: addRows }, t("add")),
          e("button", { className: "thinking-api-btn thinking-api-btn-ghost", disabled: fetching || baseURL.trim().length === 0, onClick: fetchModels }, fetching ? t("fetching") : t("fetchModels")),
        ),
        rows.length > 0
          ? e("div", { className: "thinking-api-list" },
            rows.map((r, i) => e("div", { className: "thinking-api-item", key: `${r.id}-${i}` },
              e("input", { type: "checkbox", checked: !!r.thinking, onChange: (ev) => patchRow(i, { thinking: ev.target.checked }) }),
              e("input", { className: "thinking-api-input thinking-api-model-id", value: r.id, onChange: (ev) => patchRow(i, { id: ev.target.value }) }),
              e("input", { className: "thinking-api-input thinking-api-model-name", value: r.name, onChange: (ev) => patchRow(i, { name: ev.target.value }) }),
              e("button", { className: "thinking-api-btn thinking-api-btn-danger thinking-api-x", onClick: () => removeRow(i), title: t("remove") }, "×"),
            )),
            e("p", { className: "thinking-api-sub" }, t("modelsHint")),
          )
          : null,
        routeTaken ? e("p", { className: "thinking-api-err" }, t("routeTaken")) : null,
        failure !== undefined ? e("p", { className: "thinking-api-err" }, failure) : null,
        saved && failure === undefined ? e("p", { className: "thinking-api-ok" }, t("saved")) : null,
        e("div", { className: "thinking-api-row", style: { justifyContent: "flex-end" } },
          isEditing ? e("button", { className: "thinking-api-btn thinking-api-btn-ghost", onClick: () => { setEditingRoute(undefined); onEditCancel && onEditCancel(); } }, t("cancel")) : null,
          e("button", { className: "thinking-api-btn", disabled: busy || !ready, onClick: save }, t("save")),
        ),
      );
    }

    /** 已接入列表。 */
    function ProviderList({ providers, store, t, onRemoved, onEdit }) {
      const [failure, setFailure] = React.useState(undefined);
      const routes = Object.keys(providers);
      if (routes.length === 0) {
        return e("p", { className: "thinking-api-sub" }, t("empty"));
      }
      return e("div", { className: "thinking-api-list" },
        routes.map((route) => {
          const p = providers[route] || {};
          const remove = async () => {
            setFailure(undefined);
            const f = await store.removeProvider(route);
            if (f !== undefined) { setFailure(f); return; }
            onRemoved && onRemoved();
          };
          return e("div", { className: "thinking-api-item", key: route },
            e("div", { style: { flex: 1, minWidth: 0 } },
              e("div", { className: "thinking-api-item-name" }, p.displayName || route),
              e("div", { className: "thinking-api-item-route" }, `${route} · ${p.baseURL || ""}`),
            ),
            e("button", { className: "thinking-api-btn thinking-api-btn-ghost", onClick: () => onEdit && onEdit(route, p) }, t("edit")),
            e("button", { className: "thinking-api-btn thinking-api-btn-danger", onClick: remove }, t("remove")),
          );
        }),
        failure !== undefined ? e("p", { className: "thinking-api-err" }, failure) : null,
      );
    }

    /** 面板主体。 */
    function Section(props) {
      const { controller, api, t } = props;
      // 用 React 18 原生 useSyncExternalStore 订阅 store，等价于官方 bindSnapshotSelector。
      const state = useSyncExternalStore(
        (fn) => controller.store.subscribe(fn),
        () => controller.store.getSnapshot(),
      );
      const [editTarget, setEditTarget] = React.useState(undefined);
      React.useEffect(() => {
        if (state.status === "idle") controller.load();
      }, [controller, state.status]);

      if (state.status === "idle" || state.status === "loading") {
        return e("div", { className: "thinking-api-root" }, e("p", { className: "thinking-api-sub" }, t("loading")));
      }
      if (state.status === "error") {
        return e("div", { className: "thinking-api-root" },
          e("p", { className: "thinking-api-err" }, `${t("loadFailed")}: ${state.error}`),
          e("button", { className: "thinking-api-btn", onClick: () => controller.load() }, t("retry")),
        );
      }

      const providers = state.providers || {};
      const existingRoutes = Object.keys(providers);
      const reload = () => { controller.load(); };

      return e("div", { className: "thinking-api-root" },
        e("style", {}, CSS),
        e("h2", { className: "thinking-api-title" }, t("title")),
        e("p", { className: "thinking-api-sub" }, t("intro")),
        !state.writable ? e("p", { className: "thinking-api-err" }, t("readOnly")) : null,

        e("h3", { className: "thinking-api-title", style: { fontSize: 14 } }, t("wizard")),
        e(Wizard, {
          api, store: controller, t, existingRoutes, editTarget,
          onSaved: reload,
          onEditCancel: () => setEditTarget(undefined),
        }),

        e("hr", { className: "thinking-api-divider" }),
        e("h3", { className: "thinking-api-title", style: { fontSize: 14 } }, t("configured")),
        e(ProviderList, { providers, store: controller, t, onRemoved: reload, onEdit: (route, p) => setEditTarget({ route, provider: p }) }),
      );
    }

    const inject = ["slots", "locale", "connection"];

    function apply(ctx) {
      const zh = {
        nav: "思考 API",
        title: "思考 API",
        intro: "一键接入带思考模式的第三方 API，规避 developer 角色被拒绝的问题。",
        loading: "正在加载…",
        loadFailed: "加载配置失败",
        retry: "重试",
        readOnly: "当前部署的设置文档为只读。",
        wizard: "接入向导",
        source: "来源",
        customOption: "自定义",
        routeId: "Route ID",
        displayNameLabel: "显示名",
        displayNamePlaceholder: "可选",
        baseURL: "API 地址",
        apiKey: "API 密钥",
        apiKeyPlaceholder: "粘贴 API Key",
        leaveBlank: "留空则不修改",
        thinkingFormat: "思考格式",
        models: "模型",
        modelsPlaceholder: "deepseek-v4, gpt-4o…（回车添加）",
        add: "添加",
        modelsHint: "勾选 = 开启思考模式；探测来的模型已自动按名称预判，可手动微调。",
        fetchModels: "获取模型列表",
        fetching: "获取中…",
        save: "保存",
        cancel: "取消",
        routeTaken: "该 Route ID 已存在。",
        edit: "编辑",
        remove: "删除",
        saved: "已保存。",
        configured: "已接入",
        empty: "还没有接入任何 API。",
      };
      const en = {
        nav: "Thinking API",
        title: "Thinking API",
        intro: "One-click setup for third-party APIs with thinking mode, avoiding developer-role rejection.",
        loading: "Loading…",
        loadFailed: "Failed to load settings",
        retry: "Retry",
        readOnly: "The settings document is read-only in this deployment.",
        wizard: "Setup wizard",
        source: "Source",
        customOption: "Custom",
        routeId: "Route ID",
        displayNameLabel: "Display name",
        displayNamePlaceholder: "Optional",
        baseURL: "Base URL",
        apiKey: "API Key",
        apiKeyPlaceholder: "Paste API key",
        leaveBlank: "leave blank to keep",
        thinkingFormat: "Thinking format",
        models: "Models",
        modelsPlaceholder: "deepseek-v4, gpt-4o… (Enter to add)",
        add: "Add",
        modelsHint: "Check = enable thinking. Discovered models are pre-flagged by name; adjust as needed.",
        fetchModels: "Fetch models",
        fetching: "Fetching…",
        save: "Save",
        cancel: "Cancel",
        routeTaken: "This route id already exists.",
        edit: "Edit",
        remove: "Remove",
        saved: "Saved.",
        configured: "Configured",
        empty: "No API configured yet.",
      };

      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "thinking-api: copy dictionaries");
      const connection = ctx.get("connection");
      const controller = new ThinkingApiStore(connection.api);
      const t = ctx.locale.bind(NS);

      const injected = () => ({ controller, api: connection.api, t });

      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "thinking-api",
        order: 20,
        label: () => t("nav"),
        inject: injected,
      }, Section));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
