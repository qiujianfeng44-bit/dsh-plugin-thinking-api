// dsh-plugin-thinking-api · 一键配置带思考模式的 API（Host）
//
// 解决三件事：
//   1. 让任意 OpenAI 兼容 API（腾讯 CodeBuddy、自建 vLLM、各类中转站…）一键配置接入 DSH；
//   2. 自动带思考模式（reasoning），无需手写 reasoningEfforts/thinkingFormat；
//   3. 自动规避「developer 角色 → content_filter」问题：
//      pi-ai 对「声明了 reasoning 且未被识别为非标厂商」的模型会把 system prompt
//      改写成 developer 角色；腾讯等第三方端点会硬拒绝 developer 角色。
//      本插件在组装 Model 时直接注入 compat.supportsDeveloperRole: false，
//      强制走 system 角色 —— 这是 dsh-llm-pi-ai 原适配器会丢弃的字段。
//
// 实现思路（优雅且可维护）：
//   复用官方 @deepseek-ai/dsh-llm-pi-ai 导出的 PiAiAdapter 类 —— 它的 stream、
//   chunk 翻译、认证解析、空闲超时看门狗、图片处理全部成熟且随 DSH 升级自动演进；
//   本插件只重写「模型 / Provider 组装」这一小层，把正确的 compat 写进 pi-ai Model。
//
// 依赖（peerDependencies）：
//   @deepseek-ai/cordis, @deepseek-ai/schemastery,
//   @deepseek-ai/dsh-settings, @deepseek-ai/dsh-credentials,
//   @deepseek-ai/dsh-llm, @deepseek-ai/dsh-llm-pi-ai,
//   @earendil-works/pi-ai
//
// 修改后重启 Harness 生效。

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import { createProvider } from '@earendil-works/pi-ai'
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy'
import { LlmError, assertUsableApiKey, attributionHeaders, normalizeApiKey } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'

export const name = 'thinking-api'
export const inject = ['llm']

/** 本插件的 settings namespace（settings.yaml 里的顶层键）。 */
const NS = settingsNamespace('thinking-api')

// ---------------------------------------------------------------------------
// 启动时契约自检（防止「DSH/pi-ai 一升级插件就静默坏掉」）：
// 插件依赖 pi-ai 的两个内部契约——
//   1. provider auth 必须是 { apiKey: { name, resolve } }（0.82.1 起 resolveProviderAuth 只认这个形状）；
//   2. createProvider 返回的 Provider 必须可流式调用（provider.stream 是函数；自 rc.7 / pi-ai 0.82.1 起
//      Provider 不再暴露 .api 字段，openAICompletionsApi() 返回懒加载代理，流式由框架内部驱动）。
// 若未来 pi-ai 又改形状，这里会在 apply 时立刻抛清晰错误并点名是哪个依赖变了，
// 而不是等到用户发消息才看到 "Provider is not configured" 之类的迷惑报错。
// ---------------------------------------------------------------------------
function assertPiAiContract() {
  const probe = createProvider({
    id: '__thinking_api_contract_probe__',
    name: 'contract probe',
    baseUrl: 'https://example.invalid',
    auth: {
      apiKey: {
        name: 'contract probe',
        resolve: ({ credential }) =>
          Promise.resolve({ auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: 'contract probe' }),
      },
    },
    models: [],
    api: openAICompletionsApi(),
  })
  if (probe?.auth?.apiKey?.resolve === undefined) {
    throw new Error(
      'thinking-api: 检测到 pi-ai 的 provider auth 契约已变化（需要 provider.auth.apiKey.resolve），' +
        '插件需随新版本同步更新 buildProvider 的 auth 组装。请查看插件 release notes 或升级插件。',
    )
  }
  if (typeof probe.stream !== 'function') {
    throw new Error(
      'thinking-api: 检测到 createProvider 返回的 Provider 不可流式调用（provider.stream 缺失），' +
        'pi-ai 契约已变化，插件需随新版本同步更新。请升级插件或检查 pi-ai 版本兼容性。',
    )
  }
}

/** pi-ai 思考档位（ModelThinkingLevel），按升序。与 pi-ai `EXTENDED_THINKING_LEVELS` 完全一致。 */
const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

/** 支持的思考参数格式（pi-ai 的 thinkingFormat）。 */
const THINKING_FORMATS = [
  'deepseek',
  'openai',
  'openrouter',
  'together',
  'zai',
  'qwen',
  'string-thinking',
]

