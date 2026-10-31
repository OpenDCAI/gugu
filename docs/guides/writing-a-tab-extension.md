# 写一个 App(原「写一个 tab 扩展」)

> 界面上叫 App;仓库与代码里仍叫 extension。

怎么写,只看产品内 guide:`apps/desktop/src/session/shared/extensions/authoring-guide.ts`(咕咕里的 agent 用 `guide_read`,
从 `apps` 那篇开始)。它有测试对着代码核,这里不再另写一份,写了就会漂。

- 能跑的样例:`examples/extensions/`(写法示例,不随包发)。
- 不起咕咕就校验清单、安装范围和授权要求：见产品内 authoring guide 与 [App 的接口](tab-extension-api.md)，不要求读取内部开发插件。
- 产品契约 product spec;接口原文在哪见 [App 的接口](tab-extension-api.md);上架见 [发布到市场](publishing-an-extension.md)。
