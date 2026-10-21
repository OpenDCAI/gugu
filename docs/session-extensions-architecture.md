# 会话页扩展 tab —— 架构

产品契约见 product spec。这份只讲**结构**:每道防线由谁施加、为什么在那一层。

## 分层

```
renderer                     main                          扩展自己的进程
─────────────────────────    ───────────────────────────   ─────────────────────
installed-extensions-store   extensions-service            <webview>
  ← extensions.list          扫描/安装/卸载/撤销落盘         partition: 每扩展一个
register-extension-tabs      controller (RPC)              gugu-ext://<id>/…
  → tab provider 注册        extension-session             CSP: script-src 'self'
ExtensionsSettingsCard       会话级网络白名单 + CSP + attach 闸
```

**每道防线都在 main。** renderer 只负责画和转达 —— 它自己就是被防的对象之一(扩展跑在
它旁边)。凡「只在 renderer 过滤」的写法都等于没写。

## 四条边界，各自钉在哪

| 边界 | 施加点 | 删掉它会怎样 |
|---|---|---|
| 代码只来自装进来那份 | `extension-protocol.ts` 的 `gugu-ext://` 供给 + 每响应算出的 CSP(`script-src 'self'`、无 `unsafe-eval`) | 扩展可运行时拉码 |
| 网络=声明域名白名单 | `extension-session.ts` 的 `session.webRequest.onBeforeRequest`,未声明 fail-closed | 任意外联 |
| 拿不到宿主 | 独立 `partition` + `will-attach-webview` 准入 + 关掉 `FileSystemAccess` Blink feature | cookie/storage/IPC/文件系统逃逸 |
| 权限可单项收回 | `.revoked-permissions.json` + 撤销后重配会话并重载该扩展的面 | 只能靠卸载收权 |

两处**易被误读**的实现细节，改动前先看：

- **协议按 session 注册,不是全局**。`setupExtensionProtocol(session, () => entry.bundle)` 传的是
  **取值函数**不是快照 —— CSP 与 rootDir 每次响应重算,所以「装/卸/改权限之后立刻生效」不需要重启。
  拆链时必须 `protocol.unhandle`:session 活得比扩展久,`fromPartition` 拿回的是同一个。
- **App 的样子随运行时走,不经注入**。`/_gugu/<ver>/ui.css`(整份在 `@layer gugu`)与 `ui.js`(`<gugu-icon|avatar|time|empty>`)
  由 gugu.js 写进每个 App 页面、排在 App 自己的样式之前(`app-runtime/ui/`)。`--em-*` 调色板与刻度在**构建时**由
  `ui/app-palette.mjs` 从 `tokens.css` 解出深浅两套写进 ui.css,页面按 `<html data-gugu-theme>` 选用,ui.js 跟着
  `context.themeMode` 设它 —— 桌面会话页、群里、手机、`app_check` 同一份。从前读「框所在处」的计算值注进去
  (`extension-theme-css.ts`,已删):桌面上是会话页的值;手机和网页上群 App 在 `GroupAppSlot` 的 iframe 里,只挂
  `.emlight/.emdark`、不在 `.gugu-skin` 下,拿到 session-ui 的原始色板(真 WebView 113 量到主色翡翠绿)。

## 装到用的一条链

1. `extensions.inspect` 读 manifest 并算**原始字节的 sha256**
2. UI 用那份 manifest 组人话权限清单 → 用户确认
3. `extensions.install` 带着同意时的指纹落盘;**改名前在暂存副本上重算一次**,对不上就拒
4. `configureExtensionSession` 起 partition/白名单/协议;`registerInstalledExtensionTabs` 注册 tab 类型
5. 卸载 = 撤 provider + 删 bundle + 清撤销记录;**已开的 tab 原地降级为占位,不丢**

指纹那一步是「同意的与装进去的对上账」——中间换目录内容会被挡下。

## 刻意没做的

- **VSCode API 兼容**、动 `gugu-plugin`:红线。
- **降版拦截**。产品规格没定,发明策略等于替维护者拍板;改为在确认框里说清是往回退。

## 判据落在哪

- 沙箱边界:原 `e2e/electron/extension-sandbox-2374.spec.ts`(14 条恶意样张,真 Electron)已随 #6270 删除
- 白名单正反两面:`extension-session.test.ts` —— **这里才是白名单的真判据**;e2e 里那三条打的是
  `.test` 域名(RFC 2606 永不解析),DNS 失败与被拦截同形,删掉拦截也照样绿
- 桥:动词、各要哪个能力、要不要手势只在 `bridge-protocol.ts` 的 `BRIDGE_VERBS`;给作者的说明是产品内 guide(`authoring-guide.ts`),
  `tests/unit/desktop/mcp/guguGuide6614.test.ts` 核两者对得上
- 管理面:`extensions-folder-install.test.ts`(原 `extension-permissions-2374.spec.ts` 已随 #6270 删除)
- 样子 / 权限清单 / 升版:`app-runtime/ui/app-palette.test.ts`、浏览器里的 `app-ui-look.test.ts`、`extension-consent.test.ts`、
  `extension-install-consent.test.ts`、`consent-in-session.test.ts`、`shared/extensions/upgrade.test.ts`