/** 模型默认上下文窗口 / 最大输出。 */
const DEFAULT_CONTEXT_WINDOW = 262144
const DEFAULT_MAX_TOKENS = 32768

// ---------------------------------------------------------------------------
// 思考档位默认值：按 thinkingFormat 方言分表。
// 依据 pi-ai openai-completions.js 的真实派发逻辑（openai-completions.js:560-640）：
//   - deepseek 方言：`max` 会映射成 `reasoning_effort: xhigh`（DeepSeek 专属）；
//   - openai / openrouter / together / zai / string-thinking：OpenAI 家族 effort
//     到 `high` 封顶，发 `xhigh` 会被端点拒绝；
//   - qwen 只看 `!!reasoningEffort`（enable_thinking），wire 值仅作占位，用 high 即可。
// 用户显式写 thinkingEfforts 时仍优先，本表只在「未写」时兜底。
// ---------------------------------------------------------------------------
const DEFAULT_EFFORTS_BY_FORMAT = {
  deepseek: { off: null, high: 'high', max: 'xhigh' },
  openai: { off: null, high: 'high', max: 'high' },
  openrouter: { off: null, high: 'high', max: 'high' },
  together: { off: null, high: 'high', max: 'high' },
  zai: { off: null, high: 'high', max: 'high' },
  qwen: { off: null, high: 'high', max: 'high' },
  'string-thinking': { off: null, high: 'high', max: 'high' },
}

/** 按 thinkingFormat 取默认档位表；未知方言回退 deepseek 表并告警。 */
function defaultEffortsFor(thinkingFormat) {
  const table = DEFAULT_EFFORTS_BY_FORMAT[thinkingFormat]
  if (table !== undefined) return table
  console.warn(`thinking-api: unknown thinkingFormat "${thinkingFormat}", falling back to deepseek efforts`)
  return DEFAULT_EFFORTS_BY_FORMAT.deepseek
}

// ---------------------------------------------------------------------------
// 配置 schema（精简版：只保留「一键接入带思考模式的 API」的核心字段）
// ---------------------------------------------------------------------------
const thinkingEffortsSchema = z.dict(z.union([z.string(), z.const(null)]), z.union(THINKING_LEVELS))

const modelSchema = z.object({
  name: z.string(),
  contextWindow: z.number().step(1).min(1),
  maxTokens: z.number().step(1).min(1),
  thinking: z.boolean().default(false),
  thinkingEfforts: thinkingEffortsSchema,
})

const providerSchema = z.object({
  displayName: z.string(),
  baseURL: z.string().required(),
  apiKeyEnv: z.string().role('credential-ref'),
  thinkingFormat: z.union(THINKING_FORMATS).default('deepseek'),
  models: z.dict(modelSchema).required(),
})

const Config = z.object({
  providers: z.dict(providerSchema).default({}),
})

// ---------------------------------------------------------------------------
// 组装：把用户配置转成 pi-ai Model / Provider
// ---------------------------------------------------------------------------

/**
 * 构造一个 pi-ai Model。
 * 关键点：compat 里强制 supportsDeveloperRole: false，
 * 让 pi-ai 对「思考模型」也走 system 角色而非 developer 角色。
 */
