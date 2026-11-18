// dsh-next-prompt：手机端（dsh-go）的壳。回合结束后猜一句“用户接下来会说的话”，
// 显示为输入框上方的胶囊；点胶囊把这句话填进输入框（不发送）。
//
// 这一层只负责 dsh-go 的插槽与生命周期：`composer.strip` 三态胶囊 + 两个面板。
// 拼状态块、洗输出这些纯逻辑在 core.js；Web / 桌面端（lib/desktop/）复用同一份。
//
// 只用 Node 内置模块：插件目录在 $DSH_HOME/dsh-go/plugins 下，
// 解析不到 @deepseek-ai/* 的裸模块名。
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import {
  SYSTEM,
  buildContext,
  cleanSuggestion,
  isIdle,
  readTodos,
  pickBest,
  isUserText,
  recentUserTexts,
  repeatsUser,
  splitCandidates,
} from './core.js'
import { buildEntryView, buildView } from './panel.js'
import { DEFAULTS, loadSettings, parseModel, patchFromForm, saveSettings } from './settings.js'
import { clearStats, loadStats, record } from './stats.js'

/**
 * 胶囊兼做按钮，三态文案：
 *   没有建议 → 「猜下一句」（点一下现猜）
 *   有建议   → 那句话（点一下填进输入框）
 *   刚插入过 → 「再猜一次」（点一下换一句）
 * 按钮文字是清单里的静态字段、App 不支持运行时改，所以“提示什么”只能放在胶囊上。
 */
const PROMPT_FIRST = { text: '猜下一句', icon: 'sparkle' }
const PROMPT_AGAIN = { text: '再猜一次', icon: 'refresh' }
/** 插件目录：settings.json 就放在这一层。 */
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))

