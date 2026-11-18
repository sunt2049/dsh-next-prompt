# 猜下一句（@sunt2049/dsh-next-prompt）

回合结束后，猜一句「你接下来会说的话」：

- **Web / 桌面端**：显示为输入框**下方**的一枚胶囊，点一下填进输入框（**不发送**）。
- **手机端（dsh-go）**：显示为输入框**上方**的胶囊，三态与电脑端一致。

一份包、两个壳，逻辑只在 `lib/core.js` 里写一遍。

## 分层

```
lib/core.js           纯函数、零依赖：buildContext / readTodos / readTouchedFiles / cleanSuggestion / repeatsUser / isIdle / recentUserTexts
lib/settings.js       默认值、范围夹取、settings.json 原子读写、表单提交解析
lib/stats.js          埋点：展示 / 采用 / 忽略 / 重猜，stats.json，接受率
lib/index.js          入口：有 dshGo 服务走手机壳，否则走 Web/桌面端
lib/shell-dsh-go.js   手机壳：composer.strip 三态 + 两个面板（dsh-go 专有插槽）
lib/panel.js          手机端设置面板视图（v2）
lib/desktop/host.js   Web 宿主半：回合结束生成 + /dsh-next-prompt 路由
lib/desktop/client.js 浏览器半：胶囊 + 设置页（React，经模块表 require('react')）
```

## Web / 桌面端

### 胶囊（输入框下方 · `conversation.composer.dock`）

| 状态 | 文案 | 点一下 |
|---|---|---|
| 没有建议 | 猜下一句 | 立刻现猜 |
| 有建议 | 那句话（默认 ≤14 字） | 填进输入框（已有草稿时插在光标处，不覆盖） |
| 刚插入过 | 再猜一次 | 换一句 |

有建议时右侧有一个 ✕：收起这一句（记一笔「忽略」）。回合一开始，旧建议立刻消失。

空对话（还没说过话）不显示胶囊；没打开对话时什么都不做。

### 设置（插件详情页 · `plugins.detail.section`）

入口：**插件 → 已装 → @sunt2049/dsh-next-prompt → 详情**，页面最下面一节「猜下一句」。
（和 `@sunt2049/dsh-mcp-manager`、`dsh-context` 一样，不占「设置」里的导航项——
这个插件没有独立偏好入口，跟着插件本身走更好找。想同时放进 设置 里，注册 `settings.section` 即可。）

- 回合结束后自动猜（开关）
- 一句话多长：10 / 14 / 18 / 24
- 候选条数：1 / 2 / 3（多则更慢，取最具体的一条）
- 用哪个模型：跟随会话（默认）或固定某个 provider/model
- 现在猜一次 / 恢复默认
- 折叠的「调试」：上次调用（时间/模型/耗时/结果）、**上次没猜的原因**（回合还在跑 / 没有可预测的内容 / 没拿到模型路由 …）、
  展示/采用、忽略/重猜、接受率、**上次发给模型的上下文原文**、清空记录

改动即时落盘（不用点保存），失败时页面上会显示宿主返回的原因。

### 数据怎么在两端之间走

浏览器半不能自己调模型，宿主半也不能直接画页面，所以：

```
回合结束 ──防抖──▶ host.js 拼状态块 ──▶ llm.prepareCall（当前会话模型、最低推理强度）
   │                                          │
   │                                    text-delta 累加
   ▼                                          ▼
client.js 轮询 /state ◀── 内存里的一句话 ◀── core.cleanSuggestion
   │
   └─ 点胶囊 ──▶ inputActions.setDraft / insertText（不发送）
```

宿主半用 `ctx.webServer.register({ kind: 'prefix', path: '/dsh-next-prompt' })` 注册同源路由，
浏览器半用 `fetch` 调它（第三方插件拿不到 Typert 生成产物，这条路是插件能用的）：

| 路由 | 作用 |
|---|---|
| `GET /state?session=` | 当前状态：`ready / text / pending / again` |
| `POST /watch?session=` `POST /unwatch?session=` | 登记「正在看这个会话」；只有登记过的会话才会自动猜 |
| `POST /guess?session=` | 现猜一次（生成完才回包） |
| `POST /accept?session=` `POST /dismiss?session=` | 采用 / 收起，并埋点 |
| `GET /settings` `POST /settings` `/reset` `/clear` | 设置读写、恢复默认、清空埋点与调试 |