function buildModel(providerId, provider, modelId, entry) {
  const thinking = entry.thinking
  const efforts = entry.thinkingEfforts

  // 思考档位映射：复刻官方 dsh-llm-pi-ai resolveModelReasoning 的语义。
  // thinkingLevelMap 里「未声明」的档位记为 null（pi-ai 据此判定「不支持」），
  // 「显式 null」的档位（仅 off 合法）不写入 map（键缺省）——这样 off 仍是一个
  // 可选档位，且 deepseek 方言在关闭思考时仍会发 thinking:{type:"disabled"}。
  // 有 wire 值的档位记为 wire（并校验为非空字符串）。
  let thinkingLevelMap
  let reasoning = false
  if (thinking) {
    reasoning = true
    const source =
      efforts && Object.keys(efforts).length > 0
        ? efforts
        : defaultEffortsFor(provider.thinkingFormat ?? 'deepseek')
    thinkingLevelMap = {}
    for (const level of THINKING_LEVELS) {
      const wire = source[level]
      if (wire === undefined) thinkingLevelMap[level] = null
      else if (wire === null) {
        // 仅 off 允许为 null（官方语义）；非 off 档位给 null 是配置错误。
        if (level !== 'off') {
          throw new Error(
            `thinking-api: provider "${providerId}" model "${modelId}" thinkingEfforts.${level} ` +
              `must provide the wire value; only "off" may be null`,
          )
        }
        // off → 不写入（键缺省），与官方 resolveModelReasoning 一致。
      } else if (typeof wire !== 'string' || wire.length === 0) {
        throw new Error(
          `thinking-api: provider "${providerId}" model "${modelId}" thinkingEfforts.${level} ` +
            `must be a non-empty string or null; got ${JSON.stringify(wire)}`,
        )
      } else thinkingLevelMap[level] = wire
    }
  }

  return {
    id: modelId,
    name: entry.name ?? modelId,
    api: 'openai-completions',
    provider: providerId,
    baseUrl: provider.baseURL,
    reasoning,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: ['text'],
    cost: { input: 0, output: 0 },
    contextWindow: entry.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: entry.maxTokens ?? DEFAULT_MAX_TOKENS,
    compat: {
      thinkingFormat: provider.thinkingFormat ?? 'deepseek',
      supportsReasoningEffort: true,
      // ★ 核心修复：强制 system 角色，规避第三方 API 的 developer 角色拒绝
      supportsDeveloperRole: false,
    },
  }
}

/**
 * 构造一个 pi-ai Provider。
 * 完全复刻 dsh-llm-pi-ai 的 buildProvider 里「非 catalog 路由」分支，
 * 但 model 的 compat 由本插件正确注入。
 */
function buildProvider(providerId, provider) {
  const models = Object.entries(provider.models ?? {}).map(([modelId, entry]) =>
    buildModel(providerId, provider, modelId, entry),
  )
  return createProvider({
    id: providerId,
    name: provider.displayName ?? providerId,
    baseUrl: provider.baseURL,
    // ★ pi-ai 0.82.1 兼容：resolveProviderAuth 只认 provider.auth.apiKey
    //   （含 .resolve 方法），auth 顶层直接挂 resolve 会被当作「无认证方式」，
    //   getAuth 返回 undefined → "Provider is not configured: <route>"。
    //   与官方 dsh-llm-pi-ai 的 routeAuth/harnessApiKeyAuth 形态保持一致。
    auth: {
      apiKey: {
        name: provider.displayName ?? providerId,
        resolve: ({ credential }) =>
          Promise.resolve({
            auth: credential?.key === undefined ? {} : { apiKey: credential.key },
            source: provider.displayName ?? providerId,
          }),
      },
    },
    models,
    api: openAICompletionsApi(),
  })
}

/**
 * 把配置组装成 PiAiAdapter 需要的 profiles Map，并在组装前做完整校验。
 * profile 结构与 dsh-llm-pi-ai resolveProfiles 返回的一致（PiAiAdapter 依赖它）。
 * 任何非法 provider 都在这里抛出带 route 定位的错误——既在 apply 启动时跑一次，
 * 也作为 installSettingsSection 的 validate，让非法配置在写入点就被拒绝，
 * 而不是被存进 settings 后在模型选择/请求时才炸。
 */
function buildProfiles(providers) {
  const resolved = new Map()
  for (const [providerId, source] of Object.entries(providers ?? {})) {
    if (providerId.length === 0) throw new Error('thinking-api: provider names must be non-empty')
    if (source.baseURL === undefined || source.baseURL.length === 0) {
      throw new Error(`thinking-api: provider "${providerId}" has an empty baseURL`)
    }
    const models = Object.entries(source.models ?? {})
    if (models.length === 0) {
      throw new Error(`thinking-api: provider "${providerId}" resolves no models; declare at least one model`)
    }
    const seen = new Set()
    for (const [modelId] of models) {
      if (modelId.length === 0) throw new Error(`thinking-api: provider "${providerId}" has a model with an empty id`)
      if (seen.has(modelId)) throw new Error(`thinking-api: provider "${providerId}" lists model "${modelId}" more than once`)
      seen.add(modelId)
    }
    const displayName = source.displayName ?? providerId
    if (displayName.length === 0) throw new Error(`thinking-api: provider "${providerId}" has an empty displayName`)
    const apiKeyEnv = source.apiKeyEnv
    resolved.set(providerId, {
      provider: providerId,
      displayName,
      ...(apiKeyEnv === undefined ? {} : { apiKeyEnv: credentialRef(apiKeyEnv) }),
      streamIdleTimeoutMs: 3e5,
      configuredMaxTokens: new Map(),
      // ★ piProvider 由本插件组装（compat 正确）
      piProvider: buildProvider(providerId, source),
    })
  }
  return resolved
}

