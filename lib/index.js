// dsh-next-prompt 的入口：一份包，两个壳。
//
//   手机端（dsh-go）→ lib/shell-dsh-go.js    composer.strip 三态胶囊 + 面板
//   Web / 桌面端    → lib/desktop/host.js    回合结束生成 + /dsh-next-prompt 路由
//                     lib/desktop/client.js  浏览器半：输入框下方的胶囊 + 设置页
//
// 两边共用 lib/core.js（拼状态块、洗输出）与 lib/settings.js / lib/stats.js（落盘）。
// 判断方式是“dshGo 服务在不在”：dsh-go 提供 dshGo，DSH 不提供。
import { buildContext, cleanSuggestion, isIdle, isInjectedMessage, isUserText, readTodos, recentUserTexts } from './core.js'
import { applyDesktop } from './desktop/host.js'
import { applyDshGo } from './shell-dsh-go.js'

export const name = '@sunt2049/dsh-next-prompt'

/**
 * 宿主上有没有 dsh-go 的桥接服务。
 *
 * 先走 `ctx.get()`（未提供时返回 undefined，不抛）；再退回属性读取，
 * 因为有的宿主把服务直接挂在 ctx 上——而 Cordis 里“没 inject 就取属性”会抛，
 * 所以那一读必须包起来。
 */
function hasDshGo(ctx) {
  try {
    if (typeof ctx.get === 'function' && ctx.get('dshGo') !== undefined) return true
  } catch {}
  try {
    if (ctx.dshGo !== undefined) return true
  } catch {}
  return false
}

export function apply(ctx) {
  if (hasDshGo(ctx)) {
    applyDshGo(ctx)
    return
  }
  applyDesktop(ctx)
}

/** 给离线/现场校验用的纯函数出口；运行时行为不依赖它。 */
export const __test = { buildContext, readTodos, cleanSuggestion, isIdle, isUserText, isInjectedMessage, recentUserTexts }
