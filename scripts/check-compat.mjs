// dsh-plugin-thinking-api · 升级后兼容性自检
//
// 用途：每次升级 DSH / pi-ai 后跑一遍，确认插件依赖的契约没被新版本破坏。
// 失败时会点名是哪个契约变了，以及对应的修复位置；成功则输出各依赖版本。
//
// 用法：
//   node scripts/check-compat.mjs [--workspace <路径>]
//
// 说明：
//   - 默认在「本插件的 package.json 所在目录」向上找 workspace node_modules
//     （即 DSH 运行时安装处）；也可用 --workspace 显式指定。
//   - 纯只读：不改插件目录、不写 settings、不发网络请求（仅建一个用完即删的临时目录）。
//   - 插件是 ESM，且依赖裸导入 workspace 里的 @deepseek-ai/*；脚本把插件 lib/
//     复制进临时目录并软链 workspace node_modules，从而用真实依赖解析并执行它。

import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolve(here, '..')

function findWorkspaceNodeModules(start) {
  let dir = start
  for (;;) {
    const candidate = join(dir, 'node_modules')
    if (existsSync(join(candidate, '@deepseek-ai', 'dsh-llm-pi-ai'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

const args = process.argv.slice(2)
const wsFlag = args.indexOf('--workspace')
const explicit = wsFlag !== -1 ? resolve(args[wsFlag + 1]) : null
// nodeModules = workspace 根/node_modules；显式传参时同样按「根目录」处理
const nodeModules =
  explicit !== null
    ? join(explicit, 'node_modules')
    : findWorkspaceNodeModules(pkgRoot)

if (nodeModules === null || !existsSync(nodeModules)) {
  console.error('[check-compat] 找不到 DSH workspace node_modules（含 @deepseek-ai/dsh-llm-pi-ai）。')
  console.error('[check-compat] 请用 --workspace 指定 workspace 根目录，例如：node scripts/check-compat.mjs --workspace ~/.workbuddy/binaries/node/workspace')
  process.exit(2)
}

const readVersion = (name) => {
  try {
    return JSON.parse(readFileSync(join(nodeModules, name, 'package.json'), 'utf8')).version
  } catch {
    return '?'
  }
}

let failed = 0
const fail = (msg) => { failed += 1; console.error(`[check-compat] ✗ ${msg}`) }
const ok = (msg) => console.log(`[check-compat] ✓ ${msg}`)

console.log('[check-compat] workspace node_modules:', nodeModules)
console.log('[check-compat] 依赖版本:')
console.log('  - @deepseek-ai/dsh-llm-pi-ai :', readVersion('@deepseek-ai/dsh-llm-pi-ai'))
console.log('  - @deepseek-ai/dsh-llm       :', readVersion('@deepseek-ai/dsh-llm'))
console.log('  - @earendil-works/pi-ai      :', readVersion('@earendil-works/pi-ai'))
console.log('  - @deepseek-ai/cordis        :', readVersion('@deepseek-ai/cordis'))
console.log('')

// ---- 准备：临时目录，把插件 lib 复制进去 + 软链 workspace node_modules，使裸导入可解析 ----
const tmp = mkdtempSync(join(tmpdir(), 'thinking-api-check-'))
let mod = null
try {
  cpSync(join(pkgRoot, 'lib'), join(tmp, 'lib'), { recursive: true })
  symlinkSync(nodeModules, join(tmp, 'node_modules'), 'dir')
  mod = await import(join(tmp, 'lib', 'index.mjs'))
} catch (error) {
  fail(`lib/index.mjs 无法在真实依赖下 import（某个依赖符号被移除/改名?）: ${error.message}`)
}

// ---- 契约 1：插件模块结构 ----
if (mod !== null) {
  if (typeof mod.apply === 'function' && typeof mod.inject === 'object') ok('lib/index.mjs 导出 apply/inject 正常')
  else fail('lib/index.mjs 导出结构异常（缺 apply 或 inject）')
}

// ---- 契约 2：PiAiAdapter 构造器仍接受 { profiles, resolveApiKey, resolveAttachments } ----
const { PiAiAdapter } = await import(join(nodeModules, '@deepseek-ai', 'dsh-llm-pi-ai', 'lib', 'index.js'))
try {
  const adapter = new PiAiAdapter({
    profiles: () => new Map(),
    resolveApiKey: async () => undefined,
    resolveAttachments: () => undefined,
  })
  if (typeof adapter.stream !== 'function') throw new Error('adapter.stream 缺失')
  ok('PiAiAdapter 构造器形状兼容（{ profiles, resolveApiKey, resolveAttachments } + stream）')
} catch (error) {
  fail(`PiAiAdapter 构造器形状不兼容: ${error.message}`)
}

// ---- 契约 3：provider auth 形状（0.82.1 起必须 auth.apiKey.resolve） ----
const { createProvider } = await import(join(nodeModules, '@earendil-works', 'pi-ai', 'dist', 'index.js'))
const { openAICompletionsApi } = await import(join(nodeModules, '@earendil-works', 'pi-ai', 'dist', 'api', 'openai-completions.lazy.js'))
const probe = createProvider({
  id: '__compat_probe__',
  name: 'compat probe',
  baseUrl: 'https://example.invalid',
  auth: {
    apiKey: {
      name: 'compat probe',
      resolve: ({ credential }) =>
        Promise.resolve({ auth: credential?.key === undefined ? {} : { apiKey: credential.key }, source: 'compat probe' }),
    },
  },
  models: [],
  api: openAICompletionsApi(),
})
if (probe?.auth?.apiKey?.resolve === undefined) {
  fail('pi-ai 的 provider auth 契约变化：provider.auth.apiKey.resolve 缺失 → 请求会报 "Provider is not configured"。')
  console.error('       修复：lib/index.mjs buildProvider 里把 auth 组装成 { apiKey: { name, resolve } }。')
} else {
  ok('pi-ai provider auth 契约兼容（auth.apiKey.resolve 存在）')
}
// Provider 接口的流式方法在 createProvider 的返回值上（provider.stream / streamSimple），
// 请求实际走的就是它们；createProvider 返回的对象不含 .api 字段（api 是输入参数）。
if (typeof probe?.stream !== 'function' || typeof probe?.streamSimple !== 'function') {
  fail('pi-ai Provider 接口不再提供 stream/streamSimple（createProvider 返回值缺流式方法）→ 请求无法发出。')
  console.error('       修复：lib/index.mjs 的 buildProvider 组装需随 pi-ai 新契约同步。')
} else {
  ok('pi-ai Provider 接口可流式调用（provider.stream / streamSimple 存在）')
}
// 顺带核对 openAICompletionsApi() 本身仍可调用（懒加载代理，插件以 api: 传入 createProvider）
const api = openAICompletionsApi()
if (typeof api?.stream !== 'function') {
  fail('openAICompletionsApi() 返回不再可流式调用（api.stream 缺失）。')
} else {
  ok('openAICompletionsApi() 可流式调用（api.stream 是函数）')
}

// ---- 契约 4：llm 服务注册 API（实例方法：ctx.llm.registerAdapter 等） ----
const llmMod = await import(join(nodeModules, '@deepseek-ai', 'dsh-llm', 'lib', 'index.js'))
const LlmRuntime = llmMod?.LlmRuntime ?? llmMod?.default
if (LlmRuntime === undefined) {
  fail('dsh-llm 不再导出 LlmRuntime（插件依赖 ctx.llm 服务）。')
} else {
  for (const method of ['registerAdapter', 'registerConfigurableProviders', 'registerModelDiscovery']) {
    if (typeof LlmRuntime.prototype?.[method] === 'function') ok(`dsh-llm LlmRuntime 仍提供 ${method}() 实例方法`)
    else fail(`dsh-llm LlmRuntime 不再提供 ${method}() 实例方法（插件 apply 依赖它）。`)
  }
}

// ---- 契约 5：dsh-settings / dsh-credentials 依赖的辅助函数 ----
const settingsMod = await import(join(nodeModules, '@deepseek-ai', 'dsh-settings', 'lib', 'index.js'))
for (const fn of ['installSettingsSection', 'settingsNamespace', 'deepEqualJson']) {
  if (typeof settingsMod?.[fn] === 'function') ok(`dsh-settings 仍导出 ${fn}()`)
  else fail(`dsh-settings 不再导出 ${fn}()`)
}
const credMod = await import(join(nodeModules, '@deepseek-ai', 'dsh-credentials', 'lib', 'index.js'))
if (typeof credMod?.credentialRef === 'function') ok('dsh-credentials 仍导出 credentialRef()')
else fail('dsh-credentials 不再导出 credentialRef()')

// ---- 清理 ----
try { rmSync(tmp, { recursive: true, force: true }) } catch { /* best effort */ }

console.log('')
if (failed > 0) {
  console.error(`[check-compat] 结果：${failed} 项不兼容 —— 插件需要随 DSH 升级同步更新。`)
  process.exit(1)
}
console.log('[check-compat] 结果：全部兼容，插件可继续使用。')