export function applyDshGo(ctx) {
  ctx.inject(['dshGo'], (ctx) => {
    /** sessionId -> { text, at }：当前给这个会话的一句话。 */
    const suggestions = new Map()
    /** sessionId -> Set<emit>：带着 sessionId 订阅的胶囊。 */
    const watchers = new Map()
    /** sessionId -> timer：等回合真正结束后再猜。 */
    const timers = new Map()
    /** sessionId -> AbortController：让上一次猜测不和新的抢。 */
    const inflight = new Map()
    /** 刚把一句话插进输入框的会话：胶囊这时显示「再猜一次」。 */
    const againHints = new Set()
    /** 设置面板展示的最近一次调用。只在内存里。 */
    const debug = { at: 0, model: '', ms: 0, error: '', context: '', formValue: '' }
    let warned = false

    const warn = (error) => {
      if (warned) return
      warned = true
      ctx.logger?.warn?.(`dsh-next-prompt: ${String(error?.message ?? error)}`)
    }

    /** 这个会话里有没有用户说过话（注入的上下文消息不算）。 */
    const hasUserMessage = (session) => {
      const messages = typeof session?.deriveMessages === 'function' ? session.deriveMessages() : []
      return messages.some((message) => isUserText(message))
    }

    /** 胶囊此刻该显示什么：三态。 */
    const stripPayload = (sessionId) => {
      const entry = suggestions.get(sessionId)
      if (entry !== undefined) return { text: entry.text, icon: 'sparkle' }
      return againHints.has(sessionId) ? PROMPT_AGAIN : PROMPT_FIRST
    }

    const emitAll = (sessionId) => {
      const payload = stripPayload(sessionId)
      for (const emit of watchers.get(sessionId) ?? []) {
        try {
          emit(payload)
        } catch (error) {
          warn(error)
        }
      }
    }

    const cancel = (sessionId) => {
      const timer = timers.get(sessionId)
      if (timer !== undefined) {
        clearTimeout(timer)
        timers.delete(sessionId)
      }
      inflight.get(sessionId)?.abort()
      inflight.delete(sessionId)
    }

    const generate = async (sessionId, force = false) => {
      let controller
      try {
        const settings = loadSettings(PLUGIN_DIR)
        // 关掉自动猜测后，只有点胶囊（force）才会调模型。
        if (!force && !settings.auto) return
        const session = ctx.get('sessions')?.get?.(sessionId)
        if (session === undefined || !isIdle(session)) return
        const route = settings.model === 'session' ? session.requestContext?.() : parseModel(settings.model)
        const provider = route?.provider
        const model = route?.model
        if (typeof provider !== 'string' || typeof model !== 'string') return
        const llm = ctx.get('llm')
        if (typeof llm?.prepareCall !== 'function') return
        const messages = typeof session.deriveMessages === 'function' ? session.deriveMessages() : []
        const context = buildContext(messages, readTodos(session), { candidates: settings.candidates })
        if (context === '') return
        const previous = suggestions.get(sessionId)?.text
        if (force && previous !== undefined) record(PLUGIN_DIR, 'reguessed', previous)
        // 用户最近说过的两句：别把人家刚说过的话当成“下一条”推回来。
        const recentUsers = recentUserTexts(messages, 2)

        cancel(sessionId)
        controller = new AbortController()
        inflight.set(sessionId, controller)
        const startedAt = Date.now()
        const timer = setTimeout(() => controller.abort(new Error('timeout')), settings.timeoutMs)
        timer.unref?.()
        try {
          // 猜下一句是“快而便宜”的旁路请求：挑该模型支持的最低推理强度。
          const call = await llm.prepareCall({ provider, model, maxTokens: settings.maxTokens }, controller.signal, (controls, info) => {
            const effort = info?.reasoning?.efforts?.[0]?.id
            return typeof effort === 'string' ? { ...controls, reasoningEffort: effort } : controls
          })
          const prompt = {
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: context }],
            // 线协议值：dsh-go App 可能按这个 kind 分组，改名会破坏手机端，保持原值。
      source: { kind: 'local-next-prompt' },
          }
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
          // 多条候选时一次要 N 行，挑最具体的一条；单条时就是清洗一遍。
          const list = splitCandidates(raw, settings.candidates, settings.maxChars)
          const text = settings.candidates > 1 ? pickBest(list) : (list[0] ?? cleanSuggestion(raw, settings.maxChars))
          if (text === '' || (text === previous && !force)) return
          // 手工点「重猜」时以用户意图为准，只有自动生成才拦“重复用户的话”。
          if (!force && repeatsUser(text, recentUsers)) return
          suggestions.set(sessionId, { text, at: Date.now() })
          againHints.delete(sessionId)
          Object.assign(debug, { at: Date.now(), model: `${provider}/${model}`, ms: Date.now() - startedAt, error: '', context })
          record(PLUGIN_DIR, 'shown', text)
          emitAll(sessionId)
        } finally {
          clearTimeout(timer)
          if (inflight.get(sessionId) === controller) inflight.delete(sessionId)
        }
      } catch (error) {
        if (controller?.signal?.aborted !== true) {
          debug.at = Date.now()
          debug.error = String(error?.message ?? error).slice(0, 120)
          debug.ms = 0
          warn(error)
        }
      }
    }

    const schedule = (sessionId, delay = undefined, force = false) => {
      if (sessionId === '') return
      const timer = timers.get(sessionId)
      if (timer !== undefined) clearTimeout(timer)
      const wait = delay === undefined ? loadSettings(PLUGIN_DIR).debounceMs : delay
      const next = setTimeout(() => {
        timers.delete(sessionId)
        void generate(sessionId, force)
      }, wait)
      next.unref?.()
      timers.set(sessionId, next)
    }

    // 胶囊：显示当前会话的一句话；三态见 stripPayload。
    ctx.dshGo.strip('next', (scope, emit) => {
      const scoped = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : ''
      if (scoped === '') {
        // 新开的空对话还没有会话 id：这里没有可猜的东西，
        // 也绝不能退回去用“最近一个会话”的建议（那会把上一个对话的内容串过来）。
        emit({ text: null })
        return () => {}
      }
      let set = watchers.get(scoped)
      if (set === undefined) watchers.set(scoped, (set = new Set()))
      set.add(emit)
      emit(stripPayload(scoped))
      // 打开一个已经安静的对话时补猜一次。
      schedule(scoped, 400)
      return () => {
        set.delete(emit)
        if (set.size === 0) watchers.delete(scoped)
      }
    })

    // 点胶囊：有建议就填进输入框（绝不自动发送），没有就现猜/重猜。
    ctx.dshGo.on('next', (scope, event) => {
      const zh = !String(event?.locale ?? '').startsWith('en')
      const sessionId = typeof scope?.sessionId === 'string' && scope.sessionId !== '' ? scope.sessionId : ''
      if (sessionId === '') return { toast: zh ? '这里还没有对话' : 'No conversation yet' }
      if (!hasUserMessage(ctx.get('sessions')?.get?.(sessionId))) {
        return { toast: zh ? '先发一条消息再猜' : 'Send a message first' }
      }
      const entry = suggestions.get(sessionId)
      if (entry === undefined) {
        // 手动点胶囊一律 force：关掉自动猜测后，手点仍然要能猜。
        const again = againHints.has(sessionId)
        schedule(sessionId, 0, true)
        return { toast: zh ? (again ? '正在重猜…' : '正在猜…') : again ? 'Re-guessing…' : 'Guessing…' }
      }
      suggestions.delete(sessionId)
      againHints.add(sessionId)
      emitAll(sessionId)
      record(PLUGIN_DIR, 'accepted', entry.text)
      return { insert: entry.text }
    })

    /** 设置面板当前该显示的值；表单的 bind 指到这里。 */
    let panelEmit
    const panelData = () => {
      const settings = loadSettings(PLUGIN_DIR)
      return { auto: settings.auto, maxChars: String(settings.maxChars), candidates: String(settings.candidates), model: settings.model }
    }
    /** 存完把新值推回面板：不推的话表单还停在旧数据上，看起来像“没保存”。 */
    const pushPanelData = () => {
      if (typeof panelEmit === 'function') panelEmit(panelData())
    }

    /** 设置面板能选哪些模型；列不出来就只留「跟随会话」。 */
    const listModelChoices = async () => {
      const llm = ctx.get('llm')
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
      return choices.slice(0, 8)
    }

    const save = (patch) => saveSettings(PLUGIN_DIR, { ...loadSettings(PLUGIN_DIR), ...patch })

    ctx.dshGo.panel('settings', {
      // 表单的 bind 指向这里：maxChars 用字符串，segmented 的取值才选得中。
      data: (scope, emit) => {
        panelEmit = emit
        emit(panelData())
        return () => {
          if (panelEmit === emit) panelEmit = undefined
        }
      },
      view: async (scope, caps) =>
        buildView({
          settings: loadSettings(PLUGIN_DIR),
          debug,
          stats: loadStats(PLUGIN_DIR),
          models: await listModelChoices(),
          locale: caps?.locale,
        }),
      actions: {
        // 表单提交：App 送回来的形状不完全确定，patchFromForm 全部认一遍。
        save: (scope, event) => {
          let raw = ''
          try {
            raw = JSON.stringify(event?.value ?? null).slice(0, 300)
          } catch {
            raw = '无法序列化'
          }
          debug.formValue = raw
          const patch = patchFromForm(event?.value)
          if (Object.keys(patch).length === 0) {
            return { refresh: true, toast: '没拿到表单值，请把「调试」页截图给我' }
          }
          save(patch)
          pushPanelData()
          return { refresh: true, toast: '已保存' }
        },
        reset: () => {
          saveSettings(PLUGIN_DIR, DEFAULTS)
          pushPanelData()
          return { refresh: true, toast: '已恢复默认' }
        },
        'clear-debug': () => {
          Object.assign(debug, { at: 0, model: '', ms: 0, error: '', context: '', formValue: '' })
          clearStats(PLUGIN_DIR)
          return { refresh: true }
        },
        'guess-now': (scope, event) => {
          const zh = !String(event?.locale ?? '').startsWith('en')
          const sessionId = typeof scope?.sessionId === 'string' ? scope.sessionId : ''
          if (sessionId === '') return { toast: zh ? '在某个对话里再点' : 'Open a conversation first' }
          if (!hasUserMessage(ctx.get('sessions')?.get?.(sessionId))) return { toast: zh ? '先发一条消息再猜' : 'Send a message first' }
          schedule(sessionId, 0, true)
          return { toast: zh ? '正在猜…' : 'Guessing…' }
        },
      },
    })

    // 输入框上方「插件」弹层里的入口：一行摘要 + 一个按钮，点开和别处同一个设置页。
    ctx.dshGo.panel('entry', {
      data: (scope, emit) => {
        emit({})
        return () => {}
      },
      view: (scope, caps) =>
        buildEntryView({
          settings: loadSettings(PLUGIN_DIR),
          locale: caps?.locale,
        }),
      actions: {
        'open-settings': () => ({ open: 'panel:settings' }),
      },
    })

    // 回合开始：旧建议立刻收起来；回合正常结束：等一拍再猜。
    ctx.on('session/event', (session, event) => {
      const sessionId = session?.id
      if (typeof sessionId !== 'string') return
      if (!watchers.has(sessionId)) return
      if (event?.type === 'turn/start') {
        cancel(sessionId)
        const unused = suggestions.get(sessionId)
        if (unused !== undefined) record(PLUGIN_DIR, 'ignored', unused.text)
        suggestions.delete(sessionId)
        againHints.delete(sessionId)
        emitAll(sessionId)
        return
      }
      if (event?.type !== 'turn/end') return
      if (event?.data?.reason?.kind !== 'completed') return
      schedule(sessionId)
    })

    ctx.effect(() => () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
      for (const controller of inflight.values()) controller.abort()
      inflight.clear()
      suggestions.clear()
      againHints.clear()
      watchers.clear()
    }, 'dsh-next-prompt: cleanup')
  })
}
