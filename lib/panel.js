// 设置面板的视图（view v2）：常用 + 调试两页。
// 只把状态画成 JSON，不读写文件、不调模型——那些都在 index.js 的 actions 里。
//
// 交互用 form + bind：toggle / segmented / select 才是紧凑控件（options 会渲染成一列
// 单选项，又高又空）。改完点「保存」一起提交，提交值的形状见 settings.js 的 patchFromForm。
import { RANGES } from './settings.js'
import { acceptance } from './stats.js'

const isEnglish = (locale) => String(locale ?? '').toLowerCase().startsWith('en')

/** 毫秒 -> 「1.5s」。 */
const secs = (value) => `${Math.round(Number(value) / 100) / 10}s`

/** 模型显示名：同名时补一个 provider 后缀，避免四行都是一个名字。 */
function modelLabel(model) {
  return model.name ?? model.id
}

export function buildView({ settings, debug, stats, models, locale }) {
  const en = isEnglish(locale)
  const t = (cn, english) => (en ? english : cn)

  const names = new Map()
  const modelOptions = [{ label: t('跟随会话', 'Follow session'), value: 'session' }]
  for (const model of models) {
    const label = modelLabel(model)
    const short = model.provider.replace(/^deepseek-/, '')
    names.set(label, (names.get(label) ?? 0) + 1)
    modelOptions.push({ label: names.get(label) > 1 ? `${label} · ${short}` : label, value: `${model.provider}|${model.id}` })
  }
  if (settings.model !== 'session' && !modelOptions.some((option) => option.value === settings.model)) {
    modelOptions.push({ label: settings.model.replace('|', ' · '), value: settings.model })
  }

  const lengths = [...new Set([10, 14, 18, 24, settings.maxChars])].sort((a, b) => a - b)
  const rate = acceptance(stats)

  const general = [
    {
      type: 'form',
      submit: 'save',
      submitLabel: t('保存', 'Save'),
      children: [
        { type: 'toggle', label: t('回合结束后自动猜', 'Guess after each turn'), bind: 'data.auto' },
        {
          type: 'segmented',
          label: t('一句话长度（字）', 'Answer length'),
          bind: 'data.maxChars',
          options: lengths.map((value) => ({ label: String(value), value: String(value) })),
        },
        { type: 'select', label: t('用哪个模型', 'Model'), bind: 'data.model', options: modelOptions },
        {
          type: 'segmented',
          label: t('候选条数（多则更慢）', 'Candidates'),
          bind: 'data.candidates',
          options: [1, 2, 3].map((value) => ({ label: String(value), value: String(value) })),
        },
      ],
    },
    { type: 'divider' },
    {
      type: 'text',
      tone: 'muted',
      text: t(
        `超时 ${secs(settings.timeoutMs)} · 防抖 ${settings.debounceMs}ms · 输出上限 ${settings.maxTokens} tokens`,
        `Timeout ${secs(settings.timeoutMs)} · debounce ${settings.debounceMs}ms · ${settings.maxTokens} tokens`,
      ),
    },
    { type: 'actions', items: [{ label: t('现在猜一次', 'Guess now'), action: 'guess-now', icon: 'refresh' }] },
  ]

  const debugPage = [
    {
      type: 'keyValue',
      items: [
        [t('上次猜测', 'Last guess'), debug.at === 0 ? t('还没有', 'Not yet') : new Date(debug.at).toLocaleTimeString()],
        [t('模型', 'Model'), debug.model === '' ? '—' : debug.model],
        [t('耗时', 'Took'), debug.ms === 0 ? '—' : secs(debug.ms)],
        [t('结果', 'Result'), debug.error === '' ? (debug.at === 0 ? '—' : t('已生成', 'Generated')) : debug.error],
        [t('展示 / 采用', 'Shown / used'), `${stats.shown} / ${stats.accepted}`],
        [t('忽略 / 重猜', 'Ignored / re-guess'), `${stats.ignored} / ${stats.reguessed}`],
        [t('接受率', 'Acceptance'), rate === null ? '—' : `${Math.round(rate * 100)}%`],
      ],
    },
    { type: 'text', text: t('上次发给模型的上下文', 'Context sent to the model'), style: { weight: 'bold' } },
    {
      type: 'codeBlock',
      code: debug.context === '' ? t('（还没有调用过）', '(no call yet)') : debug.context.slice(0, 4000),
      language: 'text',
    },
    debug.formValue === ''
      ? { type: 'text', tone: 'muted', text: t('上次保存：还没有提交过', 'Last save: none yet') }
      : { type: 'text', tone: 'muted', text: t(`上次保存提交的值：${debug.formValue}`, `Last save payload: ${debug.formValue}`) },
    {
      type: 'actions',
      items: [
        { label: t('清空记录', 'Clear'), action: 'clear-debug', icon: 'clear' },
        { label: t('恢复默认', 'Reset'), action: 'reset', icon: 'refresh' },
      ],
    },
    {
      type: 'text',
      tone: 'muted',
      text: t(
        `范围：字数 ${RANGES.maxChars.min}–${RANGES.maxChars.max} · tokens ${RANGES.maxTokens.min}–${RANGES.maxTokens.max}`,
        `Limits: chars ${RANGES.maxChars.min}–${RANGES.maxChars.max} · tokens ${RANGES.maxTokens.min}–${RANGES.maxTokens.max}`,
      ),
    },
  ]

  return {
    v: 2,
    type: 'tabs',
    items: [
      { label: t('常用', 'General'), children: general },
      { label: t('调试', 'Debug'), children: debugPage },
    ],
  }
}

/**
 * 输入框上方「插件」弹层里的入口：只有一行说明 + 一个按钮，
 * 点了打开和「全部功能」「详情页」同一个设置页，而不是在弹层里内联展开。
 */
export function buildEntryView({ settings, locale }) {
  const en = isEnglish(locale)
  const t = (cn, english) => (en ? english : cn)
  return {
    v: 2,
    type: 'stack',
    children: [
      {
        type: 'text',
        tone: 'muted',
        text: t(
          `自动猜${settings.auto ? '开' : '关'} · ${settings.maxChars} 字 · ${settings.candidates} 候选`,
          `Auto ${settings.auto ? 'on' : 'off'} · ${settings.maxChars} chars · ${settings.candidates} candidates`,
        ),
      },
      { type: 'actions', items: [{ label: t('打开设置', 'Open settings'), action: 'open-settings', icon: 'settings' }] },
    ],
  }
}
