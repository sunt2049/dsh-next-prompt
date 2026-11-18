// 离线跑一遍 Web / 桌面端宿主半：假 ctx + 假会话 + 假模型流 + 假 HTTP 收发，
// 覆盖三态、去重、统计、设置读写与同源检查。不连引擎、不需要浏览器。
//
// 运行时数据写在 profile 里（DSH_PROFILE_DIR/dsh-next-prompt）；测试先把它指到临时目录，
// 跑完删掉，绝不碰真实的 profile 数据。
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const PLUGIN_DIR = fileURLToPath(new URL('..', import.meta.url))
const DATA_ROOT = mkdtempSync(join(tmpdir(), 'dsh-next-prompt-'))
const DATA_DIR = join(DATA_ROOT, 'dsh-next-prompt')
process.env.DSH_PROFILE_DIR = DATA_ROOT

const mod = await import(new URL('../lib/index.js', import.meta.url).href)

// ── 假会话 ──────────────────────────────────────────────────────────────────
const todos = [
  { content: '把 buildContext 换成状态块', status: 'completed' },
  { content: '缩短胶囊文案到 10 字', status: 'in_progress' },
  { content: '打包到 PC 版', status: 'pending' },
]
const messages = [
  // 上一轮：它的报错不该出现在上下文里
  { role: 'user', content: [{ type: 'text', text: '把这个脚本改成从参数读路径。' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
  { role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'bash: chromium: command not found（exit 127）' }] },
  // 本回合
  { role: 'user', content: [{ type: 'text', text: '先只调上下文，改成带 todo 和报错。' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'bash', arguments: '{}' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c3', name: 'write', arguments: JSON.stringify({ file_path: '/w/demo.txt' }) }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c5', name: 'edit', arguments: JSON.stringify({ file_path: '/w/lib/core.js' }) }] },
  { role: 'tool', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'node: bad option: --experimental-strip-types（exit 9）' }] },
  { role: 'assistant', content: [{ type: 'text', text: '改好了，胶囊也缩短到 10 字。要现在重启引擎试一次吗？' }] },
  // DSH 把时间上下文当成一条 user 角色消息插在最后——和真实会话一致，用来验它会被过滤掉
  {
    role: 'user',
    source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text: 'snapshot' }] },
    content: [{
      type: 'text',
      text: 'Time sampled while preparing turn 2, step 1: 2026-11-18T12:53:09Z[Asia/Shanghai]\n'
        + 'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in that zone.\n'
        + 'Elapsed since the preceding step context: 22h 38m 14s.',
    }],
  },
]

let seqEnd = 6
const events = new Map([
  [0, { type: 'turn/start', time: 1 }],
  [1, { type: 'todo/write', time: 2, data: { todos } }],
  [5, { type: 'turn/end', time: 3, data: { turn: 1, reason: { kind: 'completed' } } }],
])

const makeSession = (id, { withUser = true, origin } = {}) => ({
  id,
  seq: seqEnd,
  header: { id, cwd: '/w', ...(origin === undefined ? {} : { origin }) },
  eventAt: (seq) => events.get(seq),
  requestContext: () => ({ provider: 'p', model: 'm' }),
  deriveMessages: () => (withUser ? messages : []),
})
const sessions = new Map([
  ['s1', makeSession('s1')],
  ['empty', makeSession('empty', { withUser: false })],
  ['sub', makeSession('sub', { origin: 'subagent' })],
])

// ── 假模型 ──────────────────────────────────────────────────────────────────
const calls = { count: 0, prompt: '', config: null, effort: null }
/** 下一次生成回什么；用来验“把用户刚说的话推回来”会被丢掉。 */
let nextText = '“要，重启试试。”'
const llm = {
  listProviders: () => [{ id: 'p', name: 'P' }],
  async listModels() { return [{ id: 'm', name: 'M' }, { id: 'm2', name: 'M2' }] },
  async prepareCall(config, signal, configure) {
    calls.count += 1
    calls.config = config
    const controls = configure === undefined
      ? { ...config }
      : configure({ ...config }, { reasoning: { efforts: [{ id: 'off' }, { id: 'high' }] } })
    calls.effort = controls.reasoningEffort
    if (signal?.aborted) throw new Error('aborted')
    return {
      config: { ...controls, provider: 'p', model: 'm' },
      stream: (options) => {
        calls.prompt = options.messages[0].content[0].text
        const text = nextText
        return (async function* () {
          yield { type: 'block-start', index: 0, blockType: 'text' }
          yield { type: 'text-delta', index: 0, text }
          yield { type: 'finish', reason: { kind: 'stop' } }
        })()
      },
    }
  },
}

