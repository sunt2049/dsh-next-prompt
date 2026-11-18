// dsh-next-prompt 的核心：纯函数，不碰 ctx、不发请求、不 import 任何包。
// 手机端（lib/index.js）和以后电脑端的壳都从这里取同一份逻辑。
//
// 输入是「会话消息数组 + todo 数组」，输出是「要发给模型的状态块」或「一句干净的建议」。

/** 一句话的长度上限。胶囊上要短，PC 端做 ghost text 时也可以按它截断。 */
export const MAX_SUGGESTION_CHARS = 14

/** 往回最多看这么多条消息去找“最后一条用户消息 / 最后一次报错”。 */
const SCAN_MESSAGES = 120
const TURN_CHARS = 300
const TODO_ITEMS = 10
const ERROR_CHARS = 300
const FILE_ITEMS = 6
const TODO_MARK = { completed: '✓', in_progress: '▶', pending: '·' }
/** 会改文件的工具：只看这几种的 tool-call 参数。 */
const EDIT_TOOLS = new Set(['write', 'edit'])
/** 没有传工作区根目录时的默认值（手机本机引擎的 workspace）。 */
const DEFAULT_WORKSPACE = '/root/workspace'

export const SYSTEM = [
  '你是一个“下一句预测器”：根据给到的状态和最后一句对话，猜用户接下来最可能输入的那一句话。',
  '规则：',
  '1. 只输出这句话本身：不要引号、不要解释、不要 Markdown、不要换行、不要编号。',
  '2. 越短越好，不超过 10 个字；用与用户最后一条消息相同的语言。',
  '3. 必须是用户会对助手说的话（指令、确认或追问），不能复述助手说过的话。',
  '4. 有待办没做完时，预测用户催的那一步或补的条件。',
  '5. 有报错时，预测用户对此的反应（重试、换个做法、先解释）。',
  '6. 助手最后在提问或给了选项时，预测用户最可能的回答。',
  '7. 有具体对象就写具体对象（文件名、函数名、参数），不要只说“继续”“好”。',
  '8. 不要复述用户已经说过的消息；完全看不出来才输出“继续”。',
].join('\n')

const clamp = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text)

