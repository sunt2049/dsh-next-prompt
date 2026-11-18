// dsh-next-prompt 的浏览器半：输入框下方的「猜下一句」胶囊 + 一个设置页。
//
// 数据全部来自宿主半（lib/desktop/host.js）注册的 /dsh-next-prompt 路由：
// 宿主在回合结束后猜好一句放在内存里，这里只读、只显示、只在点击时把话填进输入框。
// 胶囊三态与手机端一致（没有建议 / 有建议 / 刚插入过），文案见 locales。
//
// 约束（照 DSH 客户端插件约定）：
//   · 只 require 模块表里有的包（react），不依赖 dsh-client-ui-primitives；
//   · 样式走 --dsw-alias-* 主题变量，并用 ctx.effect 安装/卸载；
//   · 只通过 ctx.slots 注册，不写别人的 DOM。
window.__ModuleLoader__.load({
  id: '@sunt2049/dsh-next-prompt',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React

    /** 字典命名空间。 */
    const NS = 'nextPrompt'
    /** 与 package.json 的 name 一致：详情页凭它判断 subject 是不是自己。 */
    const MY_NAME = '@sunt2049/dsh-next-prompt'
    /** 与 host.js 的 ROUTE_PREFIX 保持一致。 */
    const ROUTE = '/dsh-next-prompt'
    const STYLE_ID = 'dsh-next-prompt'

    // ── 文案 ────────────────────────────────────────────────────────────────
    const zh = {
      'dock.empty': '猜下一句',
      'dock.emptyHint': '回合结束后猜一句你可能说的话，点一下填进输入框',
      'dock.guessing': '正在猜…',
      'dock.again': '再猜一次',
      'dock.againHint': '换一句',
      'dock.insert': '填进输入框',
      'dock.dismiss': '不用这句',
      'dock.none': '这次没猜出来',
      'dock.failed': '没插进去，把光标放回输入框再试',
      'settings.title': '猜下一句',
      'settings.description': '回合结束后，让一个小模型读本回合的状态（待办、报错、改过的文件、最后两句话），猜你接下来最可能输入的那句话。建议只放在输入框下方，点一下才填进去，永远不自动发送。',
      'settings.auto': '回合结束后自动猜',
      'settings.autoHint': '关掉之后仍然可以手动点胶囊现猜',
      'settings.length': '一句话多长',
      'settings.lengthHint': '超过这个长度会截断；胶囊一行放得下',
      'settings.candidates': '候选条数',
      'settings.candidatesHint': '一次要几条再挑最具体的一条；多则更慢',
      'settings.model': '用哪个模型',
      'settings.modelHint': '跟随会话会用当前会话的模型，走最低推理强度',
      'settings.limits': '超时 {timeout} · 防抖 {debounce}ms · 输出上限 {tokens} tokens',
      'settings.guessNow': '现在猜一次',
      'settings.reset': '恢复默认',
      'settings.saved': '已保存',
      'settings.resetDone': '已恢复默认',
      'settings.guessing': '正在猜…',
      'settings.guessDone': '猜好了',
      'settings.guessNone': '这次没猜出来',
      'settings.guessFailed': '猜失败了：宿主半可能没在跑',
      'settings.noSession': '先打开一个对话',
      'settings.followSession': '跟随会话',
      'settings.debug': '调试',
      'settings.debugHint': '最近一次调用与接受率，只在内存里（重启就没了）',
      'settings.lastGuess': '上次猜测',
      'settings.lastModel': '模型',
      'settings.lastTook': '耗时',
      'settings.lastResult': '结果',
      'settings.statsShown': '展示 / 采用',
      'settings.statsIgnored': '忽略 / 重猜',
      'settings.acceptance': '接受率',
      'settings.context': '上次发给模型的上下文',
      'settings.noCall': '（还没有调用过）',
      'settings.clear': '清空记录',
      'settings.cleared': '已清空',
      'settings.loading': '读取中…',
      'settings.failed': '读不到设置：宿主半可能没在跑',
      'settings.notYet': '还没有',
      'settings.generated': '已生成',
      'settings.skipped': '上次没猜的原因',
      'skip.busy': '回合还在跑',
      'skip.no-session': '这个会话不在当前进程里',
      'skip.no-context': '没有可预测的内容',
      'skip.no-route': '没拿到模型路由',
      'skip.no-llm': 'llm 服务不可用',
      'skip.auto-off': '自动猜已关',
      'skip.subagent': '子代理会话不猜',
    }
    const en = {
      'dock.empty': 'Guess next',
      'dock.emptyHint': 'Guesses what you may type next, after a turn ends; click to fill it in',
      'dock.guessing': 'Guessing…',
      'dock.again': 'Guess again',
      'dock.againHint': 'Try another',
      'dock.insert': 'Fill in the composer',
      'dock.dismiss': 'Not this one',
      'dock.none': 'No guess this time',
      'dock.failed': 'Could not insert it; focus the composer and retry',
      'settings.title': 'Next prompt',
      'settings.description': 'After each turn a small model reads this turn\u2019s state (todos, errors, edited files, the last two messages) and guesses the sentence you are most likely to type next. The guess waits under the composer; one click fills it in and it is never sent automatically.',
      'settings.auto': 'Guess after each turn',
      'settings.autoHint': 'You can still click the chip to guess on demand',
      'settings.length': 'Answer length',
      'settings.lengthHint': 'Longer guesses are truncated to fit one line',
      'settings.candidates': 'Candidates',
      'settings.candidatesHint': 'Ask for several and keep the most specific; slower',
      'settings.model': 'Model',
      'settings.modelHint': 'Follow session uses this session\u2019s model at its lowest reasoning effort',
      'settings.limits': 'Timeout {timeout} · debounce {debounce}ms · {tokens} tokens max',
      'settings.guessNow': 'Guess now',
      'settings.reset': 'Reset',
      'settings.saved': 'Saved',
      'settings.resetDone': 'Defaults restored',
      'settings.guessing': 'Guessing…',
      'settings.guessDone': 'Guessed',
      'settings.guessNone': 'No guess this time',
      'settings.guessFailed': 'Guessing failed: the Host half may not be running',
      'settings.noSession': 'Open a conversation first',
      'settings.followSession': 'Follow session',
      'settings.debug': 'Debug',
      'settings.debugHint': 'Last call and acceptance rate; memory only',
      'settings.lastGuess': 'Last guess',
      'settings.lastModel': 'Model',
      'settings.lastTook': 'Took',
      'settings.lastResult': 'Result',
      'settings.statsShown': 'Shown / used',
      'settings.statsIgnored': 'Ignored / re-guessed',
      'settings.acceptance': 'Acceptance',
      'settings.context': 'Context sent to the model',
      'settings.noCall': '(no call yet)',
      'settings.clear': 'Clear',
      'settings.cleared': 'Cleared',
      'settings.loading': 'Loading…',
      'settings.failed': 'Cannot read settings: the Host half may not be running',
      'settings.notYet': 'Not yet',
      'settings.generated': 'Generated',
      'settings.skipped': 'Why the last guess stopped',
      'skip.busy': 'the turn is still running',
      'skip.no-session': 'that Session is not live in this process',
      'skip.no-context': 'nothing worth predicting yet',
      'skip.no-route': 'no model route resolved',
      'skip.no-llm': 'the llm service is unavailable',
      'skip.auto-off': 'automatic guessing is off',
      'skip.subagent': 'subagent Sessions are skipped',
    }

    // ── 样式 ────────────────────────────────────────────────────────────────
    // 沿用宿主自己的语言：胶囊这一行与同排统计胶囊同高（22px），
    // 设置页沿用设置页的「一行一项」节奏（LanguageRow 的 Setting-Cell：标签左、控件右、发丝分隔）。
    // 强调色用 --dsw-alias-state-business-primary（真强调蓝）；brand-primary 是品牌中性色，不是蓝。
    const CSS = `
.lnp-dock{display:inline-flex;align-items:center;gap:2px;min-width:0;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px))}
.lnp-dock[data-mode='suggest']{padding-right:2px;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1);box-shadow:inset 0 0 0 0.5px var(--dsw-alias-border-l2)}
.lnp-pill{display:inline-flex;align-items:center;gap:5px;box-sizing:border-box;max-width:100%;height:calc(22px + var(--dsh-content-font-delta-secondary,0px));padding:0 8px;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;line-height:inherit;white-space:nowrap;cursor:pointer}
.lnp-pill svg{width:14px;height:14px;flex:none}
.lnp-pill:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px}
@media (hover:hover){.lnp-pill[data-mode='idle']:hover,.lnp-pill[data-mode='again']:hover{background:var(--dsw-alias-interactive-bg-hover,rgb(0 0 0 / 5%));color:var(--dsw-alias-label-primary)}}
.lnp-pill[data-mode='suggest']{color:var(--dsw-alias-label-primary);cursor:pointer}
.lnp-pill[data-mode='suggest'] .lnp-icon{color:var(--dsw-alias-state-business-primary,#4176e6)}
@media (hover:hover){.lnp-dock[data-mode='suggest']:hover{background:var(--dsw-alias-bg-layer-2)}}
.lnp-pill[data-mode='pending']{cursor:default}
.lnp-pill[aria-busy='true'] .lnp-icon{animation:lnp-pulse 1.1s ease-in-out infinite}
.lnp-label{min-width:0;overflow:hidden;text-overflow:ellipsis}
.lnp-dismiss{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;margin-right:1px;padding:0;border:0;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-tertiary);opacity:.7;cursor:pointer}
.lnp-dismiss svg{width:11px;height:11px}
.lnp-dismiss:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px;opacity:1}
@media (hover:hover){.lnp-dismiss:hover{opacity:1;background:var(--dsw-alias-interactive-bg-hover,rgb(0 0 0 / 6%));color:var(--dsw-alias-label-primary)}}
.lnp-note{margin-left:6px;color:var(--dsw-alias-label-tertiary)}
.lnp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
@keyframes lnp-pulse{0%,100%{opacity:.35}50%{opacity:1}}
@media (prefers-reduced-motion:reduce){.lnp-pill[aria-busy='true'] .lnp-icon{animation:none}}
.lnp-detail{display:flex;flex-direction:column;gap:12px}
.lnp-detailTitle{margin:0;font-size:14px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-primary)}
.lnp-desc{margin:6px 0 4px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.lnp-field{padding:14px 0}
.lnp-field+.lnp-field{border-top:0.5px solid var(--dsw-alias-border-l2)}
.lnp-row{display:flex;align-items:center;gap:12px}
.lnp-text{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0;padding-right:16px}
.lnp-fieldLabel{font-size:14px;font-weight:400;line-height:22px;color:var(--dsw-alias-label-primary)}
.lnp-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary)}
.lnp-switch{position:relative;flex:none;width:38px;height:22px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-interactive-bg-hover,rgb(0 0 0 / 10%));cursor:pointer;transition:background .16s ease}
.lnp-switch[aria-checked='true']{background:var(--dsw-alias-state-business-primary,#4176e6)}
.lnp-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:2px}
.lnp-thumb{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:var(--dsw-alias-bg-layer-1,#fff);box-shadow:0 1px 2px rgb(0 0 0 / 24%);transition:transform .16s ease}
.lnp-switch[aria-checked='true'] .lnp-thumb{transform:translateX(16px)}
.lnp-seg{display:inline-flex;flex:none;gap:2px;padding:2px;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform,#f2f3f5)}
.lnp-segBtn{min-width:32px;padding:0 9px;border:0;border-radius:calc(var(--dsw-radius-md,8px) - 2px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;line-height:24px;cursor:pointer}
.lnp-segBtn[aria-pressed='true']{background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary);box-shadow:0 1px 2px rgb(0 0 0 / 10%)}
.lnp-segBtn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px}
.lnp-select{flex:none;min-width:190px;max-width:62%;height:34px;padding:0 30px 0 12px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background-color:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;cursor:pointer;appearance:none;background-image:linear-gradient(45deg,transparent 50%,currentColor 50%),linear-gradient(135deg,currentColor 50%,transparent 50%);background-position:calc(100% - 16px) 14px,calc(100% - 11px) 14px;background-size:5px 5px,5px 5px;background-repeat:no-repeat}
.lnp-select:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary,#4176e6)}
.lnp-actions{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:12px 0 4px}
.lnp-btn{display:inline-flex;align-items:center;gap:6px;height:34px;padding:0 13px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;cursor:pointer}
.lnp-btn:disabled{color:var(--dsw-alias-label-tertiary);cursor:default}
.lnp-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:1px}
@media (hover:hover){.lnp-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}}
.lnp-btn svg{width:14px;height:14px}
.lnp-status{margin-left:8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.lnp-status[data-error='true']{color:var(--dsw-alias-state-error-primary)}
.lnp-debug{margin-top:16px;border-top:0.5px solid var(--dsw-alias-border-l2);padding-top:12px}
.lnp-summary{display:flex;align-items:center;gap:8px;padding:0;border:0;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;cursor:pointer}
.lnp-summary svg{width:12px;height:12px;color:var(--dsw-alias-label-tertiary);transition:transform .16s ease}
.lnp-summary[aria-expanded='true'] svg{transform:rotate(90deg)}
.lnp-summary:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4176e6));outline-offset:3px}
.lnp-dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 16px;margin:12px 0 0;font-size:12px;line-height:1.5}
.lnp-dl dt{color:var(--dsw-alias-label-tertiary)}
.lnp-dl dd{margin:0;color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}
.lnp-contextLabel{margin:14px 0 6px;font-size:12px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.lnp-code{max-height:220px;margin:0;padding:10px 12px;overflow:auto;border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-module-platform,#f2f3f5);color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,"Liberation Mono",monospace);font-size:var(--dsh-code-font-size,11.5px);line-height:1.55;white-space:pre-wrap;word-break:break-word}
`

    /** 装载样式表；已存在就换内容（热更新后 CSS 改动才生效），卸载时移除。 */
    function installStyles() {
      if (typeof document === 'undefined') return () => {}
      const existing = document.getElementById(STYLE_ID)
      if (existing !== null) {
        existing.textContent = CSS
        return () => { existing.remove() }
      }
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.dataset.plugin = 'dsh-next-prompt'
      style.textContent = CSS
      document.head.appendChild(style)
      return () => { style.remove() }
    }

    // ── 传输 ────────────────────────────────────────────────────────────────
    /**
     * 调一条宿主路由；失败一律抛，调用方决定“静默”还是显示。
     * @param path 路由后半段（带查询串）
     * @param options `{ method, body }`
     */
    async function api(path, options = {}) {
      const init = { method: options.method ?? 'GET', headers: { accept: 'application/json' } }
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json'
        init.body = JSON.stringify(options.body)
      }
      const response = await fetch(`${ROUTE}${path}`, init)
      const text = await response.text()
      let payload
      try {
        payload = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`bad response: ${text.slice(0, 80)}`)
      }
      if (response.ok === false || payload.ok === false) throw new Error(payload.error ?? `http ${response.status}`)
      return payload
    }

    const withSession = (path, sessionId) => `${path}${path.includes('?') ? '&' : '?'}session=${encodeURIComponent(sessionId)}`

    // ── 图标（自绘图，currentColor） ──────────────────────────────────────────
    function SparkleIcon() {
      return h('svg', { className: 'lnp-icon', viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', {
          fill: 'currentColor',
          d: 'M8 1.2l1.34 4.06a2 2 0 0 0 1.28 1.28L14.68 7.9l-4.06 1.34a2 2 0 0 0-1.28 1.28L8 14.6l-1.34-4.08a2 2 0 0 0-1.28-1.28L1.32 7.9l4.06-1.36a2 2 0 0 0 1.28-1.28L8 1.2z',
        }),
      )
    }

    function RefreshIcon() {
      return h('svg', { className: 'lnp-icon', viewBox: '0 0 16 16', 'aria-hidden': true },
        h('path', {
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          d: 'M13.2 7.2A5.3 5.3 0 1 0 12 11.4M13.2 3.1v4.1H9.1',
        }),
      )
    }

    function CloseIcon() {
      return h('svg', { viewBox: '0 0 12 12', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', d: 'M2.5 2.5l7 7M9.5 2.5l-7 7' }),
      )
    }

    function ChevronIcon() {
      return h('svg', { viewBox: '0 0 12 12', 'aria-hidden': true },
        h('path', { fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', d: 'M4.5 2.5L8 6l-3.5 3.5' }),
      )
    }

    // ── 语言 ────────────────────────────────────────────────────────────────
    /**
     * 跟着当前语言重渲染的 t。
     * 槽位给了 `t` 时优先用它（注册时带 locale），否则用绑定到本插件命名空间的。
     */
    function useT(locale, providedT) {
      const [, bump] = useState(0)
      useEffect(() => {
        if (typeof locale?.subscribe !== 'function') return undefined
        return locale.subscribe(() => bump((n) => n + 1))
      }, [locale])
      if (typeof providedT === 'function') return providedT
      try {
        if (typeof locale?.bind === 'function') return locale.bind(NS)
      } catch {}
      return (key) => key
    }

    // ── 胶囊 ────────────────────────────────────────────────────────────────
    const emptyState = { ready: false, text: null, pending: false, again: false, busy: false, note: '' }

    /** 兜底的“选择器 hook”：没有 store 时直接对 undefined 取值，hook 顺序不变。 */
    const useNothing = (selector) => selector(undefined)

    /**
     * 胶囊的状态机：订阅（watch）→ 回合结束轮询 → 点击现猜 / 插入 / 收起。
     * @param props 槽位给的 standard props（sessionId / useSessionStatus / useInput / inputActions）
     */
    function useChip(props) {
      const { sessionId } = props
      // 槽位一定给这两个 hook；真缺了也不能改变 hook 顺序，用一个普通函数兜底。
      const statusHook = typeof props.useSessionStatus === 'function' ? props.useSessionStatus : useNothing
      const inputHook = typeof props.useInput === 'function' ? props.useInput : useNothing
      const [state, setState] = useState(emptyState)
      /** watch 的“票据”：只在换会话/卸载时作废，和轮询各用各的。 */
      const ticket = useRef(0)
      /** 轮询的“票据”：新的轮询一起就作废旧的那条。 */
      const pollTicket = useRef(0)
      const draftRef = useRef('')
      const running = statusHook((map) => (map?.get?.(sessionId)?.running ?? undefined))
      draftRef.current = inputHook((s) => s?.draft ?? '') ?? ''

      const absorb = useCallback((data) => {
        if (data === undefined || data === null) return
        setState((prev) => ({
          ...prev,
          ready: data.ready ?? prev.ready,
          text: data.text ?? null,
          pending: data.pending ?? false,
          again: data.again ?? false,
          busy: false,
        }))
      }, [])

      /**
       * 读一次 /state 并吸收；失败返回 undefined（调用方决定重试还是放弃）。
       */
      const readState = useCallback(async () => {
        try {
          return await api(withSession('/state', sessionId))
        } catch {
          return undefined
        }
      }, [sessionId])

      // 进会话：登记 watch（宿主据此只为“正在看”的会话猜），拿到当前状态。
      useEffect(() => {
        const mine = ++ticket.current
        setState(emptyState)
        let alive = true
        api(withSession('/watch', sessionId), { method: 'POST' })
          .then((data) => { if (alive && ticket.current === mine) absorb(data) })
          .catch(() => {})
        return () => {
          alive = false
          ticket.current += 1
          void api(withSession('/unwatch', sessionId), { method: 'POST' }).catch(() => {})
        }
      }, [sessionId, absorb])

      // 回合结束 → 等宿主猜完：只要宿主说 pending 就继续问，最多等到
      // 防抖 + 超时 + 2s（宿主在 /state 里给 limitMs）；到点收尾，别把按钮永远卡在「正在猜…」。
      // running 为 undefined（还没拿到基线）时也走一轮：宿主回 pending:false 就立刻结束，只多一次请求，
      // 免得“状态一直未知 → 回合结束后胶囊不动”。
      useEffect(() => {
        if (running === true) {
          pollTicket.current += 1
          setState((prev) => ({ ...prev, text: null, pending: false, again: false }))
          return
        }
        const mine = ++pollTicket.current
        let alive = true
        const tick = async () => {
          const startedAt = Date.now()
          let failures = 0
          let limit = 20_000
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 700))
            if (!alive || pollTicket.current !== mine) return
            const data = await readState()
            if (!alive || pollTicket.current !== mine) return
            if (data === undefined) {
              failures += 1
              if (failures >= 3) return
              continue
            }
            failures = 0
            if (typeof data.limitMs === 'number' && data.limitMs > 0) limit = data.limitMs
            absorb(data)
            if (data.text || data.pending === false) return
            if (Date.now() - startedAt > limit) {
              // 到点还没有结果：把「正在猜…」放下，让它回到可点的「猜下一句」。
              setState((prev) => ({ ...prev, pending: false, busy: false }))
              return
            }
          }
        }
        void tick()
        return () => { alive = false }
      }, [running, sessionId, absorb, readState])

      // 心跳：只要手里有建议、或宿主还在猜，就低频对一次账（回合开始时收起建议、
      // 设置页改完后宿主清空建议、宿主重启——这些都只有 /state 知道）。
      useEffect(() => {
        if (state.text === null && state.pending === false) return undefined
        const timer = setInterval(() => {
          void readState().then((data) => { if (data !== undefined) absorb(data) })
        }, 3000)
        return () => clearInterval(timer)
      }, [state.text, state.pending, absorb, readState])

      // 「这次没猜出来」只是提示，过几秒自己消掉。
      useEffect(() => {
        if (state.note === '') return undefined
        const timer = setTimeout(() => setState((prev) => (prev.note === '' ? prev : { ...prev, note: '' })), 2600)
        return () => clearTimeout(timer)
      }, [state.note])

      /** 现猜一次：宿主生成完才回包，所以按钮直接进 busy。 */
      const guess = useCallback(async () => {
        const mine = pollTicket.current
        setState((prev) => ({ ...prev, busy: true, note: '' }))
        try {
          const data = await api(withSession('/guess', sessionId), { method: 'POST' })
          if (pollTicket.current !== mine) return
          absorb(data)
          if (typeof data.text !== 'string' || data.text === '') setState((prev) => ({ ...prev, note: 'none' }))
        } catch {
          // 宿主没回包（重启/网络）：说清楚，别让用户以为点了没反应。
          if (pollTicket.current === mine) setState((prev) => ({ ...prev, busy: false, note: 'failed' }))
        }
      }, [sessionId, absorb])

      /**
       * 把一句话放进输入框：空草稿整句替换，写过东西就插在光标处（不覆盖）。
       * 光标紧贴英文/数字时补一个空格，免得两段粘成一个词。
       */
      const insert = useCallback((text) => {
        const actions = props.inputActions
        if (actions === undefined || text === '') return false
        const draft = draftRef.current ?? ''
        try {
          if (draft.trim() === '') {
            actions.setDraft(text)
            return true
          }
          const span = actions.captureInsertion()
          const before = typeof span?.start === 'number' ? (draft[span.start - 1] ?? '') : ''
          const payload = /[A-Za-z0-9]/u.test(before) && /^[A-Za-z0-9]/u.test(text) ? ` ${text}` : text
          if (actions.insertText(payload, span) === false) {
            actions.setDraft(`${draft}${/\s$/u.test(draft) ? '' : ' '}${text}`)
          }
        } catch {
          return false
        }
        return true
      }, [props.inputActions])

      /** 点胶囊：有建议就填进去；没有 / 刚插入过就现猜。 */
      const primary = useCallback(async () => {
        if (state.text !== null && state.text !== '') {
          const ok = insert(state.text)
          if (ok) {
            setState((prev) => ({ ...prev, text: null, again: true, note: '' }))
            void api(withSession('/accept', sessionId), { method: 'POST' }).catch(() => {})
          } else {
            // 填不进去（编辑器忙 / 没有输入框）也要说一句，别静默。
            setState((prev) => ({ ...prev, note: 'failed' }))
          }
          return
        }
        await guess()
      }, [state.text, insert, guess, sessionId])

      const dismiss = useCallback(() => {
        setState((prev) => ({ ...prev, text: null, again: false, note: '' }))
        void api(withSession('/dismiss', sessionId), { method: 'POST' }).catch(() => {})
      }, [sessionId])

      return { state, primary, dismiss, running }
    }

    /** 输入框下方那一行：三态胶囊。 */
    function NextPromptDock(props) {
      const t = useT(props.locale, props.t)
      const { state, primary, dismiss } = useChip(props)
      if (!state.ready && state.text === null) return null

      const mode = state.text !== null && state.text !== ''
        ? 'suggest'
        : state.busy || state.pending
          ? 'pending'
          : state.again ? 'again' : 'idle'

      const label = mode === 'suggest'
        ? state.text
        : mode === 'pending'
          ? t('dock.guessing')
          : mode === 'again' ? t('dock.again') : t('dock.empty')
      const title = mode === 'suggest'
        ? `${t('dock.insert')}：${state.text}`
        : mode === 'pending'
          ? t('dock.emptyHint')
          : mode === 'again' ? t('dock.againHint') : t('dock.emptyHint')

      const icon = mode === 'again' ? h(RefreshIcon) : h(SparkleIcon)
      // 建议态：边框画在 dock 上，胶囊本身透明，这样右侧的 × 落在框内而不是框外。
      const note = state.note === 'none' ? t('dock.none') : state.note === 'failed' ? t('dock.failed') : ''
      return h('div', { className: 'lnp-dock', 'data-plugin': 'dsh-next-prompt', 'data-mode': mode },
        h('button', {
          type: 'button',
          className: 'lnp-pill',
          'data-mode': mode,
          'aria-busy': mode === 'pending' ? 'true' : undefined,
          'aria-label': mode === 'suggest' ? `${t('dock.insert')}：${state.text}` : label,
          title,
          disabled: mode === 'pending',
          onClick: () => { void primary() },
        },
        icon,
        h('span', { className: 'lnp-label' }, label)),
        mode === 'suggest'
          ? h('button', {
            type: 'button',
            className: 'lnp-dismiss',
            'aria-label': t('dock.dismiss'),
            title: t('dock.dismiss'),
            onClick: (event) => { event.stopPropagation(); dismiss() },
          }, h(CloseIcon))
          : null,
        note === '' ? null : h('span', { className: 'lnp-note' }, note),
        // 读屏用：三态切换、正在猜、没猜出来都要能被播报（焦点通常在输入框里）。
        h('span', { className: 'lnp-sr', role: 'status', 'aria-live': 'polite' },
          `${label}${note === '' ? '' : `，${note}`}`))
    }

    // ── 设置页 ──────────────────────────────────────────────────────────────
    const LENGTHS = [10, 14, 18, 24]
    const COUNTS = [1, 2, 3]

    /** 毫秒 -> 「1.5s」。 */
    const secs = (value) => `${Math.round(Number(value) / 100) / 10}s`

    /** 早退原因 -> 本地化文案；未知原因原样显示，方便对日志。 */
    function skipLabel(code, t) {
      const key = `skip.${String(code)}`
      const text = t(key)
      return text === key ? String(code) : text
    }

    function Switch({ checked, label, onChange }) {
      return h('button', {
        type: 'button',
        className: 'lnp-switch',
        role: 'switch',
        'aria-checked': checked === true ? 'true' : 'false',
        'aria-label': label,
        onClick: () => onChange(checked !== true),
      }, h('span', { className: 'lnp-thumb', 'aria-hidden': true }))
    }

    function Segmented({ value, options, label, onChange }) {
      return h('div', { className: 'lnp-seg', role: 'group', 'aria-label': label },
        options.map((option) => h('button', {
          key: String(option),
          type: 'button',
          className: 'lnp-segBtn',
          'aria-pressed': String(option) === String(value) ? 'true' : 'false',
          onClick: () => onChange(option),
        }, String(option))))
    }

    /** 一行设置：标签（+ 说明）在左，控件在右，和设置页的 Setting-Cell 一致。 */
    function Field({ label, hint, control }) {
      return h('div', { className: 'lnp-field' },
        h('div', { className: 'lnp-row' },
          h('div', { className: 'lnp-text' },
            h('span', { className: 'lnp-fieldLabel' }, label),
            hint === undefined ? null : h('p', { className: 'lnp-hint' }, hint)),
          control))
    }

    /** 设置页的数据：一次读全（设置 + 模型目录 + 埋点 + 调试），写回后用回包覆盖。 */
    function useSettingsData() {
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const load = useCallback(async () => {
        try {
          const payload = await api('/settings')
          setData(payload)
          setError('')
          return payload
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          return null
        }
      }, [])
      useEffect(() => { void load() }, [load])
      const save = useCallback(async (patch) => {
        try {
          const payload = await api('/settings', { method: 'POST', body: patch })
          setData((prev) => ({ ...(prev ?? {}), ...payload }))
          setError('')
          return payload
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          return null
        }
      }, [])
      const reset = useCallback(async () => {
        try {
          const payload = await api('/reset', { method: 'POST' })
          setData((prev) => ({ ...(prev ?? {}), ...payload }))
          setError('')
          return payload
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          return null
        }
      }, [])
      const clear = useCallback(async () => {
        try {
          const payload = await api('/clear', { method: 'POST' })
          setData((prev) => ({ ...(prev ?? {}), ...payload }))
          setError('')
          return payload
        } catch (failure) {
          setError(String(failure?.message ?? failure))
          return null
        }
      }, [])
      return { data, error, load, save, reset, clear }
    }

    function SettingsSection(props) {
      const t = useT(props.locale, props.t)
      const { data, error, load, save, reset, clear } = useSettingsData()
      const [open, setOpen] = useState(false)
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState('')

      const settings = data?.settings
      const models = Array.isArray(data?.models) ? data.models : []

      /**
       * 改一项就落盘；失败时把本地值退回读到的值（回包为准）。
       */
      const change = useCallback(async (patch, doneLabel) => {
        setBusy('save')
        const payload = await save(patch)
        setBusy('')
        setStatus(payload === null ? '' : doneLabel)
      }, [save])

      const modelOptions = (() => {
        const options = [{ value: 'session', label: t('settings.followSession') }]
        const seen = new Map()
        for (const model of models) {
          const name = model.name ?? model.id
          const short = String(model.provider ?? '').replace(/^deepseek-/u, '')
          seen.set(name, (seen.get(name) ?? 0) + 1)
          options.push({
            value: `${model.provider}|${model.id}`,
            label: seen.get(name) > 1 ? `${name} · ${short}` : name,
          })
        }
        if (settings !== undefined && settings.model !== 'session' && options.every((option) => option.value !== settings.model)) {
          options.push({ value: settings.model, label: String(settings.model).replace('|', ' · ') })
        }
        return options
      })()

      const lengths = [...new Set([...LENGTHS, settings?.maxChars].filter((value) => typeof value === 'number'))].sort((a, b) => a - b)

      const guessNow = useCallback(async () => {
        if (data?.session === undefined || data.session === '') {
          setStatus(t('settings.noSession'))
          return
        }
        setBusy('guess')
        setStatus(t('settings.guessing'))
        try {
          const payload = await api(withSession('/guess', data.session), { method: 'POST' })
          setStatus(typeof payload.text === 'string' && payload.text !== '' ? t('settings.guessDone') : t('settings.guessNone'))
        } catch (failure) {
          setStatus(`${t('settings.guessFailed')}（${String(failure?.message ?? failure)}）`)
        }
        setBusy('')
        await load()
      }, [data, load, t])

      // 这一节挂在插件详情页里，所以自己画小节 chrome（标题 + 说明），和同页其他 section 对齐。
      const head = [
        h('h4', { key: 'title', className: 'lnp-detailTitle' }, t('settings.title')),
        h('p', { key: 'desc', className: 'lnp-desc' }, t('settings.description')),
      ]

      if (data === null) {
        return h('section', { className: 'lnp-detail', 'data-plugin': 'dsh-next-prompt', 'data-section': 'next-prompt' }, head,
          h('p', { className: error === '' ? 'lnp-hint' : 'lnp-status', 'data-error': error === '' ? 'false' : 'true' },
            error === '' ? t('settings.loading') : `${t('settings.failed')}（${error}）`))
      }

      const debug = data.debug ?? {}
      const stats = data.stats ?? {}
      const rate = data.rate
      const took = Number(debug.ms ?? 0)

      return h('section', { className: 'lnp-detail', 'data-plugin': 'dsh-next-prompt', 'data-section': 'next-prompt' },
        head,

        h(Field, {
          label: t('settings.auto'),
          hint: t('settings.autoHint'),
          control: h(Switch, {
            checked: settings.auto,
            label: t('settings.auto'),
            onChange: (next) => { void change({ auto: next }, t('settings.saved')) },
          }),
        }),

        h(Field, {
          label: t('settings.length'),
          hint: t('settings.lengthHint'),
          control: h(Segmented, {
            value: settings.maxChars,
            options: lengths,
            label: t('settings.length'),
            onChange: (next) => { void change({ maxChars: Number(next) }, t('settings.saved')) },
          }),
        }),

        h(Field, {
          label: t('settings.candidates'),
          hint: t('settings.candidatesHint'),
          control: h(Segmented, {
            value: settings.candidates,
            options: COUNTS,
            label: t('settings.candidates'),
            onChange: (next) => { void change({ candidates: Number(next) }, t('settings.saved')) },
          }),
        }),

        h(Field, {
          label: t('settings.model'),
          hint: t('settings.modelHint'),
          control: h('select', {
            className: 'lnp-select',
            'aria-label': t('settings.model'),
            value: settings.model,
            onChange: (event) => { void change({ model: event.target.value }, t('settings.saved')) },
          }, modelOptions.map((option) => h('option', { key: option.value, value: option.value }, option.label))),
        }),

        h('p', { className: 'lnp-hint' }, t('settings.limits', {
          timeout: secs(settings.timeoutMs),
          debounce: settings.debounceMs,
          tokens: settings.maxTokens,
        })),

        h('div', { className: 'lnp-actions' },
          h('button', {
            type: 'button',
            className: 'lnp-btn',
            disabled: busy !== '',
            onClick: () => { void guessNow() },
          }, h(RefreshIcon), t('settings.guessNow')),
          h('button', {
            type: 'button',
            className: 'lnp-btn',
            disabled: busy !== '',
            onClick: async () => { setBusy('reset'); await reset(); setBusy(''); setStatus(t('settings.resetDone')) },
          }, t('settings.reset')),
          h('span', { className: 'lnp-status', 'data-error': error === '' ? 'false' : 'true' },
            error === '' ? status : `${t('settings.failed')}（${error}）`)),

        h('div', { className: 'lnp-debug' },
          h('button', {
            type: 'button',
            className: 'lnp-summary',
            'aria-expanded': open ? 'true' : 'false',
            onClick: () => setOpen(!open),
          }, h(ChevronIcon), t('settings.debug')),

          open
            ? h('div', null,
              h('p', { className: 'lnp-hint' }, t('settings.debugHint')),
              h('dl', { className: 'lnp-dl' },
                h('dt', null, t('settings.lastGuess')),
                h('dd', null, Number(debug.at ?? 0) === 0 ? t('settings.notYet') : new Date(debug.at).toLocaleTimeString()),
                h('dt', null, t('settings.lastModel')),
                h('dd', null, debug.model === undefined || debug.model === '' ? '—' : debug.model),
                h('dt', null, t('settings.lastTook')),
                h('dd', null, took === 0 ? '—' : secs(took)),
                h('dt', null, t('settings.lastResult')),
                h('dd', null, debug.error === undefined || debug.error === ''
                  ? (Number(debug.at ?? 0) === 0 ? '—' : t('settings.generated'))
                  : debug.error),
                typeof debug.skip === 'string' && debug.skip !== ''
                  ? h('dt', null, t('settings.skipped'))
                  : null,
                typeof debug.skip === 'string' && debug.skip !== ''
                  ? h('dd', null, skipLabel(debug.skip, t))
                  : null,
                h('dt', null, t('settings.statsShown')),
                h('dd', null, `${stats.shown ?? 0} / ${stats.accepted ?? 0}`),
                h('dt', null, t('settings.statsIgnored')),
                h('dd', null, `${stats.ignored ?? 0} / ${stats.reguessed ?? 0}`),
                h('dt', null, t('settings.acceptance')),
                h('dd', null, rate === null || rate === undefined ? '—' : `${Math.round(rate * 100)}%`)),
              h('p', { className: 'lnp-contextLabel' }, t('settings.context')),
              h('pre', { className: 'lnp-code' }, debug.context === undefined || debug.context === '' ? t('settings.noCall') : debug.context),
              h('div', { className: 'lnp-actions' },
                h('button', {
                  type: 'button',
                  className: 'lnp-btn',
                  disabled: busy !== '',
                  onClick: async () => { setBusy('clear'); await clear(); setBusy(''); setStatus(t('settings.cleared')) },
                }, t('settings.clear'))))
            : null))
    }

    // ── 注册 ────────────────────────────────────────────────────────────────
    return {
      name: '@sunt2049/dsh-next-prompt',
      inject: ['slots', 'locale'],
      apply(ctx) {
        const locale = ctx.get('locale')
        const slots = ctx.get('slots')
        if (slots === undefined) return
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-next-prompt: dictionaries')
        ctx.effect(() => installStyles(), 'dsh-next-prompt: styles')
        const t = ctx.locale.bind(NS)

        // 输入框下方的一行：composer.dock 是 session 作用域的 list 槽，
        // 每条只拿到本会话的 props，不写别人的 DOM。
        slots.inject('conversation.composer.dock', () => slots.register({
          name: 'conversation.composer.dock',
          id: 'next-prompt',
          order: 2,
          label: () => t('dock.empty'),
          locale: NS,
        }, (props) => h(NextPromptDock, { ...props, locale })))

        // 设置放在**插件详情页**里（插件 → 已装 → @sunt2049/dsh-next-prompt → 详情），
        // 和 mcp-manager / dsh-context 的做法一致：这个插件没有独立的偏好入口，
        // 把「开关 + 调试」跟着插件本身走更好找。
        // 详情页会给每个 subject 都调一次，不是自己就渲染 null。
        slots.inject('plugins.detail.section', () => slots.register({
          name: 'plugins.detail.section',
          id: 'next-prompt',
          order: 0,
          label: () => t('settings.title'),
          locale: NS,
        }, (props) => {
          const subject = props?.subject
          const name = subject?.kind === 'bundle' || subject?.kind === 'row' ? subject.pkg?.name : undefined
          return name === MY_NAME ? h(SettingsSection, { ...props, locale }) : null
        }))
      },
    }
  },
})
