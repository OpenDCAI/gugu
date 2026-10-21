# App 的接口(原「tab 扩展的暴露面」)

> 界面上叫 App;仓库与代码里仍叫 extension。

这里不再抄一份接口表。动词、能力词、清单字段、程序写法、页面生命周期只有一个原文:

- **产品内 guide**:`apps/desktop/src/session/shared/extensions/authoring-guide.ts`。咕咕里的 agent 用 `guide_read`
  读到的就是它,分 `apps`、`apps-ui`、`apps-page`、`apps-agents`、`apps-programs`、`apps-files`、`apps-editors`、`apps-together` 八篇。
  `tests/unit/desktop/mcp/guguGuide6614.test.ts` 逐个核对它与代码:每个动词、每个能力词、每个 `app_*` 工具。
- 清单能写什么、上限多少:`apps/desktop/src/session/shared/extensions/manifest.ts` 的 zod schema。
- 动词各要哪个能力、要不要手势:`apps/desktop/src/session/shared/extensions/bridge-protocol.ts` 的 `BRIDGE_VERBS`。

产品契约见 product spec;结构与防线见 [架构](./session-extensions-architecture.md);
上架见 [发布到市场](./publishing-an-extension.md)。
