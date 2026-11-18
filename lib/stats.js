// 埋点：建议被显示 / 采用 / 忽略 / 重猜的次数，存在 stats.json。
// 不做上报，只给设置页的「调试」页看接受率，方便自己判断提示词好不好。
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const RECENT = 20
const KINDS = ['shown', 'accepted', 'ignored', 'reguessed']

export const emptyStats = () => ({ shown: 0, accepted: 0, ignored: 0, reguessed: 0, recent: [] })

const statsPath = (dir) => join(dir, 'stats.json')
const int = (value) => (Number.isFinite(Number(value)) ? Math.max(0, Math.round(Number(value))) : 0)

export function loadStats(dir) {
  try {
    const raw = JSON.parse(readFileSync(statsPath(dir), 'utf8'))
    const stats = emptyStats()
    for (const kind of KINDS) stats[kind] = int(raw?.[kind])
    if (Array.isArray(raw?.recent)) {
      stats.recent = raw.recent
        .slice(-RECENT)
        .filter((item) => item !== null && typeof item === 'object' && typeof item.kind === 'string')
        .map((item) => ({ at: int(item.at), kind: item.kind, text: typeof item.text === 'string' ? item.text.slice(0, 40) : '' }))
    }
    return stats
  } catch {
    return emptyStats()
  }
}

/** 记一笔；写失败不影响猜句子。 */
export function record(dir, kind, text = '') {
  const stats = loadStats(dir)
  if (!KINDS.includes(kind)) return stats
  stats[kind] += 1
  stats.recent = [...stats.recent, { at: Date.now(), kind, text: String(text).slice(0, 40) }].slice(-RECENT)
  try {
    const path = statsPath(dir)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(stats, null, 2)}\n`)
    renameSync(tmp, path)
  } catch {}
  return stats
}

export function clearStats(dir) {
  try {
    const path = statsPath(dir)
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(emptyStats(), null, 2)}\n`)
    renameSync(tmp, path)
  } catch {}
  return emptyStats()
}

/** 接受率：采用 / (采用 + 忽略)；没有样本时返回 null。 */
export function acceptance(stats) {
  const total = (stats?.accepted ?? 0) + (stats?.ignored ?? 0)
  if (total === 0) return null
  return (stats?.accepted ?? 0) / total
}
