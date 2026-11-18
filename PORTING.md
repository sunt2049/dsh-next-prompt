# 移植记录：手机 → Web / 桌面端

这份文件原本是「挪到电脑上继续做」的交接单。现在已经做完了，留一份现状：

## 现状

一份包、两个壳，`lib/core.js` 一行没重写（只在 `shortPath` 里补了 Windows 分隔符和新增 `repeatsUser`）。

| | 手机（dsh-go） | Web / 桌面端（DSH） |
|---|---|---|
| 入口 | `lib/index.js` → `lib/shell-dsh-go.js` | `lib/index.js` → `lib/desktop/host.js` |
| 判定 | 有 `dshGo` 服务 | 没有 `dshGo` 服务 |
| 界面 | `composer.strip` 三态胶囊 + `panels` | `conversation.composer.dock` 胶囊 + `plugins.detail.section` 设置（插件详情页） |
| 界面代码 | `lib/index.js` / `lib/panel.js`（JSON 视图） | `lib/desktop/client.js`（React） |
| 宿主状态怎么给界面 | `ctx.dshGo.strip(emit)` 直接推 | `/dsh-next-prompt` HTTP 路由，浏览器 `fetch` 拉 |
| 插入不发送 | `{ insert: text }` 回给 App | `inputActions.setDraft / insertText` |
| 设置 | 面板表单（`form` + `bind`） | 插件详情页里的一节，即时保存 |
| 埋点 / 设置文件 | 插件目录的 `stats.json` / `settings.json` | `~/.dsh/dsh-next-prompt/`（`$DSH_PROFILE_DIR` / `$DSH_HOME` 优先） |

## 为什么 Web 端走 HTTP 路由

第三方插件拿不到 Typert 生成产物，所以：

- `@Remote` 方法（`ct.remote.*`）是 `dsh-api-*` 包编译生成的，插件没法加自己的命名空间；
- `ctx.remote.$on` 的事件名单是 `dsh-api-remotes` 里编译期写死的数组；
- session projection 只能是日志派生（建议不在日志里，也不该往日志里塞新事件类型）。

剩下的通道是 `ctx.webServer.register`：同源页面直接 `fetch`，profile 里另外两个第三方插件
（`@sunt2049/dsh-mcp-manager`、`dsh-pet`）也都这么做，所以按同一套来。

## 复用到的约定（两端一致）

- 建议**只在内存**里，不进会话历史；插入永远不自动发送。
- 空态 / 有建议 / 刚插入是三段文案，不把「猜一次」和「填进去」混在同一个动作上。
- 去重两层：和上一句相同（手工重猜时放行）、和用户最近两条消息相同或是其前缀（一律拦）。
- 只对「用户正看着」的会话猜：手机端按订阅算，Web 端按 `/watch` 算；子代理会话都不猜。

## 验证

```sh
node test/core.mjs        # 只跑 core.js：不建 ctx、不连引擎
node test/offline.mjs     # 手机壳：假 ctx + 假 dshGo + 假模型流，两条订阅路径与三态
node test/desktop.mjs     # Web 宿主半：假 ctx + 假 HTTP + 假模型流，全部路由与三态（21 项）
node test/verify-live.mjs # 现场验证：读本机最新会话日志，用 __test 导出跑真实数据（改 ROOT）
```

`verify-live.mjs` 里写死了手机上的路径（`/root/.dsh/sessions/--root-workspace--`），换机器要改 `ROOT`。