// ---------------------------------------------------------------------------
// 内置模板（「一键配置」用）：每个模板只提供默认值（baseURL / 思考方言 / 默认模型），
// 不绑定 key。用户选模板 → 填 API Key → 启用，即可写入 thinking-api.providers.<route>。
// host 与 client 共享，保证两端的默认行为一致。
// ---------------------------------------------------------------------------

/**
 * @typedef {object} ThinkingApiTemplate
 * @property {string} route - provider route id（settings 里的键）
 * @property {string} displayName - 显示名
 * @property {string} baseURL - API 地址
 * @property {string} thinkingFormat - pi-ai 思考方言
 * @property {Record<string, {name: string, thinking?: boolean}>} models - 默认模型（「填 key 即用」的兜底）
 */

// 注意：此表必须与 lib/client.js 里的 TEMPLATES 保持一致（跨端无法直接 import）。
/** @type {ThinkingApiTemplate[]} */
export const templates = [
  { route: 'codebuddy', displayName: 'CodeBuddy', baseURL: 'https://copilot.tencent.com/v2', thinkingFormat: 'deepseek', models: { 'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', thinking: true }, 'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', thinking: false } } },
  { route: 'deepseek', displayName: 'DeepSeek', baseURL: 'https://api.deepseek.com', thinkingFormat: 'deepseek', models: { 'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', thinking: true }, 'deepseek-v4-flash': { name: 'DeepSeek V4 Flash', thinking: false } } },
  { route: 'openrouter', displayName: 'OpenRouter', baseURL: 'https://openrouter.ai/api/v1', thinkingFormat: 'openrouter', models: { 'deepseek/deepseek-chat-v3-0324': { name: 'DeepSeek Chat V3', thinking: false } } },
  { route: 'siliconflow', displayName: 'SiliconFlow', baseURL: 'https://api.siliconflow.cn/v1', thinkingFormat: 'deepseek', models: { 'deepseek-ai/DeepSeek-V3': { name: 'DeepSeek V3', thinking: false }, 'deepseek-ai/DeepSeek-R1': { name: 'DeepSeek R1', thinking: true } } },
  { route: 'moonshot', displayName: 'Moonshot', baseURL: 'https://api.moonshot.cn/v1', thinkingFormat: 'openai', models: { 'kimi-k2-thinking': { name: 'Kimi K2 Thinking', thinking: true }, 'kimi-k2-turbo-preview': { name: 'Kimi K2 Turbo', thinking: false } } },
  { route: 'zhipu', displayName: '智谱 GLM', baseURL: 'https://open.bigmodel.cn/api/paas/v4', thinkingFormat: 'openai', models: { 'glm-4.5': { name: 'GLM-4.5', thinking: false }, 'glm-4.5-air': { name: 'GLM-4.5 Air', thinking: false } } },
  { route: 'qwen', displayName: '通义千问', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', thinkingFormat: 'qwen', models: { 'qwen-max': { name: 'Qwen Max', thinking: false }, 'qwen3-max': { name: 'Qwen3 Max', thinking: true } } },
  { route: 'volcengine', displayName: '火山引擎', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', thinkingFormat: 'deepseek', models: { 'deepseek-v4-pro': { name: 'DeepSeek V4 Pro', thinking: true } } },
  { route: 'baichuan', displayName: '百川', baseURL: 'https://api.baichuan-ai.com/v1', thinkingFormat: 'openai', models: { 'Baichuan4': { name: 'Baichuan4', thinking: false } } },
  { route: 'minimax', displayName: 'MiniMax', baseURL: 'https://api.minimax.chat/v1', thinkingFormat: 'openai', models: { 'MiniMax-M1': { name: 'MiniMax M1', thinking: true } } },
  { route: 'stepfun', displayName: '阶跃星辰', baseURL: 'https://api.stepfun.com/v1', thinkingFormat: 'openai', models: { 'step-2-16k': { name: 'Step 2 16K', thinking: false } } },
  { route: 'hunyuan', displayName: '腾讯混元', baseURL: 'https://api.hunyuan.cloud.tencent.com/v1', thinkingFormat: 'openai', models: { 'hunyuan-turbo': { name: 'Hunyuan Turbo', thinking: false }, 'hunyuan-t1-latest': { name: 'Hunyuan T1', thinking: true } } },
]

// ---------------------------------------------------------------------------
// 一键配置辅助：provider 目录（让插件出现在「设置 → 模型」页）+ 模型自动探测
// ---------------------------------------------------------------------------

const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** 配置页里的 provider 目录条目：每个已配置的 provider 一行，可 GUI 编辑/删除。 */
function directoryEntries(profiles) {
  return [...profiles.entries()].map(([provider, profile]) => ({
    provider,
    displayName: profile.displayName,
    settingsNs: NS,
    settingsPath: ['providers', provider],
    declared: true,
  }))
}

/** 提取候选里第一个非空字符串。 */
function label(...candidates) {
  for (const candidate of candidates) if (typeof candidate === 'string' && candidate.length > 0) return candidate
}

/** 提取候选里第一个正整数。 */
function capacity(...candidates) {
  for (const candidate of candidates) if (typeof candidate === 'number' && Number.isInteger(candidate) && candidate > 0) return candidate
}

/** 组装 /models 列表端点。 */
function listingUrl(baseURL) {
  return `${baseURL.replace(/\/+$/, '')}/models`
}

/** 读取回复体，拒绝超过 4MB 的。 */
async function readBounded(response, url) {
  const oversized = () => new LlmError(`${url} answered with more than ${MAX_RESPONSE_BYTES} bytes`, 'DISCOVERY_FAILED')
  const declared = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel()
    throw oversized()
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) throw oversized()
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  const body = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    body.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(body)
}

