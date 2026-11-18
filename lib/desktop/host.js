// dsh-next-prompt 的 Web / 桌面端宿主半：回合结束后猜一句，把结果放到
// /dsh-next-prompt 的 HTTP 路由上；浏览器半（lib/desktop/client.js）读这个路由
// 画输入框下方的胶囊与设置页。
//
// 为什么走 HTTP 路由而不是 Remote：第三方插件拿不到 Typert 生成产物；
// `ctx.webServer.register` 是同一页面同源可达的、插件能用的通道（一个 profile 里
// 已装的其他第三方插件也这么做）。生成逻辑（prepareCall / 超时 / abort / 清洗）
// 与手机壳保持一致，纯逻辑仍然来自 ../core.js。
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  SYSTEM,
  buildContext,
  cleanSuggestion,
  isIdle,
  pickBest,
  readTodos,
  isUserText,
  recentUserTexts,
  repeatsUser,
  splitCandidates,
} from '../core.js'
import { DEFAULTS, loadSettings, parseModel, saveSettings } from '../settings.js'
import { acceptance, clearStats, loadStats, record } from '../stats.js'

/** 路由前缀；浏览器半用同一个常量（两边各写一份，改的时候一起改）。 */
export const ROUTE_PREFIX = '/dsh-next-prompt'

/** 插件目录（源码/包目录）：最后兜底。 */
const PLUGIN_DIR = fileURLToPath(new URL('../..', import.meta.url))

/**
 * 运行时数据（settings.json / stats.json）写在这里：
 *   1. `$DSH_PROFILE_DIR/dsh-next-prompt`（工具 shell 里一定有）
 *   2. `$DSH_HOME/dsh-next-prompt`，默认 `~/.dsh/dsh-next-prompt`
 *   3. 插件目录（都拿不到时）
 *
 * 这个包通常是 `link:` 进 profile 的源码目录，写进插件目录会把工作区弄脏；
 * 宿主进程里往往没有 DSH_PROFILE_DIR，所以退回 DSH home（仍然不是源码目录）。
 * @returns 数据目录（已创建）
 */
function dataDirOf() {
  const env = process.env
  const candidate = [
    typeof env.DSH_PROFILE_DIR === 'string' && env.DSH_PROFILE_DIR !== '' ? join(env.DSH_PROFILE_DIR, 'dsh-next-prompt') : '',
    typeof env.DSH_HOME === 'string' && env.DSH_HOME !== '' ? join(env.DSH_HOME, 'dsh-next-prompt') : '',
    join(homedir(), '.dsh', 'dsh-next-prompt'),
  ].find((value) => value !== '')
  try {
    mkdirSync(candidate, { recursive: true })
    return candidate
  } catch {
    return PLUGIN_DIR
  }
}

/** 一次请求体上限：设置补丁很小，超了直接拒。 */
const MAX_BODY_BYTES = 64 * 1024

const warnOf = (ctx) => (error) => {
  try {
    ctx.logger?.warn?.(`dsh-next-prompt: ${String(error?.message ?? error)}`)
  } catch {}
}

/**
 * 生成与状态引擎：所有会话相关的内存状态都在这里，路由只是它的传输层。
 * @param scope 已注入 `sessions` / `llm` 的 Context。
 */
