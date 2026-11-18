// 现场验证：从本机最新的会话日志（zstd JSONL）复原事件与消息，
// 再用插件自己导出的 buildContext / readTodos 拼一次上下文——跑的是生产代码，不是复制品。
import { readFileSync, statSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ROOT = '/root/.dsh/sessions/--root-workspace--'

function newestSessionFile() {
  let best
  let bestTime = -1
  for (const dir of readdirSync(ROOT)) {
    const file = join(ROOT, dir, 'session.v4.jsonl.zstd')
    let stamp
    try {
      stamp = statSync(file).mtimeMs
    } catch {
      continue
    }
    if (stamp > bestTime) {
      bestTime = stamp
      best = file
    }
  }
  return best
}

function loadEvents(file) {
  const text = zstdDecompressSync(readFileSync(file)).toString('utf8')
  return text.split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

/** 事件的 seq 就是它在日志里的位置。 */
function eventsToSession(events) {
  const bySeq = new Map(events.map((event, index) => [Number(event.seq ?? index), event]))
  const tail = events.at(-1)
  return {
    id: events[0]?.data?.id ?? 'live',
    seq: Number(tail?.seq ?? events.length - 1) + 1,
    header: {},
    eventAt: (seq) => bySeq.get(seq),
  }
}

/** 与会话投影等价：用户消息、助手消息、工具结果按 seq 顺序各算一条。 */
function eventsToMessages(events) {
  const messages = []
  for (const event of events) {
    // user/message 的 data 本身就是消息；其余两种把消息放在 data.message。
    if (event.type === 'user/message') messages.push(event.data)
    else if ((event.type === 'assistant/message' || event.type === 'tool/result') && event.data?.message !== undefined) {
      messages.push(event.data.message)
    }
  }
  return messages
}

const file = newestSessionFile()
const events = loadEvents(file)
const session = eventsToSession(events)
const messages = eventsToMessages(events)

const { __test } = await import(new URL('../lib/index.js', import.meta.url).href)
const { buildContext, readTodos } = __test

const todos = readTodos(session)
const context = buildContext(messages, todos)

console.log(`会话：${file.split('/').at(-2)}（${events.length} 个事件，${messages.length} 条消息）`)
console.log(`todo：${todos === null ? '无（本回合没写过）' : `${todos.length} 条`}`)
console.log('--- 插件会发给模型的上下文 ---')
console.log(context === '' ? '（空：没有可预测的内容）' : context)
console.log('--- 结束 ---')

const lastUser = events.findLast?.((event) => event.type === 'user/message')
const lastError = [...events].reverse().find((event) => event.type === 'tool/result' && event.data?.message?.isError === true)
console.log('最后一条用户消息 seq:', lastUser?.seq, JSON.stringify(lastUser?.data?.content?.[0]?.text ?? '').slice(0, 60))
console.log('最后一条报错 seq:', lastError?.seq, '是否在最后一条用户消息之后:', (lastError?.seq ?? -1) > (lastUser?.seq ?? Infinity))