/** 解析 OpenAI 兼容的 /models 回复。 */
function readListing(body) {
  const data = body?.data
  if (!Array.isArray(data)) throw new LlmError('the endpoint\'s model listing has no "data" array; enter this provider\'s models by hand', 'DISCOVERY_FAILED')
  const models = []
  for (const raw of data) {
    const entry = raw
    const id = label(entry?.id)
    if (id === undefined) continue
    const name = label(entry?.name, entry?.display_name)
    const contextWindow = capacity(entry?.context_window, entry?.context_length)
    const maxTokens = capacity(entry?.max_output_tokens, entry?.max_tokens)
    models.push({
      id,
      ...(name === undefined ? {} : { name }),
      ...(contextWindow === undefined ? {} : { contextWindow }),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    })
  }
  return models
}

/** 校验探测用 key。 */
function usableProbeKey(raw) {
  const checked = normalizeApiKey(raw)
  if (checked.ok) return checked.value
  throw new LlmError(
    checked.reason === 'empty'
      ? "this provider's API key is blank; enter it on the Models page, or clear it to probe unauthenticated"
      : "this provider's API key contains characters no HTTP header can carry; paste the raw key only",
    'INVALID_CREDENTIAL',
  )
}

/** 探测一个端点返回的模型列表。 */
async function discoverModels(request, storedApiKey) {
  if (request.baseURL === undefined || request.baseURL.length === 0) {
    throw new LlmError(
      `thinking-api: provider "${request.provider ?? ''}" has no baseURL; set one, or enter this provider's models by hand`,
      'DISCOVERY_FAILED',
    )
  }
  const api = request.api ?? 'openai-completions'
  if (api !== 'openai-completions') {
    throw new LlmError(`thinking-api: protocol "${api}" has no model listing this build can read; enter this provider's models by hand`, 'DISCOVERY_UNSUPPORTED')
  }
  const url = listingUrl(request.baseURL)
  const supplied = request.apiKey ?? (await storedApiKey?.())
  const apiKey = supplied === undefined ? undefined : usableProbeKey(supplied)
  let response
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        ...(apiKey === undefined ? {} : { authorization: `Bearer ${apiKey}` }),
        ...attributionHeaders(),
      },
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
  } catch (error) {
    if (request.signal?.aborted) throw new LlmError('model discovery aborted by caller', 'ABORTED', { cause: error })
    throw new LlmError(`could not reach ${url}`, 'DISCOVERY_FAILED', { cause: error })
  }
  if (!response.ok) {
    throw new LlmError(`${url} answered ${response.status}${response.status === 401 || response.status === 403 ? '; check the API key' : ''}`, 'DISCOVERY_FAILED')
  }
  const text = await readBounded(response, url)
  let body
  try {
    body = JSON.parse(text)
  } catch {
    throw new LlmError(`${url} did not answer with JSON`, 'DISCOVERY_FAILED')
  }
  return readListing(body)
}