function createEngine(scope) {
  const warn = warnOf(scope)
  /** settings.json / stats.json 所在目录（profile 里，拿不到就退回插件目录）。 */
  const dir = dataDirOf()
  /** sessionId -> { text, at } */
  const suggestions = new Map()
  /** 浏览器正在看的会话；只给它们自动猜，避免给侧边栏里每个会话都花钱。 */
  const watched = new Set()
  /** sessionId -> timer */
  const timers = new Map()
  /** sessionId -> AbortController */
  const inflight = new Map()
  /** 刚插入过一句话的会话：胶囊这时显示「再猜一次」。 */
  const againHints = new Set()
  /** 最近一次调用，只给设置页的「调试」看；`skip` 说明上一次为什么没猜。 */
  const debug = { at: 0, model: '', ms: 0, error: '', context: '', skip: '' }
  /** 设置页「现在猜一次」猜哪个会话：最近被浏览器看过的那个。 */
  let lastWatched = ''

  /** 记下“这次为什么没往下走”，并返回空串（generate 的早退统一从这里出）。 */
  const skip = (reason) => {
    debug.skip = reason
    return ''
  }

  const sessionOf = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return undefined
    return scope.get('sessions')?.get?.(sessionId)
  }

  const messagesOf = (session) => (typeof session?.deriveMessages === 'function' ? session.deriveMessages() : [])

  // 只算用户自己打的字：dsh-time-context 之类注入的上下文消息不算。
  const hasUserMessage = (session) => messagesOf(session).some((message) => isUserText(message))

  /**
   * 会话的工作目录：优先问 workingDirectory 服务（模型的真实落点），
   * 退回 header.cwd；拿不到就让 core.js 用它的默认值，只是文件路径不会被缩短。
   */
  const workspaceRootOf = (session) => {
    const workdir = scope.get('workingDirectory')
    const effective = typeof workdir?.get === 'function' ? workdir.get(session) : undefined
    if (typeof effective === 'string' && effective !== '') return effective
    return typeof session?.header?.cwd === 'string' ? session.header.cwd : undefined
  }

  /** 子代理会话不猜：那是别的代理在跑，不是用户在打字。 */
  const guessable = (session) => session !== undefined && session.header?.origin !== 'subagent'

  const cancel = (sessionId) => {
    const timer = timers.get(sessionId)
    if (timer !== undefined) {
      clearTimeout(timer)
      timers.delete(sessionId)
    }
    inflight.get(sessionId)?.abort()
    inflight.delete(sessionId)
  }

  const clear = (sessionId) => {
    suggestions.delete(sessionId)
    againHints.delete(sessionId)
  }

  /**
   * 生成一句话并写进 suggestions；`force` 表示用户手点的（忽略 auto、允许重复）。
   * @returns 生成到的文本；没生成（没得猜/被拦下/出错）时返回空串。
   */
  const generate = async (sessionId, force = false) => {
    let controller
    try {
      const settings = loadSettings(dir)
      if (!force && !settings.auto) return skip('auto-off')
      const session = sessionOf(sessionId)
      if (session === undefined) return skip('no-session')
      if (!guessable(session)) return skip('subagent')
      if (!isIdle(session)) return skip('busy')
      const route = settings.model === 'session' ? session.requestContext?.() : parseModel(settings.model)
      const provider = route?.provider
      const model = route?.model
      if (typeof provider !== 'string' || typeof model !== 'string') return skip('no-route')
      const llm = scope.get('llm')
      if (typeof llm?.prepareCall !== 'function') return skip('no-llm')
      const messages = messagesOf(session)
      const context = buildContext(messages, readTodos(session), {
        candidates: settings.candidates,
        workspaceRoot: workspaceRootOf(session),
      })
      if (context === '') return skip('no-context')
      const previous = suggestions.get(sessionId)?.text
      if (force && previous !== undefined) record(dir, 'reguessed', previous)
      const recentUsers = recentUserTexts(messages, 2)

      cancel(sessionId)
      controller = new AbortController()
      inflight.set(sessionId, controller)
      const startedAt = Date.now()
      const timer = setTimeout(() => controller.abort(new Error('timeout')), settings.timeoutMs)
      timer.unref?.()
      try {
        // 旁路小请求：挑该模型支持的最低推理强度。
        const call = await llm.prepareCall({ provider, model, maxTokens: settings.maxTokens }, controller.signal, (controls, info) => {
          const effort = info?.reasoning?.efforts?.[0]?.id
          return typeof effort === 'string' ? { ...controls, reasoningEffort: effort } : controls
        })
        // DSH 的 RequestUserInput 形状：不带 id/source，内容只有一段文本。
        const prompt = { role: 'user', content: [{ type: 'text', text: context }] }
        let raw = ''
        for await (const chunk of call.stream({
          ...call.config,
          messages: [prompt],
          system: SYSTEM,
          sessionId,
          signal: controller.signal,
        })) {
          if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') raw += chunk.text
        }
        const list = splitCandidates(raw, settings.candidates, settings.maxChars)
        const text = settings.candidates > 1 ? pickBest(list) : (list[0] ?? cleanSuggestion(raw, settings.maxChars))
        if (text === '') return ''
        if (text === previous && !force) return ''
        // 手工重猜以用户意图为准；自动生成才拦“把用户刚说的话推回去”。
        if (!force && repeatsUser(text, recentUsers)) return ''
        suggestions.set(sessionId, { text, at: Date.now() })
        againHints.delete(sessionId)
        Object.assign(debug, { at: Date.now(), model: `${provider}/${model}`, ms: Date.now() - startedAt, error: '', context, skip: '' })
        record(dir, 'shown', text)
        return text
      } finally {
        clearTimeout(timer)
        if (inflight.get(sessionId) === controller) inflight.delete(sessionId)
      }
    } catch (error) {
      if (controller?.signal?.aborted === true) {
        // 超时/被下一条抢掉：调试页也要留痕，否则「上次结果」永远停在上一次成功。
        debug.skip = 'aborted'
        debug.error = String(error?.message ?? 'aborted').slice(0, 120)
        debug.ms = 0
      } else {
        debug.at = Date.now()
        debug.error = String(error?.message ?? error).slice(0, 120)
        debug.ms = 0
        debug.skip = ''
        warn(error)
      }
      return ''
    }
  }

  const schedule = (sessionId, delay = undefined, force = false) => {
    if (sessionId === '') return
    const settings = loadSettings(dir)
    // 关掉自动猜之后别再排队：否则胶囊会先闪一下「正在猜…」再回到空态。
    if (!force && !settings.auto) return
    const timer = timers.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    const wait = delay === undefined ? settings.debounceMs : delay
    const next = setTimeout(() => {
      timers.delete(sessionId)
      void generate(sessionId, force)
    }, wait)
    next.unref?.()
    timers.set(sessionId, next)
  }

  /** 胶囊/接口看到的状态。`pending` = 正在为它生成。 */
  const stateOf = (sessionId) => {
    const session = sessionOf(sessionId)
    const entry = suggestions.get(sessionId)
    const settings = loadSettings(dir)
    return {
      session: sessionId,
      known: session !== undefined,
      ready: entry !== undefined ? true : session !== undefined && hasUserMessage(session),
      text: entry?.text ?? null,
      at: entry?.at ?? 0,
      again: againHints.has(sessionId),
      pending: inflight.has(sessionId) || timers.has(sessionId),
      auto: settings.auto,
      // 浏览器半据此决定「正在猜…」最多等多久：防抖 + 超时 + 2s 收尾。
      limitMs: settings.debounceMs + settings.timeoutMs + 2000,
    }
  }

  const watch = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return stateOf('')
    watched.add(sessionId)
    lastWatched = sessionId
    // 打开一个已经安静的对话时补猜一次（和手机壳一样宽 400ms）。
    const session = sessionOf(sessionId)
    if (guessable(session) && isIdle(session) && suggestions.get(sessionId) === undefined) schedule(sessionId, 400)
    return stateOf(sessionId)
  }

  const unwatch = (sessionId) => {
    if (typeof sessionId !== 'string' || sessionId === '') return stateOf('')
    watched.delete(sessionId)
    cancel(sessionId)
    return stateOf(sessionId)
  }

  const accept = (sessionId) => {
    const entry = suggestions.get(sessionId)
    if (entry !== undefined) {
      record(dir, 'accepted', entry.text)
      suggestions.delete(sessionId)
    }
    againHints.add(sessionId)
    return stateOf(sessionId)
  }

  const dismiss = (sessionId) => {
    const entry = suggestions.get(sessionId)
    if (entry !== undefined) record(dir, 'ignored', entry.text)
    suggestions.delete(sessionId)
    againHints.delete(sessionId)
    return stateOf(sessionId)
  }

  const settingsSnapshot = () => {
    const stats = loadStats(dir)
    return {
      settings: loadSettings(dir),
      defaults: { ...DEFAULTS },
      stats,
      rate: acceptance(stats),
      debug: { ...debug },
      models: [],
      session: lastWatched,
    }
  }

  /** 设置页的模型目录：跟随会话 + 每个 provider/model（缓存 60s，别每次保存都重新枚举）。 */
  let modelCache = { at: 0, list: [] }
  const modelChoices = async (refresh = false) => {
    if (!refresh && modelCache.at !== 0 && Date.now() - modelCache.at < 60_000) return modelCache.list
    const llm = scope.get('llm')
    const choices = []
    try {
      for (const entry of llm?.listProviders?.() ?? []) {
        const provider =
          typeof entry?.provider === 'string' ? entry.provider
            : typeof entry?.id === 'string' ? entry.id
              : typeof entry?.name === 'string' ? entry.name : ''
        if (provider === '') continue
        for (const model of await llm.listModels(provider)) {
          if (typeof model?.id !== 'string' || model.id === '') continue
          choices.push({ provider, id: model.id, name: typeof model.name === 'string' ? model.name : model.id })
        }
      }
    } catch (error) {
      warn(error)
    }
    modelCache = { at: choices.length === 0 ? 0 : Date.now(), list: choices.slice(0, 24) }
    return modelCache.list
  }

  const savePatch = (patch) => {
    const next = saveSettings(dir, { ...loadSettings(dir), ...(patch ?? {}) })
    // 改完设置：已经挂着的建议可能不再符合长度/模型，直接收起来，下次再猜。
    for (const sessionId of watched) {
      cancel(sessionId)
      clear(sessionId)
    }
    return next
  }

  const reset = () => {
    saveSettings(dir, DEFAULTS)
    for (const sessionId of watched) {
      cancel(sessionId)
      clear(sessionId)
    }
    return loadSettings(dir)
  }

  const clearDebug = () => {
    Object.assign(debug, { at: 0, model: '', ms: 0, error: '', context: '', skip: '' })
    clearStats(dir)
  }

  /** 会话事件：回合开始收起旧建议，回合正常结束等一拍再猜（只对正在看的会话）。 */
  const onSessionEvent = (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || !watched.has(sessionId)) return
    if (event?.type === 'turn/start') {
      cancel(sessionId)
      const unused = suggestions.get(sessionId)
      if (unused !== undefined) record(dir, 'ignored', unused.text)
      clear(sessionId)
      return
    }
    if (event?.type !== 'turn/end') return
    if (event?.data?.reason?.kind !== 'completed') return
    schedule(sessionId)
  }

  const dispose = () => {
    for (const timer of timers.values()) clearTimeout(timer)
    timers.clear()
    for (const controller of inflight.values()) controller.abort()
    inflight.clear()
    suggestions.clear()
    againHints.clear()
    watched.clear()
  }

  return {
    stateOf, watch, unwatch, guess: generate, schedule, accept, dismiss,
    settingsSnapshot, modelChoices, savePatch, reset, clearDebug,
    onSessionEvent, dispose,
    get lastWatched() { return lastWatched },
    totalWatched: () => watched.size,
  }
}

