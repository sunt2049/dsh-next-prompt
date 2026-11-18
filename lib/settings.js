// 设置：默认值、范围校验、读写 settings.json。
// 只做纯数据处理 + 一次文件读写，不碰 ctx。
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const DEFAULTS = Object.freeze({
  /** 回合结束后自动猜 */
  auto: true,
  /** 一句话的字数上限（胶囊显示与插入共用） */
  maxChars: 14,
  /** 'session' 跟随会话，或 'provider|model' 固定 */
  model: 'session',
  /** 一次生成几条候选再挑一条（1 = 不挑） */
  candidates: 1,
  maxTokens: 96,
  timeoutMs: 15_000,
  debounceMs: 1_200,
})

export const RANGES = Object.freeze({
  candidates: { min: 1, max: 3 },
  maxChars: { min: 6, max: 24 },
  maxTokens: { min: 48, max: 256 },
  timeoutMs: { min: 5_000, max: 30_000 },
  debounceMs: { min: 300, max: 3_000 },
})

/** 设置页给出的几档文字长度（App 胶囊最多显示 24 字）。 */
export const LENGTH_CHOICES = Object.freeze([10, 14, 18, 24])

const clampInt = (value, fallback, range) => {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return fallback
  return Math.min(range.max, Math.max(range.min, number))
}

/** 'provider|model' -> {provider, model}；不是这个形状返回 undefined。 */
export function parseModel(value) {
  if (typeof value !== 'string') return undefined
  const at = value.indexOf('|')
  if (at <= 0 || at === value.length - 1) return undefined
  return { provider: value.slice(0, at), model: value.slice(at + 1) }
}

/** 把任意输入收成一个可用的设置对象：未知字段丢掉，越界夹回去。 */
export function sanitize(raw) {
  const input = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
  const model = input.model === 'session' || parseModel(input.model) !== undefined ? input.model : DEFAULTS.model
  return {
    auto: typeof input.auto === 'boolean' ? input.auto : DEFAULTS.auto,
    maxChars: clampInt(input.maxChars, DEFAULTS.maxChars, RANGES.maxChars),
    candidates: clampInt(input.candidates, DEFAULTS.candidates, RANGES.candidates),
    model,
    maxTokens: clampInt(input.maxTokens, DEFAULTS.maxTokens, RANGES.maxTokens),
    timeoutMs: clampInt(input.timeoutMs, DEFAULTS.timeoutMs, RANGES.timeoutMs),
    debounceMs: clampInt(input.debounceMs, DEFAULTS.debounceMs, RANGES.debounceMs),
  }
}

export const settingsPath = (dir) => join(dir, 'settings.json')

/** 读设置；文件不存在或坏了就用默认值（不抛错，插件照常工作）。 */
export function loadSettings(dir) {
  try {
    return sanitize(JSON.parse(readFileSync(settingsPath(dir), 'utf8')))
  } catch {
    return { ...DEFAULTS }
  }
}

/** 原子写回；返回实际落盘的值。 */
export function saveSettings(dir, next) {
  const value = sanitize(next)
  const path = settingsPath(dir)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`)
  renameSync(tmp, path)
  return value
}

/**
 * 表单提交回来的值 -> 设置补丁。
 * App 到底把绑定的字段摊平成对象、包一层 values、还是给 [{name,value}]，
 * 协议里没写死，这里全都认：只挑得出的三项。
 */
export function patchFromForm(value) {
  const flat = {}
  const walk = (node, depth = 0) => {
    if (depth > 4 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    // [{ name, value }] 这种列表式形状
    if (typeof node.name === 'string' && Object.hasOwn(node, 'value') && typeof node.value !== 'object') {
      flat[node.name.replace(/^data\./u, '')] = node.value
      return
    }
    for (const [key, item] of Object.entries(node)) {
      if (item !== null && typeof item === 'object') walk(item, depth + 1)
      // App 送回来的是绑定路径本身（"data.auto"），去掉前缀再按字段名匹配。
      else flat[key.replace(/^data\./u, '')] = item
    }
  }
  walk(value)

  const patch = {}
  if (typeof flat.auto === 'boolean') patch.auto = flat.auto
  else if (flat.auto === 'on' || flat.auto === 'off') patch.auto = flat.auto === 'on'
  if (flat.maxChars !== undefined && Number.isFinite(Number(flat.maxChars))) patch.maxChars = Number(flat.maxChars)
  if (typeof flat.model === 'string' && flat.model !== '') patch.model = flat.model
  if (flat.candidates !== undefined && Number.isFinite(Number(flat.candidates))) patch.candidates = Number(flat.candidates)
  return patch
}