写操作要求同源（`Origin` 与 `Host` 一致，没有 `Origin` 的本机调用放行），跨站页面会被 403 拒绝。

运行时数据（`settings.json` / `stats.json`）不写进插件源码目录（这个包是 `link:` 进 profile 的，写进去会把工作区弄脏），
按顺序找第一个可用的位置：`$DSH_PROFILE_DIR/dsh-next-prompt/` → `$DSH_HOME/dsh-next-prompt/` → `~/.dsh/dsh-next-prompt/`。
宿主进程里通常没有 `DSH_PROFILE_DIR`，所以实际落点是 `~/.dsh/dsh-next-prompt/`。手机端仍写在插件目录（那本来就是它的运行目录）。

## 手机端（dsh-go）

命令：`composer.strip` 的三态胶囊 + `panels`（`settings` 挂 `session.tab`/`features`，`entry` 挂 `chat.panel`）。

- 手机端面板是 JSON 视图，改用 `form` + `bind`（`data.auto` / `data.maxChars` / `data.model`）：
  `toggle` / `segmented` / `select` 才紧凑，`options` 会渲染成一列又高又空。
- 提交值形状协议没写死，`settings.js` 的 `patchFromForm` 三种形状都认；实测 App 送来
  `{"values":{"data.auto":true,"data.maxChars":"24","data.model":"session"}}`。
- 存完必须把新值推回 panel data，否则表单还绑在旧数据上，看起来像「没保存」。

## 怎么工作

```
turn/end(completed) ──1.2s──▶ 拼状态块 ──▶ 旁路小请求(当前会话的 provider/model，最低推理强度)
                                 │                          │
                                 │  · 本回合待办(todo/write)
                                 │  · 本回合最后一次工具报错(含工具名)
                                 │  · 本回合被 write/edit 改过的文件(≤6，相对工作目录)
                                 │  · 用户最后一条消息
                                 │  · 助手最后一条回复
                                 ▼                          ▼
                          胶囊 ◀── 清洗成一句话(≤14 字) ◀────┘
```

- 触发：`ctx.on('session/event')` 看到 `turn/end` 且 `reason.kind === 'completed'`；`turn/start` 时立刻收起旧建议。
- 上下文：**不给整段对话**，只给五块状态；文本每块截断 300 字。旧报错（上一条用户消息之前的）不算。
  文件路径按会话的工作目录（`ctx.workingDirectory`，退回 `header.cwd`）缩成相对路径。
- **跳过 DSH 注入的上下文消息**：`dsh-time-context` 会在每一步往请求里追加一条 `user` 角色的消息
  （`Time sampled while preparing turn …` / 时区 / 距上一条消息多久），`model-selection`、`tool-registry` 之类也一样。
  它们不是你打的字，所以「用户最后一条消息」只认 `source.kind === 'user'` 的消息（DSH 自己的 Chat 也用这个字段区分，
  见 `dsh-client-ui-chat` 的 `message.ts`）；否则那块会变成三行时间戳，真正的最后一句话被挤掉。
- 调用：`llm.prepareCall({provider, model, maxTokens: 96}, signal, configure)`，`configure` 挑该模型最低的推理强度；
  15 秒超时，下一条消息开始时 abort。
- 输出：`text-delta` 累加 → 去引号/编号 → 只留第一句 → 超过设置长度截断（提示词里要求 ≤10 字）。
- 去重：和上一句相同（手工重猜时放行）不显示；与用户最近两条消息归一化后相同——或**是其中某句的前缀**（≥6 字）——也不显示，
  避免把人家刚说过的话推回去。
- **多候选**：候选条数 2/3 时一次要多行，`core.pickBest` 按规则打分挑最具体的（英文/数字/文件名 +2，通用词「继续」「好」−3）。
- **埋点**：展示 / 采用 / 忽略 / 重猜各记一笔，存在 `stats.json`；接受率 = 采用 ÷（采用 + 忽略）。
- **子代理会话不猜**（`header.origin === 'subagent'`）；Web 端只对浏览器正在看的会话自动猜。