/** 只允许同源页面发起的写操作：跨站页面拿不到 Origin 一致性的便宜。 */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (typeof origin !== 'string') return true
  const host = request.headers.host
  if (typeof host !== 'string') return false
  try {
    return new URL(origin).host.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function readJson(request) {
  return new Promise((done) => {
    let data = ''
    let bytes = 0
    request.on('data', (chunk) => {
      bytes += chunk.length ?? 0
      if (bytes > MAX_BODY_BYTES) {
        request.destroy()
        done({})
        return
      }
      data += String(chunk)
    })
    request.on('end', () => {
      if (data.trim() === '') {
        done({})
        return
      }
      try {
        const parsed = JSON.parse(data)
        done(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        done({})
      }
    })
    request.on('error', () => done({}))
  })
}

/**
 * 请求体 -> 设置补丁：只认 settings.js 认识的那几项，其余丢掉。
 * 合并与范围夹取交给 saveSettings/sanitize（单一来源）。
 */
function patchOf(body) {
  const patch = {}
  if (typeof body.auto === 'boolean') patch.auto = body.auto
  if (body.maxChars !== undefined && Number.isFinite(Number(body.maxChars))) patch.maxChars = Number(body.maxChars)
  if (body.candidates !== undefined && Number.isFinite(Number(body.candidates))) patch.candidates = Number(body.candidates)
  if (typeof body.model === 'string' && (body.model === 'session' || parseModel(body.model) !== undefined)) patch.model = body.model
  if (body.maxTokens !== undefined && Number.isFinite(Number(body.maxTokens))) patch.maxTokens = Number(body.maxTokens)
  if (body.timeoutMs !== undefined && Number.isFinite(Number(body.timeoutMs))) patch.timeoutMs = Number(body.timeoutMs)
  if (body.debounceMs !== undefined && Number.isFinite(Number(body.debounceMs))) patch.debounceMs = Number(body.debounceMs)
  return patch
}

/**
 * 注册 /dsh-next-prompt 下的所有路由。
 * 一条 prefix 路由 + 内部按 pathname 分发：只占一个 disposer，也没有路由表冲突。
 */
function registerRoutes(web, engine) {
  const handler = async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost')
    const path = url.pathname.slice(ROUTE_PREFIX.length).replace(/\/+$/u, '') || '/'
    const method = request.method ?? 'GET'
    const sessionId = url.searchParams.get('session') ?? ''

    try {
      if (path === '/' || path === '/state') {
        if (method !== 'GET') return sendJson(response, 405, { ok: false, error: 'method' })
        return sendJson(response, 200, { ok: true, ...engine.stateOf(sessionId) })
      }

      // 写操作一律先过同源检查。
      if (!sameOrigin(request)) return sendJson(response, 403, { ok: false, error: 'untrusted origin' })

      if (path === '/watch') {
        if (method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method' })
        return sendJson(response, 200, { ok: true, ...engine.watch(sessionId) })
      }

      if (path === '/unwatch') {
        if (method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method' })
        return sendJson(response, 200, { ok: true, ...engine.unwatch(sessionId) })
      }

      if (path === '/guess') {
        if (method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method' })
        if (sessionId === '') return sendJson(response, 400, { ok: false, error: 'session' })
        const text = await engine.guess(sessionId, true)
        return sendJson(response, 200, { ok: true, text, ...engine.stateOf(sessionId) })
      }

      if (path === '/accept' || path === '/dismiss') {
        if (method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method' })
        if (sessionId === '') return sendJson(response, 400, { ok: false, error: 'session' })
        const state = path === '/accept' ? engine.accept(sessionId) : engine.dismiss(sessionId)
        return sendJson(response, 200, { ok: true, ...state })
      }

      if (path === '/settings') {
        if (method === 'GET') {
          const snapshot = engine.settingsSnapshot()
          snapshot.models = await engine.modelChoices()
          return sendJson(response, 200, { ok: true, ...snapshot })
        }
        if (method === 'POST') {
          const body = await readJson(request)
          const settings = engine.savePatch(patchOf(body))
          const snapshot = engine.settingsSnapshot()
          snapshot.models = await engine.modelChoices()
          return sendJson(response, 200, { ok: true, settings, ...snapshot })
        }
        return sendJson(response, 405, { ok: false, error: 'method' })
      }

      if (path === '/reset') {
        if (method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method' })
        const settings = engine.reset()
        return sendJson(response, 200, { ok: true, ...engine.settingsSnapshot(), settings })
      }

      if (path === '/clear') {
        if (method !== 'POST') return sendJson(response, 405, { ok: false, error: 'method' })
        engine.clearDebug()
        return sendJson(response, 200, { ok: true, ...engine.settingsSnapshot() })
      }

      return sendJson(response, 404, { ok: false, error: 'not found' })
    } catch (error) {
      return sendJson(response, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }

  return web.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler })
}

/**
 * Web / 桌面端的宿主半入口。
 * @param ctx 包的根 Context（Dispatcher 已判断出没有 dshGo）。
 */
export function applyDesktop(ctx) {
  ctx.inject(['sessions', 'llm'], (scope) => {
    const engine = createEngine(scope)
    scope.effect(() => () => engine.dispose(), 'dsh-next-prompt: engine cleanup')
    scope.on('session/event', (session, event) => engine.onSessionEvent(session, event))
    // 没有 Web server 的组合（CLI / TUI）只保留生成能力，不暴露路由。
    scope.inject(['webServer'], (web) => {
      web.effect(() => registerRoutes(web, engine), 'dsh-next-prompt: routes')
    })
  })
}

/** 给离线测试用的出口。 */
export const __desktopTest = { createEngine, patchOf, sameOrigin }