/** 比较用的归一化：去掉空白与标点，避免只差一个句号就算“新的一句”。 */
export const comparable = (text) => text.replace(/[\s。！？，、,.!?；;：:「」『』“”"'（）()]/gu, '').toLowerCase()

/** 一条消息里的纯文本（忽略 reasoning、tool-call 等块）。 */
export function textOf(message) {
  const blocks = Array.isArray(message?.content) ? message.content : []
  const parts = []
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

/**
 * 这条消息是不是 DSH 注入的上下文：`dsh-time-context` 的时间快照、model-selection、
 * tool-registry 之类都会作为一条“用户角色”的消息塞进请求里，但它们不是你打的字。
 * 真实用户消息的 `source` 是 `{ kind: 'user' }`；没有 `source` 的（旧格式 / 测试桩）按用户消息算。
 */
export function isInjectedMessage(message) {
  const source = message?.source
  if (source === null || typeof source !== 'object') return false
  return typeof source.kind === 'string' && source.kind !== 'user'
}

/** 这条消息是用户自己打的字（不是注入的上下文，也不是空白）。 */
export function isUserText(message) {
  return message?.role === 'user' && !isInjectedMessage(message) && textOf(message) !== ''
}

/** 模型输出 -> 一句干净的建议；空字符串表示这次不要显示。 */
export function cleanSuggestion(raw, maxChars = MAX_SUGGESTION_CHARS) {
  let text = String(raw ?? '').split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== '') ?? ''
  text = text.replace(/^[-*•\d.、)\s]+/u, '')
  text = text.replace(/^(用户|User|建议)[：:]\s*/u, '')
  text = text.replace(/^["'“”‘’「」『』]+/u, '').replace(/["'“”‘’「」『』]+$/u, '')
  const chars = [...text.trim()]
  if (chars.length > maxChars) text = chars.slice(0, maxChars).join('')
  const stop = text.search(/[。！!？?]/u)
  if (stop >= 2 && stop < text.length - 1) text = text.slice(0, stop + 1)
  return text.replace(/。$/u, '').trim()
}

/** 一眼就知道是敷衍的候选。 */
const GENERIC = new Set(['继续', '好', '嗯', '行', '好的', '可以', 'ok', 'okay', 'continue', 'yes'])

/**
 * 给一条候选打分：越具体越高分。
 * 规则故意写得很朴素——能被看懂、能改，就不用再训个模型。
 */
export function scoreSuggestion(text) {
  const value = String(text ?? '').trim()
  if (value === '') return -10
  const length = [...value].length
  let score = 0
  if (length >= 4) score += 1
  if (length >= 6) score += 1
  // 具体对象：英文标识、数字、文件名、参数
  if (/[A-Za-z]|\d|--|\/|\./u.test(value)) score += 2
  // 带引号/书名号的具体名词
  if (/[“”"「」『』]/u.test(value)) score += 1
  if (GENERIC.has(value.toLowerCase())) score -= 3
  return score
}

/** 从模型输出里切出候选：逐行清洗、去重、截到 limit 条。 */
export function splitCandidates(raw, limit = 1, maxChars = MAX_SUGGESTION_CHARS) {
  const lines = String(raw ?? '')
    .split(/\r?\n/u)
    .map((line) => cleanSuggestion(line, maxChars))
    .filter((line) => line !== '')
  const unique = [...new Set(lines)]
  return unique.slice(0, Math.max(1, Number(limit) || 1))
}

/** 多条候选里挑最好的那条：比分数，分数一样就取先出现的。 */
export function pickBest(candidates) {
  let best
  let bestScore = -Infinity
  for (const text of candidates) {
    const score = scoreSuggestion(text)
    if (score > bestScore) {
      best = text
      bestScore = score
    }
  }
  return best ?? ''
}

/** 工作区里的路径：去掉根目录前缀并截断（两种分隔符都认：Linux `/`、Windows `\`）。 */
function shortPath(value, workspaceRoot) {
  const root = typeof workspaceRoot === 'string' && workspaceRoot !== '' ? workspaceRoot.replace(/[\\/]+$/u, '') : DEFAULT_WORKSPACE
  for (const separator of ['/', '\\']) {
    const prefix = `${root}${separator}`
    if (value.startsWith(prefix)) return value.slice(prefix.length).slice(0, 80)
  }
  return value.slice(0, 80)
}

/** 从 tool-call 的 JSON 参数里取文件路径。 */
function filePathOf(argumentsText, workspaceRoot) {
  try {
    const parsed = typeof argumentsText === 'string' ? JSON.parse(argumentsText) : argumentsText
    const value = parsed?.file_path ?? parsed?.path ?? parsed?.filePath
    return typeof value === 'string' && value !== '' ? shortPath(value, workspaceRoot) : undefined
  } catch {
    return undefined
  }
}

/** 本回合被 write/edit 动过的文件，按时间顺序，最多 FILE_ITEMS 个。 */
export function readTouchedFiles(messages, from, workspaceRoot) {
  const files = []
  const seen = new Set()
  for (let index = messages.length - 1; index > from; index--) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    for (const block of message.content ?? []) {
      if (block?.type !== 'tool-call' || !EDIT_TOOLS.has(block.name)) continue
      const path = filePathOf(block.arguments, workspaceRoot)
      if (path === undefined || seen.has(path)) continue
      seen.add(path)
      files.unshift(path)
      if (files.length >= FILE_ITEMS) return files
    }
  }
  return files
}

/**
 * 本回合的 todo 快照：投影规则是 `todo/write` 覆盖、`turn/start` 清空，
 * 所以从末尾往回找，先遇到哪种就是哪种。
 * @param session 只要 `{ seq, eventAt(seq) }` 形状，手机端传 Session，PC 端可以传真对象。
 */
export function readTodos(session) {
  const end = Number(session?.seq ?? 0)
  for (let seq = end - 1; seq >= 0 && seq > end - 200; seq--) {
    const event = session.eventAt?.(seq)
    if (event === undefined) continue
    if (event.type === 'turn/start') return null
    if (event.type === 'todo/write') return Array.isArray(event.data?.todos) ? event.data.todos : null
  }
  return null
}

/**
 * 状态块：待办 + 本回合报错 + 本回合改动的文件 + 最后两句。
 * @param messages 会话消息（role/content 数组即可，不要求冻结或带 id）
 * @param todos `readTodos()` 的结果，或任何 `[{content, status}]`
 * @param options `{ workspaceRoot }`
 * @returns 要发给模型的整段文本；空字符串表示没有可预测的内容。
 */
export function buildContext(messages, todos, options = {}) {
  const list = Array.isArray(messages) ? messages : []
  const tail = list.slice(-SCAN_MESSAGES)
  const parts = []

  if (Array.isArray(todos) && todos.length > 0) {
    const lines = todos
      .slice(0, TODO_ITEMS)
      .map((item) => `${TODO_MARK[item?.status] ?? '·'} ${clamp(String(item?.content ?? ''), 60)}`)
    parts.push(`本回合待办：\n${lines.join('\n')}`)
  }

  // 最后一条用户消息之后才算“本回合”，避免翻出上一轮已经处理过的旧报错。
  // 跳过注入的上下文消息（dsh-time-context 等）——否则“用户最后一条消息”会变成一串时间戳。
  let lastUser = -1
  for (let index = tail.length - 1; index >= 0; index--) {
    if (isUserText(tail[index])) {
      lastUser = index
      break
    }
  }

  const toolNames = new Map()
  for (const message of tail) {
    for (const block of message?.content ?? []) {
      if (block?.type === 'tool-call' && typeof block.id === 'string' && typeof block.name === 'string') toolNames.set(block.id, block.name)
    }
  }

  let lastError
  for (let index = tail.length - 1; index > lastUser; index--) {
    const message = tail[index]
    if (message?.role === 'tool' && message.isError === true) {
      lastError = message
      break
    }
  }
  if (lastError !== undefined) {
    const name = toolNames.get(lastError.toolCallId) ?? '工具'
    parts.push(`本回合最近一次报错（${name}）：\n${clamp(textOf(lastError), ERROR_CHARS)}`)
  }

  const files = lastUser >= 0 ? readTouchedFiles(tail, lastUser, options.workspaceRoot) : []
  if (files.length > 0) parts.push(`本回合改动的文件：\n${files.map((file) => `· ${file}`).join('\n')}`)

  if (lastUser >= 0) parts.push(`用户最后一条消息：\n${clamp(textOf(tail[lastUser]), TURN_CHARS)}`)

  let lastAssistant
  for (let index = tail.length - 1; index > lastUser; index--) {
    const message = tail[index]
    if (message?.role === 'assistant' && textOf(message) !== '') {
      lastAssistant = message
      break
    }
  }
  if (lastAssistant !== undefined) parts.push(`助手最后一条回复：\n${clamp(textOf(lastAssistant), TURN_CHARS)}`)

  if (parts.length === 0) return ''
  const count = Math.max(1, Math.min(3, Math.round(Number(options.candidates) || 1)))
  const ask = count > 1 ? `给出 ${count} 条候选，每行一条，不要编号、不要引号。` : '只输出用户的下一条输入。'
  return `${parts.join('\n\n')}\n\n${ask}`
}

/** 会话当前是否空闲：最后一个回合已结束，没有进行中的回合。 */
export function isIdle(session) {
  const end = Number(session?.seq ?? 0)
  if (end === 0) return false
  for (let seq = end - 1; seq >= 0 && seq > end - 80; seq--) {
    const event = session.eventAt?.(seq)
    if (event === undefined) continue
    if (event.type === 'turn/end') return true
    if (event.type === 'turn/start') return false
  }
  return false
}

/** 事件时间戳；读不到就当 0。 */
export function timeOf(event) {
  const time = Number(event?.time ?? 0)
  return Number.isFinite(time) ? time : 0
}

/** 用户最近说过的话（归一化后），用来拦“把人家刚说的话推回去”。注入的上下文不算。 */
export function recentUserTexts(messages, count = 2) {
  const list = Array.isArray(messages) ? messages : []
  const texts = []
  for (let index = list.length - 1; index >= 0 && texts.length < count; index--) {
    if (!isUserText(list[index])) continue
    texts.push(comparable(textOf(list[index])))
  }
  return texts
}

/**
 * 这条建议是不是在重复用户刚说过的话。
 *
 * 归一化后完全相同算重复；又因为建议本身会被截到十几字，所以“是用户某句话的前缀”
 * 也算重复——否则模型原样回一句长消息时，截断之后就正好绕过去重。
 * 太短的前缀（<6 字，例如“继续”）不算，免得把正常的短建议误杀。
 */
export function repeatsUser(suggestion, recentUsers) {
  const text = comparable(String(suggestion ?? ''))
  if (text === '') return false
  const list = Array.isArray(recentUsers) ? recentUsers : []
  return list.some((user) => {
    if (typeof user !== 'string' || user === '') return false
    return user === text || (text.length >= 6 && user.startsWith(text))
  })
}