## 文件

| 文件 | 作用 |
|---|---|
| `package.json` | 一份清单两套宿主：`dsh`（bundle + client）+ `dshGo` |
| `cordis.patch.yml` | 插件在 profile 里的加载条目 |
| `locale/{zh,en}.json` | 插件管理页的标题 / 说明 / 详情页 |
| `icon.svg`、`docs/` | 插件图标与详情页配图 |
| `lib/…` | 见上面的「分层」 |
| `test/core.mjs` | 只跑 `core.js`：`node test/core.mjs` |
| `test/offline.mjs` | 手机壳回归：假 ctx + 假 dshGo + 假模型流 |
| `test/desktop.mjs` | Web 宿主半回归：假 ctx + 假 HTTP + 假模型流，覆盖全部路由与三态 |
| `test/verify-live.mjs` | 现场验证：读本机最新会话日志，用 `__test` 拼一遍真实上下文（改 `ROOT`） |

## 安装 / 改代码

Web / 桌面端（在 DSH 里）：**插件** → **添加插件** → 选这个目录（等价于 `plugin_manager install_bundle`）。
发布到 npm 后也可以按包名安装：`plugin_manager install_bundle` 的 target 填 `@sunt2049/dsh-next-prompt`（插件页里同样可以直接填这个包名）。
改完 `lib/desktop/*` 需要让插件行重启一次（`plugin_manager set_plugin` 关再开，或重启 DSH）——
只改 `settings.json` / `stats.json` 是热生效的（`~/.dsh/dsh-next-prompt/` 下）。

手机端（dsh-go）：`dsh plugin --profile web add <目录>`（发布后可以直接写 `@sunt2049/dsh-next-prompt`），改完 `lib/` 后在 App「引擎」页重启引擎。

跑测试：

```sh
node test/core.mjs
node test/offline.mjs
node test/desktop.mjs
```

## 已知边界

- 每回合结束最多多一次模型调用；只看本回合状态，更早的意图会丢（有意的取舍）。
- 报错只看本回合最后一条；todo 只看最后一次 `todo/write`，最多列 10 条。
- 注入的上下文消息（时间上下文、模型选择、工具清单等）不算「用户说过的话」：不占状态块，也不参与去重。
- 建议只存在宿主内存里（重启即丢），不进会话历史；同一句不重复显示。
- 浏览器半每 700ms 轮询一次 `/state`，只在回合刚结束的几秒内（最多约 13 秒，盖住宿主 15 秒超时），不是常驻轮询。
- 路由是插件自己注册的同源 HTTP 端点：本机任何进程都能读它（内容就是一句建议），写操作有同源检查。GET /settings 也走这条通道。
- 不做去重之外的打分，也没有从接受率学习；这些可以继续加。

## 已验证 / 未验证

离线（无需引擎、无需浏览器）：

```sh
node test/core.mjs        # 纯逻辑
node test/offline.mjs     # 手机壳：三态、去重、面板、埋点
node test/desktop.mjs     # Web 宿主半：22 项，全部路由 + 三态 + 同源检查（数据写临时目录，跑完删掉）
```

装到本机 desktop profile 后确认过：

- 包已链接进 profile（`link:D:/dsh-next-prompt`），bundle 在 `dsh.profile.bundles` 里，重启也在；
- 插件行激活成功（`application: applied`），插件管理页显示的是 `locale/zh.json` 里的标题、说明与详情图；
- 宿主路由可用：`GET /state`（带 `limitMs`）、`/settings`（模型目录就是这台机器的四张牌）都返回 200；
  同源写操作 200、跨站 `Origin` 403；
- 数据落在 `~/.dsh/dsh-next-prompt/`，插件源码目录保持干净；
- 客户端两个槽位真的注册进了页面（Slots inspect：registrant `dsh-next-prompt`（插件行 id），`next-prompt` 两处 active：
  `conversation.composer.dock` 的胶囊、`plugins.detail.section` 的设置节）。

**作者本人在 GUI 里确认（2026-11-17）**：胶囊渲染、点胶囊填入、插件详情页里的设置一节都正常。
渲染这一层只能这样验收——DSH 的验证规则不允许另开浏览器或去找 GUI 的启动 token。