// ── 假 ctx / webServer / HTTP ───────────────────────────────────────────────
const listeners = []
let route
const webServer = { register(next) { route = next; return () => { route = undefined } } }

const ctx = {
  logger: { warn: (message) => logs.push(String(message)) },
  get(name) {
    if (name === 'sessions') return { get: (id) => sessions.get(id), list: () => [...sessions.values()] }
    if (name === 'llm') return llm
    if (name === 'webServer') return webServer
    return undefined
  },
  on(name, fn) { listeners.push([name, fn]) },
  effect(fn) { const cleanup = fn(); return () => { if (typeof cleanup === 'function') cleanup() } },
  inject(names, fn) {
    // 只要假 ctx 提供了这些服务，就当作注入成功（和 Cordis 的语义一致：缺一个就不跑）。
    if (names.every((name) => ctx.get(name) !== undefined)) {
      return fn({ ...ctx, webServer })
    }
    return undefined
  },
}
const logs = []

function makeResponse() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) { res.status = status; Object.assign(res.headers, headers ?? {}); return res },
    end(body) { if (body !== undefined) res.body += String(body); return res },
  }
  return res
}

function makeRequest(method, url, { body, headers } = {}) {
  const req = new EventEmitter()
  req.method = method
  req.url = url
  req.headers = headers ?? { host: '127.0.0.1:55108' }
  queueMicrotask(() => {
    if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)))
    req.emit('end')
  })
  return req
}

async function call(method, path, options = {}) {
  const req = makeRequest(method, `/dsh-next-prompt${path}`, options)
  const res = makeResponse()
  await route.handler(req, res)
  let json
  try { json = res.body === '' ? {} : JSON.parse(res.body) } catch { json = { raw: res.body } }
  return { status: res.status, json }
}

const dispatch = (session, event) => {
  for (const [name, fn] of listeners) if (name === 'session/event') fn(session, event)
}

const log = (label, value) => console.log(label, JSON.stringify(value))
const checks = []
const check = (label, ok, detail) => {
  checks.push({ label, ok })
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
}

