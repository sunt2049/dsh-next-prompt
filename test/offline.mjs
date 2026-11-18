// 离线跑一遍 dsh-next-prompt：假 ctx + 假会话 + 假模型流，覆盖带/不带 sessionId 两条路径。
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadSettings, settingsPath } from '../lib/settings.js'
import { loadStats } from '../lib/stats.js'

// 这个测试会写插件目录的 settings.json / stats.json：在**应用插件之前**拍快照，退出时还原。
// 放在进程退出时做，是因为最后一次手动生成是异步的，可能在本文件结束之后才写回埋点。
const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const settingsFile = settingsPath(PLUGIN_DIR)
const settingsSnapshot = existsSync(settingsFile) ? readFileSync(settingsFile, 'utf8') : undefined
const statsFile = new URL('../stats.json', import.meta.url)
const statsSnapshot = existsSync(statsFile) ? readFileSync(statsFile, 'utf8') : undefined
process.on('exit', () => {
  if (settingsSnapshot === undefined) rmSync(settingsFile, { force: true })
  else writeFileSync(settingsFile, settingsSnapshot)
  if (statsSnapshot === undefined) rmSync(statsFile, { force: true })
  else writeFileSync(statsFile, statsSnapshot)
})

const PLUGIN = new URL('../lib/index.js', import.meta.url).href
const mod = await import(PLUGIN)

const logs = []
const handlers = new Map()
const listeners = []
const feeds = []
const panels = new Map()
let capturedPrompt = ''
let calls = 0
let lastCallConfig = null

const todos = [
  { content: '把 buildContext 换成状态块', status: 'completed' },
  { content: '缩短胶囊文案到 10 字', status: 'in_progress' },
  { content: '打包到 PC 版', status: 'pending' },
]

const messages = [
  { role: 'user', content: [{ type: 'text', text: '把这个脚本改成从参数读路径。' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
  { role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'bash: chromium: command not found（exit 127）' }] },
  { role: 'user', content: [{ type: 'text', text: '先只调上下文，改成带 todo 和报错。' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c3', name: 'write', arguments: JSON.stringify({ file_path: '/root/workspace/demo.txt' }) }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c4', name: 'edit', arguments: JSON.stringify({ file_path: '/root/workspace/lib/app.js' }) }] },
  { role: 'tool', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'node: bad option: --experimental-strip-types（exit 9）' }] },
  { role: 'assistant', content: [{ type: 'text', text: '改好了，胶囊也缩短到 10 字。要现在重启引擎试一次吗？' }] },
]

const makeSession = (id, time) => ({
  id,
  seq: 6,
  header: {},
  eventAt: (seq) => {
    if (seq === 0) return { type: 'turn/start', time: time - 50 }
    if (seq === 1) return { type: 'todo/write', time: time - 40, data: { todos } }
    if (seq === 5) return { type: 'turn/end', time, data: { turn: 1, reason: { kind: 'completed' } } }
    return undefined
  },
  requestContext: () => ({ provider: 'p', model: 'm' }),
  deriveMessages: () => messages,
})

const llm = {
  async prepareCall(config, signal, configure) {
    calls += 1
    lastCallConfig = configure === undefined ? config : configure({ ...config }, { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } })
    if (signal?.aborted) throw new Error('aborted')
    return {
      config: { provider: 'p', model: 'm', maxTokens: 96, reasoningEffort: 'off' },
      stream: (options) => {
        capturedPrompt = options.messages[0].content[0].text
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text: '“要，重启试试。”' }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
  },
}

const sessions = [makeSession('s1', 100), makeSession('s2', 300)]
const ctx = {
  logger: { warn: (m) => logs.push(String(m)) },
  get(name) {
    if (name === 'sessions') return { get: (id) => sessions.find((s) => s.id === id), list: () => sessions }
    if (name === 'llm') return llm
    if (name === 'dshGo') return ctx.dshGo
    return undefined
  },
  on(name, fn) { listeners.push([name, fn]) },
  effect(fn) { return fn() },
  inject(names, fn) { fn(ctx) },
  dshGo: {
    strip(id, fn) { feeds.push([id, fn]) },
    on(id, fn) { handlers.set(id, fn) },
    panel(id, def) { panels.set(id, def) },
  },
}

mod.apply(ctx)
const [, stripFn] = feeds[0]
if (typeof stripFn !== 'function') throw new Error('strip 没注册')

const dispatch = (session, event) => { for (const [name, fn] of listeners) if (name === 'session/event') fn(session, event) }

