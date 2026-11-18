// 只跑 core.js：不建 ctx、不连引擎、不 import 任何包——
// 电脑端的壳只要 import 这一份，就能拿到同样的状态块和清洗结果。
import assert from 'node:assert/strict'
import {
  buildContext, cleanSuggestion, isIdle, isUserText, readTodos, recentUserTexts, readTouchedFiles, repeatsUser,
} from '../lib/core.js'

const messages = [
  { role: 'user', content: [{ type: 'text', text: '把导出的 pdf 改成一页' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' }] },
  { role: 'tool', toolCallId: 'c1', isError: true, content: [{ type: 'text', text: 'wkhtmltopdf: not found' }] },
  { role: 'assistant', content: [{ type: 'tool-call', id: 'c2', name: 'write', arguments: '{"file_path":"/tmp/work/report.html"}' }] },
  { role: 'user', content: [{ type: 'text', text: '再看看页边距' }] },
  { role: 'assistant', content: [{ type: 'text', text: '边距改成 12mm 了，要顺手把页脚也去掉吗？' }] },
]

const todos = [
  { content: '一页排版', status: 'completed' },
  { content: '页边距', status: 'in_progress' },
]

const context = buildContext(messages, todos, { workspaceRoot: '/tmp/work' })
assert.ok(context.includes('✓ 一页排版'), '带待办')
assert.ok(context.includes('▶ 页边距'), '带进行中')
assert.ok(!context.includes('wkhtmltopdf'), '上一轮的旧报错不该出现')
assert.ok(context.includes('用户最后一条消息'), '带最后一条用户消息')
assert.ok(context.includes('要顺手把页脚也去掉吗？'), '带助手最后一句')

// 本回合有写文件时，才列出改动文件，并且按 workspaceRoot 缩短
const withFile = buildContext(messages, null, { workspaceRoot: '/tmp/work' })
assert.ok(!withFile.includes('改动的文件'), '写入发生在上一条用户消息之前，不算本回合')

const current = [...messages, { role: 'tool', toolCallId: 'c2', isError: true, content: [{ type: 'text', text: 'x' }] }]
// from 是“本回合起点”的索引：写文件那次调用在它之后才算本回合
const files = readTouchedFiles(current, 1, '/tmp/work')
assert.deepEqual(files, ['report.html'], 'file_path 被缩短成工作区相对路径')

assert.equal(cleanSuggestion('“要，顺手去掉。”后面还有话'), '要，顺手去掉')
assert.equal(cleanSuggestion('   '), '')
assert.deepEqual(recentUserTexts(messages, 2), ['再看看页边距', '把导出的pdf改成一页'])

// 去重：原样推回、以及“被截断成前缀”地推回，都算重复；太短的通用词不算
const recent = recentUserTexts(messages, 2)
assert.equal(repeatsUser('再看看页边距', recent), true, '原样推回用户的话算重复')
assert.equal(repeatsUser('把导出的pdf', recent), true, '截断后的前缀也算重复')
assert.equal(repeatsUser('继续', recent), false, '太短的通用词不当重复')
assert.equal(repeatsUser('把页脚去掉', recent), false, '新的一句不算重复')

const session = {
  seq: 4,
  eventAt: (seq) => [
    { type: 'turn/start' },
    { type: 'todo/write', data: { todos } },
    { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ][seq],
}
assert.equal(readTodos({ seq: 2, eventAt: session.eventAt })?.[0]?.content, '一页排版')
assert.equal(readTodos({ seq: 1, eventAt: session.eventAt }), null, 'turn/start 之后没有 todo/write 就是空')
assert.equal(isIdle(session), true)
assert.equal(isIdle({ seq: 1, eventAt: () => ({ type: 'turn/start' }) }), false)

// DSH 会把「时间上下文」（dsh-time-context）作为一条 user 角色的消息插在最后：
// 它不是你打的字，不能占掉“用户最后一条消息”，也不能当成“用户刚说过的话”。
const injected = [
  ...messages,
  {
    role: 'user',
    source: { kind: 'time-context', form: 'snapshot', sections: [{ name: 'time-context', text: 'snapshot' }] },
    content: [{
      type: 'text',
      text: 'Time sampled while preparing turn 2, step 1: 2026-11-18T12:53:09Z[Asia/Shanghai]\n'
        + 'Browser time zone for this request: Asia/Shanghai. Interpret otherwise-unqualified dates and times in this zone.\n'
        + 'Elapsed since the preceding step context: 22h 38m 14s.',
    }],
  },
]
const injectedContext = buildContext(injected, null, { workspaceRoot: '/tmp/work' })
assert.ok(!injectedContext.includes('Time sampled'), '注入的时间上下文不该出现在状态块里')
assert.ok(injectedContext.includes('再看看页边距'), '仍然取到真正的最后一条用户消息')
assert.deepEqual(recentUserTexts(injected, 2), ['再看看页边距', '把导出的pdf改成一页'], '注入的消息不算用户说过的话')
assert.equal(isUserText(injected.at(-1)), false, '注入消息不是用户文本')
assert.equal(isUserText(messages.at(-2)), true, '真实用户消息算用户文本')

console.log('core ok：状态块、文件、清洗、todo、空闲判定、注入上下文过滤都在没有 ctx 的情况下跑通')