try {
  // 没有 dshGo 服务 → 走 Web / 桌面端
  mod.apply(ctx)
  if (route === undefined) throw new Error('宿主半没有注册路由')

  // 1) 空状态
  const state1 = await call('GET', '/state?session=s1')
  check('1 空状态：有用户消息但还没有建议', state1.json.ready === true && state1.json.text === null, state1.json)

  // 1b) 浏览器打开会话：登记 watch（宿主只为“正在看”的会话自动猜）
  const watched = await call('POST', '/watch?session=s1')
  check('1b watch 后仍是空状态', watched.json.ready === true && watched.json.text === null, watched.json)

  // 2) 手动现猜（等宿主生成完才回包）
  const guessed = await call('POST', '/guess?session=s1')
  check('2 现猜返回一句话', guessed.json.text === '要，重启试试', guessed.json)
  check('2 提示词带 todo / 报错 / 改动文件 / 最后两句', guessesContext(), calls.prompt)
  check('2 最低推理强度', calls.effort === 'off', calls.effort)
  check('2 输出上限来自设置', calls.config.maxTokens === 96, calls.config)

  // 3) 有建议 → 插入后收起来
  const accepted = await call('POST', '/accept?session=s1')
  check('3 采用后清空并进入「再猜一次」', accepted.json.text === null && accepted.json.again === true, accepted.json)

  // 4) 再猜 + 手动收起
  await call('POST', '/guess?session=s1')
  const dismissed = await call('POST', '/dismiss?session=s1')
  check('4 收起后清空且不进入再猜', dismissed.json.text === null && dismissed.json.again === false, dismissed.json)

  // 5) 回合开始：旧建议立刻消失
  await call('POST', '/guess?session=s1')
  dispatch(sessions.get('s1'), { type: 'turn/start', data: { turn: 2 } })
  const afterStart = await call('GET', '/state?session=s1')
  check('5 回合开始收起旧建议', afterStart.json.text === null, afterStart.json)

  // 6) 去重：把用户刚说过的话推回来不算（只有自动生成才拦）
  nextText = '先只调上下文，改成带 todo 和报错。'
  dispatch(sessions.get('s1'), { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } })
  await sleep(1700)
  const afterDedupe = await call('GET', '/state?session=s1')
  check('6 与用户最近消息相同则丢弃', afterDedupe.json.text === null, afterDedupe.json)

  // 7) 自动猜：只看正在看的会话，子代理会话与没说过话的会话都不猜
  nextText = '“要，重启试试。”'
  const beforeAuto = calls.count
  dispatch(sessions.get('s1'), { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } })
  await sleep(1700)
  const afterAuto = await call('GET', '/state?session=s1')
  check('7 看过的会话回合结束会补猜', calls.count > beforeAuto && afterAuto.json.text !== null, `${beforeAuto} -> ${calls.count}`)

  const beforeQuiet = calls.count
  dispatch(sessions.get('empty'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  dispatch(sessions.get('sub'), { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await sleep(900)
  check('7 没看过 / 子代理会话不猜', calls.count === beforeQuiet, `${beforeQuiet} -> ${calls.count}`)

  // 8) 设置读写
  const settings1 = await call('GET', '/settings')
  check('8 设置含模型目录', Array.isArray(settings1.json.models) && settings1.json.models.length === 2, settings1.json.models)
  const saved = await call('POST', '/settings', { body: { maxChars: 18, candidates: 2 } })
  check('8 保存生效', saved.json.settings.maxChars === 18 && saved.json.settings.candidates === 2, saved.json.settings)
  check(
    '8 数据写在 profile 目录，不写插件源码目录',
    existsSync(join(DATA_DIR, 'settings.json')) && !existsSync(join(PLUGIN_DIR, 'settings.json')),
    DATA_DIR,
  )
  const reset = await call('POST', '/reset')
  check('8 恢复默认', reset.json.settings.maxChars === 14 && reset.json.settings.candidates === 1, reset.json.settings)
  check('8 埋点记到展示/采用/忽略', statsText(), JSON.stringify(readStats()))

  // 9) 清空记录
  const cleared = await call('POST', '/clear')
  check('9 清空后统计归零', cleared.json.stats.shown === 0 && cleared.json.stats.accepted === 0, cleared.json.stats)

  // 10) 方法与同源检查
  const badMethod = await call('GET', '/guess?session=s1')
  check('10 GET /guess 回 405', badMethod.status === 405, badMethod.status)
  const crossOrigin = await call('POST', '/watch?session=s1', { headers: { host: '127.0.0.1:55108', origin: 'https://evil.example' } })
  check('10 跨站来源回 403', crossOrigin.status === 403, crossOrigin.status)
  const sameOrigin = await call('POST', '/watch?session=s1', { headers: { host: '127.0.0.1:55108', origin: 'http://127.0.0.1:55108' } })
  check('10 同源来源放行', sameOrigin.status === 200, sameOrigin.status)
  const missing = await call('GET', '/nope')
  check('10 未知路径回 404', missing.status === 404, missing.status)

  const failed = checks.filter((item) => item.ok === false)
  console.log(`\n${checks.length - failed.length}/${checks.length} 通过`)
  if (failed.length > 0) process.exitCode = 1
} finally {
  rmSync(DATA_ROOT, { recursive: true, force: true })
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)) }

function guessesContext() {
  const prompt = calls.prompt ?? ''
  return prompt.includes('本回合待办')
    && prompt.includes('本回合最近一次报错（bash）') && prompt.includes('bad option')
    && prompt.includes('本回合改动的文件') && prompt.includes('· demo.txt') && prompt.includes('· lib/core.js')
    && prompt.includes('用户最后一条消息') && prompt.includes('助手最后一条回复')
    && !prompt.includes('chromium')
    // 注入的时间上下文（也是 user 角色）不能冒充“用户最后一条消息”
    && !prompt.includes('Time sampled while preparing turn')
}

function readStats() {
  try { return JSON.parse(readFileSync(join(DATA_DIR, 'stats.json'), 'utf8')) } catch { return {} }
}

function statsText() {
  const stats = readStats()
  return stats.shown >= 1 && stats.accepted >= 1 && stats.ignored >= 1
}