// 1) 带 sessionId
const emits = []
const off = stripFn({ sessionId: 's1' }, (v) => emits.push(v), { protocol: 1, locale: 'zh-CN' })
dispatch(sessions[0], { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await new Promise((r) => setTimeout(r, 1800))
console.log('1 带 sessionId:', JSON.stringify(emits))
console.log('--- 发给模型的上下文 ---')
console.log(capturedPrompt)
console.log('--- 结束 ---')
console.log('1 点按:', JSON.stringify(handlers.get('next')({ sessionId: 's1' }, { locale: 'zh-CN' })))
console.log('1 点按后:', JSON.stringify(emits.slice(-1)))
console.log('1 再点一次:', JSON.stringify(handlers.get('next')({ sessionId: 's1' }, { locale: 'zh-CN' })))
await new Promise((r) => setTimeout(r, 600))
console.log('1 重猜后:', JSON.stringify(emits.slice(-1)))
console.log('1 再点:', JSON.stringify(handlers.get('next')({ sessionId: 's1' }, { locale: 'zh-CN' })))
console.log('1 再点后:', JSON.stringify(emits.slice(-1)))
off()

// 2) 新开一个空对话：订阅里没有 sessionId —— 必须什么都不显示，也不能借用别的会话
const emptyEmits = []
const offEmpty = stripFn({}, (v) => emptyEmits.push(v), { protocol: 1, locale: 'zh-CN' })
await new Promise((r) => setTimeout(r, 900))
console.log('2 空对话显示:', JSON.stringify(emptyEmits))
console.log('2 空对话点按:', JSON.stringify(handlers.get('next')({}, { locale: 'zh-CN' })))
offEmpty()

// 3) 有 sessionId 但还没说过话：不猜，点了给提示
sessions.push({ id: 's3', seq: 0, header: {}, eventAt: () => undefined, requestContext: () => ({ provider: 'p', model: 'm' }), deriveMessages: () => [] })
const freshEmits = []
const offFresh = stripFn({ sessionId: 's3' }, (v) => freshEmits.push(v), { protocol: 1, locale: 'zh-CN' })
await new Promise((r) => setTimeout(r, 900))
console.log('3 空会话显示:', JSON.stringify(freshEmits))
console.log('3 空会话点按:', JSON.stringify(handlers.get('next')({ sessionId: 's3' }, { locale: 'zh-CN' })))
offFresh()

console.log('模型调用参数:', JSON.stringify(lastCallConfig))
console.log('日志:', JSON.stringify(logs))

// 4) 设置面板：视图能画、动作能落盘
const def = panels.get('settings')
const entry = panels.get('entry')
if (def === undefined) throw new Error('设置面板没注册')
const view = await def.view({ sessionId: 's1' }, { protocol: 1, locale: 'zh-CN' })
const tabs = view.type === 'collapsible' ? view.children[0] : view
console.log('4 面板:', view.type, JSON.stringify(tabs.items.map((item) => item.label)))
const form = tabs.items[0].children.find((child) => child.type === 'form')
console.log('4 表单控件:', JSON.stringify(form.children.map((child) => [child.type, child.bind])))
const pushed = []
def.data({}, (value) => pushed.push(value))
console.log('4 面板数据:', JSON.stringify(pushed[0]))

// App 实际送回来的形状（来自「调试」页实测）：绑定路径当 key
def.actions.save({}, { value: { values: { 'data.auto': false, 'data.maxChars': '18', 'data.model': 'p|m2' } } })
console.log('4 真实提交落盘:', JSON.stringify(loadSettings(PLUGIN_DIR)))
console.log('4 保存后推回面板:', JSON.stringify(pushed.at(-1)))
def.actions.save({}, { value: [{ name: 'auto', value: 'on' }, { name: 'maxChars', value: '12' }] })
console.log('4 列表提交落盘:', JSON.stringify(loadSettings(PLUGIN_DIR)))
console.log('4 只猜手动:', JSON.stringify(def.actions['guess-now']({ sessionId: 's1' }, { locale: 'zh-CN' })))
def.actions.reset()
console.log('4 恢复默认:', JSON.stringify(loadSettings(PLUGIN_DIR)))

// 5) 关掉自动猜测：回合结束、打开对话都不再调模型；手动点仍然可用
import { saveSettings } from '../lib/settings.js'

saveSettings(PLUGIN_DIR, { ...loadSettings(PLUGIN_DIR), auto: false, debounceMs: 300 })
const s4 = makeSession('s4', 500)
sessions.push(s4)
const off4 = stripFn({ sessionId: 's4' }, () => {}, { protocol: 1, locale: 'zh-CN' })
await new Promise((r) => setTimeout(r, 700))
const baseline = calls
dispatch(s4, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
await new Promise((r) => setTimeout(r, 900))
console.log('5 关自动后新增调用:', calls - baseline)
handlers.get('next')({ sessionId: 's4' }, { locale: 'zh-CN' })
await new Promise((r) => setTimeout(r, 900))
console.log('5 手动点后新增调用:', calls - baseline)
off4()
saveSettings(PLUGIN_DIR, loadSettings(PLUGIN_DIR))

const entryView = await entry.view({ sessionId: 's1' }, { protocol: 1, locale: 'zh-CN' })
console.log('4 弹层入口:', JSON.stringify(entryView.children.map((child) => child.type)))
console.log('4 入口按钮:', JSON.stringify(entry.actions['open-settings']({}, { locale: 'zh-CN' })))
console.log('4 埋点:', JSON.stringify(loadStats(PLUGIN_DIR)))
// settings.json / stats.json 的还原在文件顶部的 exit 钩子里做（这里不用再管）。