/**
 * 判断配置解析出的「注册事实」是否变化，用于跳过无谓的 replace。
 * @param {Map} profiles
 */
function registrationFacts(profiles) {
  return [...profiles.entries()]
    .map(([provider, profile]) => ({ provider, displayName: profile.displayName }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {*} config  - 组合层初始配置（settings.yaml 之外，由 cordis config 注入）
 */
export function apply(ctx, config) {
  // 启动即校验 pi-ai 契约：依赖形状变了立刻清晰报错，而不是等到用户发消息才炸。
  assertPiAiContract()

  // 当前生效配置的来源：installSettingsSection 的 setSource 会换成 settings 服务的解析值。
  let current = () => config ?? { providers: {} }
  let registration
  let registeredFacts

  // PiAiAdapter 的 profiles 惰性读取：每次请求都走这个闭包，读到最新 current()。
  // buildProfiles 会在组装前做完整校验，非法配置直接抛出（写入点即拒）。
  const profiles = () => buildProfiles(current().providers ?? {})

  const resolveApiKey = async (providerId, profile) => {
    const ref = profile.apiKeyEnv
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit =
      credentials !== undefined
        ? (await credentials.resolve(ref))?.value
        : launchEnvironmentOf(ctx).get(ref)?.value
    if (hit !== undefined && hit.length > 0) {
      return assertUsableApiKey(hit, 'thinking-api', profile.apiKeyEnv)
    }
    throw new LlmError(
      `thinking-api: provider "${providerId}" 引用的密钥 ${profile.apiKeyEnv} 未配置；` +
        `请通过 credentials 服务存储（Web 模型页写入）或导出该环境变量。`,
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new PiAiAdapter({
    profiles,
    resolveApiKey,
    resolveAttachments: () => ctx.get('attachments'),
  })

  // provider 目录：让插件出现在「设置 → 模型」页，用户可 GUI 里添加/编辑/删除 API。
  let directory
  let directoryFacts
  const ensureDirectory = () => {
    const entries = directoryEntries(profiles())
    if (deepEqualJson(entries, directoryFacts)) return
    // 配置尚未加载（providers 为空）时先跳过注册；
    // 等 settings 注入 provider 后 onChange 会再次调用本函数，届时再真正注册。
    if (entries.length === 0) return
    if (directory === undefined) directory = ctx.llm.registerConfigurableProviders(entries)
    else directory.replace(entries)
    directoryFacts = entries
  }

  // 模型自动探测：让「获取模型列表」按钮能拉取端点 /models。
  const storedApiKey = async (provider) => {
    if (provider === undefined) return undefined
    const profile = profiles().get(provider)
    if (profile === undefined) return undefined
    return resolveApiKey(provider, profile)
  }
  ctx.llm.registerModelDiscovery(NS, (request) => discoverModels(request, () => storedApiKey(request.provider)))

  const ensureRegistrationFacts = () => {
    const facts = registrationFacts(profiles())
    if (deepEqualJson(facts, registeredFacts)) return
    const routes = [...profiles().keys()]
    if (registration === undefined) {
      if (routes.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routes, adapter)
    } else {
      registration.replace(routes)
    }
    registeredFacts = facts
  }

  ensureRegistrationFacts()
  ensureDirectory()
  installSettingsSection(ctx, NS, Config, config, {
    // 写入点校验：settings.mutate 落地前先完整组装一遍，非法配置在此被拒绝。
    validate: (candidate) => buildProfiles(candidate?.providers ?? {}),
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      try {
        ensureRegistrationFacts()
      } catch (error) {
        ctx.logger.error('thinking-api: keeping the previously registered routes after a refused update')
        ctx.logger.error(error)
      }
      try {
        ensureDirectory()
      } catch (error) {
        ctx.logger.error('thinking-api: keeping the previous configurable-provider directory after a refused update')
        ctx.logger.error(error)
      }
    },
  })
}
