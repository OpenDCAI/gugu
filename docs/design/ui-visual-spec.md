# 咕咕视觉规格

> **2026-10-17 用户裁决(#7333):以 Codex 桌面版为咕咕的视觉母版,全部组件适配。**
> 下面「§0.0 当前取值」是现行值;本文其余各节凡与它冲突的(Sora、11/13/15/17/20 字阶、`--tint` 冷色中性、
> 选中属 live、一档 lift、浮层无轮廓、全局无焦点环)都**已被 #7333 覆盖**,原文留作来历,读的时候以 §0.0 为准。
> 产品功能、状态语义、快捷键、聊天滚动、可访问性与用户手动布局不因换母版改变。
>
> **2026-09-22 维护者裁决(已被上一条在冲突处覆盖):assistant-ui 的 `design.md` 是咕咕的设计尺子。**
> 出处:assistant-ui 仓的 `design.md`(审计与逐条对照见 #6103,token 层落地见 #6104)。
> 凡本文旧读数与它冲突,一律以 design.md 为准;旧读数**不删**,原地标注「已被 design.md 裁决覆盖」
> 并写清差在哪 —— 删掉的话下一个人无从判断「现在这样是裁决出来的,还是本来就没做」。
>
> 落地分三阶段:**#6104 token 定义层**(token 值、直接消费 token 的 CSS、本规格、机器判据)→
> **#6105–#6109 五区组件层**(TSX 消费点,按 A/B/C/D/E 五份清单共 114 条)→
> **#6103 收口**(跨区遗留、浮层档位对齐、本规格核销)。
> ⚠️ 本文凡写「归第二阶段」的条目,是 #6104 当时的快照措辞;当前状态以 §0.1 的裁决与 §10 的判据表为准。
>
> 状态：**已裁决**。Refs #3334、#6103、#6104、#6105–#6109。
> 本文记录实测事实、当前取值、机器判据与具名缺口。没有读数支撑的部分必须保留数字或票号，
> 不能用一条看起来确定的规则盖住不确定。
>
> 适用范围：咕咕主 renderer（`apps/desktop/src`）与会话页 renderer（`apps/desktop/src/session/renderer`）。
> transcript 引擎（`packages/session-chat-ui`）只消费本规格，不由本文定义其内部几何。

---

## 0.0 当前取值(#7333,2026-10-17)

定义处只有 `apps/desktop/src/styles/tokens.css`;会话页 `@theme`、`tailwind.config.cjs`、`packages/session-ui` 是逐字等值的副本,
`scripts/checks/check-ui-visual-spec.mts` 钉圆角三表对拍与字阶。

| 角色 | 值 | 范围 |
|---|---|---|
| 字体 | 系统字体:`-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', sans-serif` | 中文落各平台原生中文字体;等宽栈不变 |
| 标注 `--font-caption` | 12/18 | 时间、计数、辅助说明、设置行描述 |
| 紧凑界面 `--font-body` | 14/20 | 导航、菜单、设置行标题、工具条、列表;**不给长段正文** |
| 消息与长段正文 `--font-prose` | 16/24 | IM 人聊 / IM agent 的气泡正文、长段回复与文档 |
| 面板标题 `--font-title` | 16/24 半粗 | PaneHeader、对话框标题 |
| 设置导航与页头 | 桌面菜单32高、14/20常规字重,当前项中等字重与共享选中层;账号条头像32、名称14/20、号码12/18 | 保留原分组与可见性,正常760高弹窗可见完整桌面清单;短窗仍滚动。键盘可聚焦、Enter/Space切页,当前页用aria-current标明。手机保留44以上入口行 |
| 桌面内容外框 | 上/右/下内缩 5、表面圆角 12、单层轻轮廓 | Mac 浅色 native 模式按维护者 2026-10-21 裁决(#7610):外框从最左图标栏右侧开始,包住中间列表和右侧工作区,外层圆角随之左移;正文不再单独画第二层外框。项目、对话、联系人及无侧栏整页共用;设置弹窗及手机布局不套此框。未设栏宽时同取240,已保存的拖动栏宽优先 |
| 设置内页标题与内容 | 20/28半粗,与640上限的阅读列共用左缘;用量/活跃图表列上限760 | 桌面标题下直接接说明与正文,关闭入口仍在弹窗边缘。普通偏好用开放分组,概览才使用表面,跳转入口有独立行形态,表单标签与控件相邻,危险操作放在编辑/保存之后。手机保留原PaneHeader、入口行与卡片边界 |
| 页内标题 `--font-heading` | 20/28 半粗 | |
| 页级标题 `gg-type-page-title` | 24/32 | 一页一个 |
| 间距 | 4px 基准,常用 4/8/12/16/20/24 | |
| 控件高 | 28 / 32 / 36 / 40,触控 44 | |
| 圆角 | xs 4 · document 6 · control 8 · surface 12(菜单、分组卡)· xl 12 · dialog 16(较大 Sheet/Dialog 外壳)· bubble 20(IM 气泡)· thread 24(composer)· capsule | 导航行(侧栏、设置左栏)用胶囊(`ListRow variant="nav"`),联系人/成员行不泛化 |
| 中性色 | 亮:内容 #fff、底层 #f9f9f9、填充 #ededed、前景 #1a1c1f;暗:内容 #181818、底层 #121212、局部表面 #212121、前景 #dfdfdf | 表面纯灰;前景本身略带色,由它派生的次级文字也带一点 |
| 边界 | 亮 8% / 12%,暗 8% / 16%(前景混色) | |
| 状态 | 悬浮 4% · 按下 6% · 选中 7.5%(前景混色) | 选中是中性层;live 蓝只给运行/连接/链接这类真实语义 |
| 投影 | `--shadow-lift` 菜单/popover/tooltip/toast;`--shadow-dialog` Sheet/Dialog 外壳;`--shadow-composer` 其他主输入入口 | 使用投影的入口不另叠 border;会话页及新建会话输入框只留一条轻边框,无外投影(维护者 2026-10-19,#7528);非浮层不给阴影 |
| 动效 | 150 / 200 / 300ms 三档 | 用途见 product spec |
| 焦点 | 键盘 `:focus-visible` 画 2px live 色环(外偏 2px);鼠标点击不留环;文字输入以光标为指示 | 取代 §8 条 6 的「全局 outline:none 是待偿债务」 |
| 窗口材质 | `<html data-window-material>` 由主进程按系统信号写:只有 mac 主窗、系统没开「减弱透明度」「增强对比度」时是 native | 最左图标栏保留系统材质(不透明窗口是 --muted 实色);桌面主窗浅色模式(不分材质,Windows / Linux 同 Mac)的中间列表、右侧文件导航、页签底条和正文上下留边共用同一份接近白色的 C 档背景(维护者 2026-10-20 选色、10-21 明确整块关系,#7610),不能只给列表单独铺色。正文和文档阅读面保持白色;暗色保留原材质关系 |
| 列表附属图形(2026-10-19,#7528) | 中性附属标签和群成员角色默认透明无边框,联系人状态文字/色点不套底板;群成员组合头像、群/联系人资料头像外壳、成员叠放头像无底板/白圈;引擎角标、联系人与导航状态点、助手角标、形象页兄弟头像不套底圈;模板角色、联系人查号与空状态图标不垫实色;任务行尾图标及操作区透明 | 上传的头像图片保持原样;状态色、计数、行的选中/悬浮层和键盘焦点环保留;输入控件、菜单浮层和二维码的背景由各自功能决定 |
| 会话页工作区表面 | 桌面主窗浅色模式的圆角和轻轮廓归整个列表+工作区,白色阅读面在其中保留上下/右侧 5px 的共同背景 | 中间列表、右侧文件导航、页签底条与阅读面上下边缘颜色连续;固定窗口动作与局部标题消费同一内缩。侧栏保留用户宽度。原生画面对照验收与 token/契约检查分开记录 |

**旧字阶的写死字号**(11/13/15/17)按范围记账、只减不增(`offLadderFontSizeLiterals`,baseline 见
`scripts/checks/ui-visual-spec-baseline.json`)。守卫通过 ≠ 全部组件已适配:记账里剩下的每一处都还是旧字号,清单与进度见 #7333。

### 0.3 手机全页统一（2026-10-26 用户裁决，取代 10-21 与 10-22 两条；#446）

- **底栏**：悬浮的玻璃胶囊，两格「消息 · 伙伴」（图标 + 字，选中格里衬一块浅色胶囊），右边另一颗圆形搜索钮，搜当前这一页；列表页头不再放搜索（owner 10-26 选 iOS 26 那种浮动胶囊 + 独立搜索钮，「挪下来」）。
- **层级**：底栏只在列表首页，固定不收放；干活的页 —— 对话、项目群、任务、咕咕、设置详情 —— 一律整屏推进来、不带底栏，返回一步回到有底栏的那层（微信、豆包、iOS `hidesBottomBarWhenPushed` 的做法）。❌ 底栏或页头随滚动、聚焦、打字收放；列表页上键盘弹起时底栏由键盘盖住。
- **入口**：咕咕不单占一格，是「消息」置顶的第一行，点开整屏进助理；「我的」从「消息」「伙伴」页头左上角自己的头像进。「伙伴」= 项目 + 朋友（人和别人的 Agent），普通群只在「消息」；项目按文件夹列（只写名字、顺序固定），点开是项目通讯录；项目群页一排页签：第一枚是群聊本身，后面都是话题 —— 每派一件任务就从它的任务卡开一个话题（owner 10-26：「项目群的分 tab 也是 topic」）。
- **全线一个底**：消息、伙伴、推进来的每一页默认用手机咕咕页那套渐变底（`--ta-panel-bg`），底栏、搜索框是透出底色的玻璃（owner 10-26：「中间这页用的是彩边,其他页都是白边……不统一」）。
- **可选素白主题（2026-10-28）**：「通用 → 主题」在浅色、深色、跟随系统之外增加「素白」，手机与电脑共用这项偏好。选中后按浅色显示，手机整屏所有页面、咕咕页及桌面咕咕面板采用纯白底（`--ta-panel-bg` / `--ta-app-bg`），玻璃与色调叠层采用中性色；刷新和重启后保留。它沿用本节的气泡、间距、底栏形状与触控尺寸，只替换颜色；原白色的对方气泡采用现有浅灰填充，与白色页面保持可辨的轮廓。默认仍为现有浅色渐变；深色及跟随系统的行为不变。
- **对话页**：页头一行、浮在消息上，消息铺到页头底下淡出；输入框浮在消息上、没有底色带，框本身 24px 圆角柔和填充。所有对话页照手机咕咕页：玻璃气泡，用户和对方的话都在气泡里；过程折叠但不隐藏实际审批和错误；助理页输入框上方不显示「运行中」。
- **几何**：间距只用 4/8/16/24 —— 页边距 16，列表行内距 8、头像到文字 16，气泡 8×16；嵌套圆角外 = 内 + 内距（卡片内距 16、外圆角 24 = 里面按钮 8 + 16）；状态色（运行中、等你、未读）不降饱和，它们只出现在小点和角标上。手机正文 16/24、页标题 24/32；控件触控目标至少 44px；其余几何消费咕咕母版 token。
- **底部抽屉（Sheet）不是禁用，旧样子才是**：长按消息、短选项优先贴着触发点弹菜单，长内容推进整页；要用抽屉时外观跟手机新底走（玻璃、24 圆角、4/8/16/24 间距），❌ 旧版那种白底抽屉（owner 10-25「我不要 drawer 组件」，10-26 补充：「其实也可以有抽屉,但是之前的抽屉确实不好看……这个规则不绝对」）。
- 权限、资料和设置采用开放分组与短状态行；去除表格感分隔、卡片套卡片（10-21 起，沿用）。参考 [豆包手机助手](https://o.doubao.com/) 与 [Codex](https://openai.com/index/introducing-the-codex-app/) 的连续对话、独立任务和过程阅读方向。
- 以真实 Android 键盘、返回、授权与撤权验证交互。此范围只管手机，桌面保持现有规则。

## 0. 一句话

一份规格、多处消费。任何「这个界面自己定一套」的写法都是债，不是灵活性。

### 0.1 维护者 2026-09-22 的七条裁决，条文落在哪

design.md 是尺子,但尺子不回答「咕咕这一处算不算例外」。下面七条是维护者当天对具体争点的拍板,
**条文写在各自的章节里**,这张表只负责让人找得到、也看得出哪几条是**对 design.md 的有界例外**:

| # | 裁决 | 性质 | 条文 |
|---|---|---|---|
| 1 | assistant-ui 的 `design.md` 是咕咕的设计尺子 | 总则 | 本文顶部 |
| 2 | 链接保持蓝 —— `--live` 是 live 的唯一色,但链接是例外 | **有界例外** | §6.4 ③ |
| 3 | 遮罩与投影同类:明暗两侧都用中性黑,只改不透明度 | 补充规则 | §6.5 |
| 4 | 发送 / 停止 / 滚到底这类圆形图标钮保持 `--radius-capsule` | **有界例外** | §5.4 |
| 5 | 常驻导航的选中项不用 live 蓝 | 补充规则 | §6.4 ③ |
| 6 | 会话页侧栏浮出态 = 浮层:去边线,留一档 lift | 补充规则 | §6.3 |
| 7 | 焦点可供性:局部恢复 outline 是对的,全局 `outline:none` 是待偿债务 | **推翻旧裁决** | §8 条 6 |

❌ 别把这张表当条文用 —— 它没有「为什么」也没有判据,照它改会把例外的**边界**丢掉,
而这七条里有三条的全部价值就在边界上(例外一旦无界,就是又一套自己定的规矩)。

### 0.2 通用对话的原生参考（维护者 2026-10-17，Refs #7324）

用户后续要求通用对话的外观与交互对齐其展示的原生聊天 App，产品预期见
session-page。
这一范围的正文与输入框改用系统字体，用户气泡用前景/背景反色，气泡与输入框采用 24px 圆角，
输入框带轻投影。它覆盖本文此前对这几个部件的 Sora、16px 圆角与无投影规定。
字体必须同时进入 transcript 的测量配置与实际渲染；不得只改 CSS。
这些值由通用对话的局部样式承载，全局 token 表与其他界面继续遵守原规格。

2026-10-17 全产品刷新图标调整（Refs #7330）：重新加载采用不带外圈的开放圆弧箭头，
刷新控件不旋转来表达加载。原先 `Loader2` 与刷新共用了带外圈双箭头字形；产品消费者现改用
共享的 `LoadingIndicator`。旧 loader 图标名仅保留为静态省略号兼容别名，不再作为加载态使用。
加载组件、动效素材与 CSS 下沉到共享 UI 包，桌面入口保留转发；Android 启动动效仍从同一素材生成。

---

## 1. 字体

### 1.1 事实（实测，非推断）

三个面的**运行时**正文拉丁栈：

| 面 | 运行时栈 | 来源 |
|---|---|---|
| 咕咕主 renderer | `'Sora', -apple-system, 'PingFang SC', 'Helvetica Neue', sans-serif` | `styles/tokens.css:125` → `body` |
| transcript | **逐字节相同** | `lib/chat/font-stack.ts` → `SESSION_CHAT_CONFIG` → `createChatContext` |
| 会话页非 transcript | **逐字节相同** | `session/renderer/index.css` 的 `@theme --font-sans` → `--font-family-system` |

⇒ 三个面现已收敛到同一份正文拉丁栈；会话页非 transcript chrome 是 P0 前唯一的异类。

> ⚠️ 一条已被证伪的说法，记在这里避免复发：`packages/session-chat-ui/src/core/config.ts` 的
> `DEFAULT_CONFIG.fonts.sans = ['Inter Variable', …]` **不是产品的 transcript 字体**。
> 产品里没有任何消费者走到它——宿主在 `createChatContext({ config: SESSION_CHAT_CONFIG })` 处注入了自己的栈。
> 一个名叫 `DEFAULT_` 的常量，默认路径可能永远到不了它。

Sora 的角色也有硬读数：`styles/sora.css` 的 `unicode-range` **零个 CJK 区段**，
`tokens.css:123` 的注释本来就写着它「做拉丁字形」。⇒ **中文从来不由 Sora 承担**，
三个面的中文都落在 `PingFang SC` 上。所以「三套字体」是个**拉丁问题**。

### 1.2 取值(已被 §0.0 覆盖:#7333 起正文是系统字体)

| 角色 | 值 | 理由 |
|---|---|---|
| 正文拉丁 | `Sora` | 维护者已定的品牌字体；实测它本来就跑在正文位上（主 renderer + transcript），不是标题专用 |
| CJK | `PingFang SC` | **显式写进每一条栈**，不靠平台隐式回落 |
| 等宽 | `'JetBrains Mono Variable', 'JetBrains Mono', 'Menlo', 'Monaco', monospace` | 代码、路径、终端、diff |

规格来源只有两处变量，都在 `styles/tokens.css`：

```css
--font-family-system: 'Sora', -apple-system, 'PingFang SC', 'Helvetica Neue', sans-serif;
--font-family-mono:   'JetBrains Mono Variable', 'JetBrains Mono', 'Menlo', 'Monaco', monospace;
```

三处消费：① 主 renderer 的 `body`；② 会话页 `@theme --font-sans/--font-mono`；
③ transcript 的 `SESSION_CHAT_FONT_STACK`（`lib/chat/font-stack.ts`）。

**③ 只能是字面值，不能写 `var()`** —— 字体是 transcript 的**测量输入**，engine 用字体简写
（`600 14px/20px <family>`）在离屏 canvas 上量字形宽度，那条路径拿不到 CSS 自定义属性。
CSS 与它不一致的后果不是「有点不好看」，是离屏量的字形和浏览器画的不是同一张脸，
**换行位置与行高整体错位，而页面看上去仍然正常**。
①②③ 必须逐字一致。

### 1.2.1 三面（2026-09-22 裁决，Refs #6104）

design.md:「**Three faces**, assigned by meaning rather than by size」——
Display(`--font-display`)是页面自己的声音(h1/h2/h3 与页面围绕的大数字),
Sans(`--font-sans`)是阅读正文,Mono(`--font-mono`)只有一个职责:**你要敲的或要装的东西**。

咕咕立的是**角色**,不是第二支字体:三个名字都登记在 `tokens.css` 顶部的 `@theme` 里,
而 `--font-display` 与 `--font-sans` **同脸**(都是 Sora)。理由是 §1.2 的实测读数
——「标题与正文本来就共用同一支 Sora」是当前产品的事实,而维护者已定的品牌脸只有这一支。
⇒ 哪天品牌给出第二支标题脸,只改 `--font-display` 这一行,全部标题跟着走;
❌ 别把它当「更大的字号」用(字号由角色 token 出,见 §2)。
⚠️ Sora 不含中文(§1.1 的 `unicode-range` 读数),所以三面在中文侧本来就同脸,差异只在拉丁字形。
⚠️ 写在 `@theme` 里才生成 `font-display` / `font-sans` / `font-mono` 三个 utility;
写在下面的 `:root` 段里只覆盖值、不生成类(Tailwind v4 对 `@theme` 里没有的 key 是**静默丢整条 utility**)。
副作用(是想要的):主 app 的 `font-sans` / `font-mono` 从前解析成 Tailwind 默认栈,现在与产品同栈,
与会话页那张表的口径一致了。

### 1.2.2 两个包的默认 sans 不再靠桥兜底（Refs #6104）

§1.1 那条「`DEFAULT_CONFIG.fonts.sans = ['Inter Variable', …]` 不是产品的 transcript 字体」**仍然成立**
—— 产品路径确实到不了它。但它是**包的默认值**:storybook / 组件测试 / 任何直接用这两个包的场合
看到的就是 Inter,即「单源只在被宿主桥接后才成立」。本轮把两处默认值改成与宿主同一支栈:

| 位置 | 改前 | 改后 |
|---|---|---|
| `packages/session-ui/src/theme/tokens.css.ts` 的 `tokenVars.fontSans` | `'Inter Variable', sans-serif` | 与 `--font-family-system` 逐字相同的字面栈 |
| `packages/session-chat-ui/src/core/config.ts` 的 `DEFAULT_CONFIG.fonts.sans` | `['Inter Variable', 'sans-serif']` | 同上(**必须字面值**:它是 transcript 的测量输入) |
| `packages/session-chat-ui/src/chat-fonts.css` | `@import '@fontsource-variable/inter/index.css'` | 删 —— Inter 不再出现在任何一条栈里 |

`chat-view.contract.test.tsx` 两条断言跟着改到新栈(它们钉的就是这个默认值)。
脱开宿主时这条栈回落到系统 sans,这是**要的结果** —— 包不该自己塞一张和产品不一样的脸。

### 1.3 当前裁决与已知缺口

- **已知缺口（Refs #3334）**：CJK 回落链的**跨平台运行时解析**只在 macOS 上验过。Windows（Segoe UI / 微软雅黑）与
  Android Capacitor 壳（Roboto / Noto Sans CJK）上的实际落点**未测**。
  当前判据钉的是**声明**（三条栈都显式含 `PingFang SC`），不是「在某台机器上看着一样」——
  后两者同形，不能互相冒充。
- **保留 Sora，不整体退役换 Inter。** 当前没有产品读数支持换脸，16 张 before 截图也没有一张指向字体可读性。
  更换 transcript 字体还是最高风险的测量输入，而 `measure() === offsetHeight` 防线尚未建立（#3369）。
  未来重估必须同时满足两个前提：#3369 已落地，以及同一段中文长文 + 代码密集内容在 13/14px、双主题下的
  Sora/Inter 真实并排读数。

---

## 2. 字阶(数值已被 §0.0 覆盖:#7333 起 12/14/16/20/24)

采用 calm-ui 约束（来自 `nmhjklnm/frontend-skills`，本项目采用）：

| 级 | 用途 |
|---|---|
| `text-xs` | 元信息、时间戳、徽标 |
| `text-sm` | **正文默认** |
| `text-base` | 强调正文 |
| `text-lg` | 区块标题 |
| `text-xl` | **仅页级标题** |
| `text-2xl`+ | ❌ 禁用 |

移动壳正文不得小于 14px（既有不变量，见 `design-system` spec）。

**判据（#3334 P1 落地）**：`tests/visual-scale-guard-3334.test.ts`，跑在 `session-main`（四门 + CI）。
逃生口是**显式标记 token**，不是把某处摘出扫描面——摘出去的话改回违规写法不会有任何东西变红：

| 标记 | 含义 | 放行 |
|---|---|---|
| `gg-type-page-title` | 这是页级标题 | `text-xl` |
| `gg-type-display` | 字号由**内容/可读性**驱动而非 chrome 字阶（渲染出来的 markdown 标题、要照着念的配对码） | `text-xl` 及以上 |

标记写在 class 串里而不是注释里：注释会悄悄过时，class 在 devtools 里看得见，
而且拿掉标记这条判据立刻变红（变异自测钉住了这一点）。会话页产品源码当前
`gg-type-page-title` 8 处、`gg-type-display` 3 处（markdown 的 h1/h2 与 GitHub 配对码），
其余一律受上限约束。

**`gg-type-page-title` / `gg-type-display` 现在真有 CSS 定义了(2026-09-22,Refs #6104)。**
它们从 #3334 起就写在源码里,但**全仓零 CSS 定义** —— 只是上面那张表里的逃生标记,
一个只有尺子读得懂、浏览器读不懂的类名。于是「页级标题」这件事靠每个消费点自己再写一遍
`text-xl font-semibold tracking-tight`,写漏一样就少一样(实测 `lib/components/page-header.tsx`、
`lib/components/page-layout.tsx`、`features/onboarding/components/import-header.tsx` **三处都没写
`font-semibold`**);`features/onboarding/` 后来已整体删除)。design.md:「Type roles are a closed set … **Use the role.
Do not compose a one-off size.**」⇒ 角色自己得带上它的排版:

| 类 | 定义(在 `tokens.css` 的 `@layer components`) |
|---|---|
| `.gg-type-page-title` | `font-display` + 20/28 + 600 + `letter-spacing: -0.02em` |
| `.gg-type-display` | **只**给 `font-display`;❌ 不定字号 —— 它存在的理由正是字号由内容/可读性驱动、不在 chrome 字阶上,定了就等于把它拉回那条阶梯 |

⚠️ 放在 `@layer components` 而**不是**不分层:不分层恒压过 `@layer utilities`,那会让这两个类把消费点上
任何 `text-` / `font-` / `tracking-` 工具类全部顶掉 —— 角色该给默认,不该夺权。
现在次序是「角色出默认 → utility 可覆盖」,所以 `github-device-flow-modal.tsx:291` 那处配对码的
`font-mono text-3xl` 照旧赢。
⚠️ 两个 renderer 拆掉 shadow root 后进同一个 document(#2802),所以 `tokens.css` 这份定义在**嵌进咕咕时**
两边都到得了;脱开咕咕样式表的独立构建拿不到它。

**⚠️ 现在是两份逐字等值的定义,不是一份(2026-09-22 更正,Refs #6106)。**
上面那句「一份就够」只在嵌进咕咕时成立。会话页还有**独立构建**这条路径(storybook / 单独起会话页),
那条路径根本不加载 `tokens.css` ⇒ 消费点把重复的 `text-xl font-semibold tracking-tight` 删掉之后,
`page-header` / `page-layout` / `thread-welcome` 这几处在独立构建里会掉回继承字号。
所以 `session/renderer/index.css` 的 `@layer components` 里补了第二份:

| 份 | 文件 | 写法 |
|---|---|---|
| 定义处 | `apps/desktop/src/styles/tokens.css` | `var(--font-size-xl)` / `var(--lh-page)` / `var(--font-weight-semibold)` / `-0.02em` |
| 等值副本 | `apps/desktop/src/session/renderer/index.css` | 字面 `20px` / `28px` / `600` / `-0.02em` |

实测两份换算后逐字相同(`--font-size-xl` = 20px、`--lh-page` = 28px、`--font-weight-semibold` = 600)。
**⚠️ 改一处必须改两处,而当前没有任何机器判据钉住这一点** —— `radiusScaleParity` 只对拍圆角那三张表,
字阶这两份靠人工同步。这与 §5.2 的三张圆角表是同一类问题(同一件事写多处、机制上拿不到彼此),
区别只是圆角那边有判据、这边没有。⇒ 这一格在 §10 里记作「只有纸面约定」,不假装它守住了。

**`text-md` 从哑类变成真的(Refs #6104)。** 主 app 那张表(`tailwind.config.cjs` 的 `fontSize.md`)
本来就有 15px,会话页那张**没有** ⇒ 会话页里 6 处 `text-md`
(`features/library/prompts/prompt-library-view.tsx:44`、
`features/automations/components/AutomationTemplatesEmptyState.tsx:19`、
`features/onboarding/components/import-header.tsx:52,56`、
`features/onboarding/onboarding-shell.tsx:32`、
`features/automations/components/AutomationRow.tsx:94`)的字号一直**静默落回继承值**。
(其中 `features/onboarding/` 两处所在的目录后来已整体删除,现存 4 处。)
两张表各登记一份逐字等值的 `--text-md: 15px` / line-height 22px(= 字阶的 `--font-title` 那一档)。
❌ 没改成 `text-base`:会话页那边 `text-base` 是 Tailwind 默认的 16px,不在字阶(11/13/15/17/20)上
—— 那是把 6 处从「没字号」换成「错字号」。

会话页现有的 `--text-code: 13px` / `--text-tiny: 11px` / `--text-micro: 10px` 三个自定义档继续保留：
它们服务于文件树、diff 行号等密集工具 UI，删除会伤可读性。`--text-micro: 10px` 低于移动壳 14px 下限，
但完整会话页只在桌面 Electron 壳出现（桌面永不进移动壳，#3566），所以当前不冲突。`scripts/checks/check-ui-visual-spec.mts` 在源码文本层守住
这个前提：`apps/desktop/src/session/renderer/**` 一旦出现 `useMobileShell` 或等价移动壳分支就失败，并要求先重判本节。

⚠️ 上面这三档定义在 `apps/desktop/src/session/renderer/index.css`（会话页自己的 Tailwind 主题），
与下一小节说的 `packages/session-ui` 的 `--em-text-*` 是**两套不同的变量**，别混为一谈。

### 2.1 `packages/session-ui` 的字阶（2026-09-04 收敛）

组件库原来声明 8 档（10/11/12/13/14/17/20/24），产品源码里真正用到的只有 **12 和 13** ——
相邻 1px，分不出主次，其余六档只作为 sprinkles 的键存在、消费者全是 Storybook。
现收敛为 **11 / 13 / 15 / 17 / 20**，与主 app 的 `--font-caption/body/title/heading/size-xl` 一一对应：

- 12px 的 28 处按角色拆开：附属信息（说明、徽标、快捷键、分组标签、用量数字、取值）→ **11**；
  要读的内容与可交互控件（通知带、附件名、菜单项、触发器、mention pill、已选值 chip）→ **13**。
- 10px / 24px 零消费者，删。
- 14px 的 6 个 role var（body / bodyBold / bodyItalic / bodyLink / mention / h3）本来就被 app 层
  `.gugu-skin` 盖成 13 与 15 —— 包默认值只是**与产品不一致的第二套字阶**。现把默认值改成与覆盖值
  逐字相同，并补上此前缺失的 15 这一档（h3 原来只能借用 body 的 14）。
  `.gugu-skin` 是 `:root` 的后代，继承型自定义属性在后代自己的声明处必胜，与特异性无关
  ⇒ 改包默认值对已发布的会话页是 no-op。
- 控件族的 `sm` 尺寸不再单独压字号：**size 只管几何**，与主 app `Button` 原语所有尺寸同一个
  `--font-body` 一致。
- 行内代码不占字阶的一档，用 `0.92em` 跟着周围正文走（mono 在同磅值下视觉偏大，这是**跨字体的
  光学补偿**而不是层级）。与主 app `MessageMarkdown` 的 `[&_code]:text-[0.92em]` 同一条约定；
  13 × 0.92 = 11.96，与原来写死的 12px 差 0.04px，且标题里的行内代码从此会跟着标题放大。

**两道闸挡的不是同一件事**：字阶本体由 token 契约守——删掉的键再被引用 tsc 直接编不过；
字面量那一路由 `scripts/checks/check-ui-visual-spec.mts` 守——绕开 token 直接写 `fontSize: '12px'`
不动契约，tsc 照样过。禁用字号的扫描面因此从 `apps/desktop/src`（主 renderer）扩到
**主 renderer + `apps/desktop/src/session/renderer` + `packages/session-ui/src`** 共 1705 个文件。
`tests/unit/scripts/uiVisualSpecGeometryDebt.test.ts` 里两条**可达性阳控**钉住后两支：
把扫描面缩回去，恰好那两条红、其余全绿。
❌ 别用「跑一次真守卫看它是绿的」代替这两条——守卫在真仓上绿，既可能是真没有违规，
也可能是它压根没扫那两棵树，两种解释在数值上都是 0。

**未动**：`packages/session-chat-ui` 的转录正文字阶。它由 #3369 把关，而那道
`measure() === offsetHeight` 的防线目前并不存在（实测把 lineHeight 20 改 21，232 个测试无一变红）
⇒ 在补上判据之前动它，等于在没有仪器的情况下改渲染几何。

### 2.2 `packages/session-chat-ui` 的 chrome 字号是一组**静态**角色，与转录正文分开（2026-09-22 立，Refs #6104 / #6109）

**规定**:transcript 引擎里那些**不是转录正文**的字(折叠头的 chevron 与时间头、
turn-outcome 徽标这类界面自己的字)走本包自己的三档闭集
`vars.typeChromeFontSize` / `-Tiny` / `-Micro` = **13 / 11 / 10**,
逐字等值于主 app 的 `--text-chrome-body` / `--text-tiny` / `--text-micro`。
❌ 不许借 `vars.type*`(`typeBody*` 那一族);❌ 不许写裸 px。

**为什么不能借 `typeBody*`**:那一族不是排版常量,是**测量输入**。
`core/config.ts:333` 写着 `typeBodyFontSize: px(r.body.size)` —— 值从 `config.roles` 来,
而 `config` 是宿主运行时注入的(§1.1 的 `createChatContext({ config: SESSION_CHAT_CONFIG })`),
会跟着移动壳、跟着用户配置变。chrome 的行高是 measure 之外写死的常量 ⇒ 借过来的后果是
**用户改一次转录字号,折叠头和活动行的行高跟着漂**,而没有任何测量在接住它。
⇒ 这三档**不进 `ThemeVarKey`**,与 `radius*` 同属静态档 —— 「谁会被宿主改」是这两族的分界线,
不是「它是不是字号」。

**为什么也不能写裸 px**:12 / 14 / 半像素字号在全仓是硬闸。
⚠️ **这条闸 2026-09-22 之前够不到本包**:`check-ui-visual-spec.mts` 的扫描面不含
`packages/session-chat-ui/src`,而专用守卫 `check-session-chat-ui-geometry.mjs` 只解析 JSX 的 class 串与
CSS `@apply`,对本包几乎全用的 `style({ fontSize: '12px' })` 结构上不可见(两条的量程见 §10)。
于是主 app 早就消灭掉的 12px 在这里原样活着(普查 4 处:mermaid 占位 / 附件名 / 结局动作键)。
本轮把本包接进硬闸的扫描面,并把那 4 处连同散落的 13 / 10 一起收进上面三档。

**判据**:硬闸(12 / 14 / 半像素)现在覆盖本包。
⚠️ 但**只有硬闸那一格** —— 半步间距与几何债那几条棘轮仍不含本包 ⇒
「不在字阶上、又不犯硬闸」的值(实测仍有 `unit-row` 9px、`block-frame` 10px、五处 11px、
三处 `0.75rem`)照样没有东西判。⇒ **闸只能判「这个值犯不犯禁」,判不了「这个值该叫什么角色」**,
后半句永远只能由这一节这样的条文承担。

**判据**:无。补这一格要先定「chrome 角色有哪几档」,而那是 token 级改写,该有自己的批次与验收
(与 §2.1 收敛 `packages/session-ui` 字阶同一类动作)。在那之前这三处按既有值留着,
❌ 别为了让扫描面变绿就把它们接到 `vars.type*` 上 —— 那是把一个看得见的缺口换成一个看不见的耦合。

---

## 3. 字重

每屏 2–3 档：`400` 正文 / `500` 次强调 / `600` 标题。❌ 不用 `700`+。

---

## 4. 间距刻度

**Tailwind 原生 spacing 刻度是全 app 的现状口径。** 源码文本层实测的 0.5 步进 utility 为：会话页 353 处、
咕咕主 renderer 96 处；这不是会话页偏差。`scripts/checks/check-ui-visual-spec.mts` 用双向棘轮冻结这两个基线：
超基线必须删新增，低于基线必须同步降低 `scripts/checks/ui-visual-spec-baseline.json`，只减不增。

`4 / 8 / 12 / 16 / 20 / 24`（对应 `--spacing-xs…2xl`）是**新写组件与重画组件的偏好刻度**，不是对存量的
静默违规判定。P3 重画到的组件采用这组偏好；本轮不做 449 处清扫。默认紧致，❌ stretch 铺满。

---

## 5. 圆角

### 5.1 8 档语义表（2026-09-22 裁决，Refs #6104;数值已被 §0.0 覆盖,#7333 新增 xs / dialog / bubble、surface 12、thread 24）

**定义处只有一份**:`apps/desktop/src/styles/tokens.css`。三问定档 ——
这是纸(page)?印在纸上的东西(document)?还是压出来的物件(其余各档)?

| token | 值 | 用在哪 |
|---|---|---|
| `--radius-page` | 0 | 页面自己;通栏必方 |
| `--radius-document` | 6px | 印在页上的东西:代码面、表格、图版、规格框 |
| `--radius-sm` | 6px | kbd、行内代码、最小的图标钮 |
| `--radius-control` = `--radius-md` | 8px | 按钮、输入框、头部 CTA |
| `--radius-surface` | 10px | 菜单、popover、tooltip |
| `--radius-xl` | 12px | 对话框、toast、任何浮起来的卡片 |
| `--radius-thread` | 16px | composer 与用户气泡 —— **产品语汇**,❌ 不上 marketing chrome |
| `--radius-capsule` | 9999px | switch、头像、状态点 |

外加 `--radius-circle: 50%` —— **真·正圆**只有这一个名字。数字别名
`--radius-lg`(→control)/`--radius-2xl`(→thread)/`--radius-3xl`(→thread)/`--radius-full`(→capsule)
只为 Tailwind 兼容存在;design.md:「The numeric aliases exist for Tailwind compatibility.
**Reach for the semantic name**」。旧名 `--r`/`--r-lg`/`--r-xl`/`--r-bubble`/`--r-pill`/`--radius-menu`
全部改成这张表的别名(值逐字相同),**不留第二套数值**。
表里没有 24px 这一档 ⇒ `--radius-3xl` 落回 thread,而 `rounded-3xl` 作为类仍禁用。

### 5.1.1 胶囊是一个闭集；正圆有自己的名字（2026-09-22 裁决，Refs #6104 / #6105）

**规定**:9999 / 50% 这两档合起来是一个**闭集** —— switch、头像、状态点、未读计数,
**其余一律落 `--radius-sm`(6px)或 `--radius-control`(8px)**。闭集内部再分两档:

| 元素 | 该用哪个 | 为什么 |
|---|---|---|
| 头像、状态点 | `--radius-circle`(50%) | 它们是**正圆**,宽高本来就相等,画的是「一个人」「一盏灯」 |
| switch、未读计数 | `--radius-capsule`(9999px) | 它们是**胶囊**:宽随内容变(两位数的未读、滑轨的长度),要的是两端半圆 |

**为什么要闭集而不是「按感觉」**:design.md 的 shape 表把 9999 这一档**只**发给
「switch, avatar, status dot」,并在同一段写「Marketing CTAs are 8px rectangles. **Never pills.**」。
胶囊是这张表上唯一一个「形状本身携带语义」的档 —— 它说的是「这是一个开关或一个人」,不是「这是个按钮」。
一旦允许「看着像一族就都做成胶囊」,它就退化成一种装饰,而表上其余七档立刻少一个可判的边界。
实测代价:改之前建议 chip、分段控件、筛选页签、结局徽章全在用它,一屏里胶囊指不到任何一件事。

**为什么正圆要单列一个名字**:`9999px` 与 `50%` 在**正方形**元素上同形,在长方形上完全不同
(前者胶囊、后者椭圆)。旧仓把 `--radius-full` 定成 `50%`,于是所有 `rounded-full` 的药丸在
宽 ≫ 高的元素上渲染成椭圆(旧 F-05);修法是 `full` 归位到 9999、另立 `--radius-circle: 50%`。
⇒ **要正圆就写出「正圆」这个名字**,❌ 别再靠「反正我这个元素是正方形」让两个值恰好同形 ——
那是把正确性押在一个随时会变的宽高比上。

**判据**:`radiusScaleParity` 钉的是**取值**(`--radius-capsule` = 9999、`--radius-circle` = 50%),
❌ 它判不了「这一处该不该用胶囊」。用途闭集当前**只有纸面约定**,理由见 §5.3 末尾那条
「`rounded-full` 为什么没进禁令」:容器与形状在源码文本层同形,造一条分不开它俩的判据,
等于把几十处正当写法系统性报成违规。
⚠️ **收敛时最容易踩的坑:注释会替一个已经消失的前提辩护。**
`session-view-control.tsx` 的「编程｜通用」分段控件曾经写着「圆角对齐同排:rounded-full」,
而同排邻居(`chat-composer.css.ts` 的 `agentTrigger`)早已退到 `radiusMd`(8px)——
注释在为一个不成立的事实作证,照它改的人会再造一枚胶囊。两枚已于 2026-09-22 一起归档并改了注释。
⇒ **改形状时连注释一起改**;逐处核销读数不进本文(见 #6103 的核销表),本文只留规则与理由。

### 5.2 逐字等值的三张表，与那条对拍判据

同一张表写了三处,因为三处的机制不同、都拿不到彼此:

| 表 | 文件 | 为什么不能写 `var()` |
|---|---|---|
| 语义表(**定义处**) | `apps/desktop/src/styles/tokens.css` | — |
| 主 app 的 Tailwind 表 | `tailwind.config.cjs` 的 `borderRadius` | 经 `@config` 生效,值编译进 utility |
| 会话页的 Tailwind 表 | `session/renderer/index.css` 的 `@theme inline` | `inline` 把值直接内联进 utility,写 `var(--radius-xl)` 会自引用 |

⚠️ **后两张表进的是同一个 `document`**(#2802 拆掉 shadow root 之后),同名 utility 谁后注入谁
**全文档赢**。这正是旧 F-05 的根因:`rounded-full` 在主 app 那张是 `50%`、会话页那张没写、
落回 v4 默认 `calc(infinity * 1px)` ⇒ **打开一次会话页,全 app 的 `rounded-full` 从椭圆翻成胶囊**。
所以会话页那张必须把 `xl / 2xl / 3xl / full` 也**显式写出来**,不写就落回 v4 默认
(0.75rem / 1rem / **1.5rem** / ∞)。

收口证据用的是**构建产物**(与当初立案时同一种证据):

```
dist/assets/index-*.css   .rounded-full{border-radius:9999px}  .rounded-3xl{16px}  .rounded-md{8px}
dist/assets/task-*.css    逐字相同
```

改之前:`.rounded-full{border-radius:50%}` vs `.rounded-full{border-radius:3.40282e38px}`。

**判据**:`scripts/checks/check-ui-visual-spec.mts` 的 `radiusScaleParity`(在 `pnpm lint`,见 §10)。
它读三处源文本逐档比对;判的是**几何**不是拼写(`0.5rem` 与 `8px`、`0` 与 `0px` 读成同一个值)。
❌ 别把它改成「只看 tailwind.config」:那样会话页那张表改回默认不会有任何东西变红。

**⚠️ 判据有一个具名盲区:`--radius-surface` 这一档它不管。**
脚本里是两张期望表 —— `RADIUS_SEMANTIC_EXPECTED`(对 `tokens.css` 校验)是九档、**含 surface**;
`RADIUS_NUMERIC_EXPECTED`(对两张 Tailwind 表校验)只有 `sm/md/lg/xl/2xl/3xl/full` **七档数字别名**,
不含 surface。理由是 surface 不是 Tailwind 的数字别名,v4 也没有 `rounded-surface` 这个默认类
⇒ 「不写就落回默认」这条推理对它不成立,判据那条错误消息也就无从说起。

**规定**:`--radius-surface` 必须在**两张表里各登记一份**(值同为 10px),并且靠人工保持同值 ——
少了哪一张,`rounded-surface` 这个 utility 在那一边**根本不生成**,
而 Tailwind v4 对表里没有的 key 是**静默丢整条 utility**(同 §1.2.1 那条),不报错、不回落,
浮层就少了圆角,而源码读起来完全正常。

这**不是假设**:`session/renderer/index.css` 早就有它,`tailwind.config.cjs` 一直没有 ⇒
`rounded-surface` 从前只在「会话页那张表也加载了」的时候才成立,主 app 单开时静默落空。
2026-09-22 两张都补齐了(`tailwind.config.cjs` 的 `borderRadius.surface: '10px'`)。
⚠️ 但**守住它的仍然只是这段文字**:判据对这一档是盲的。
⇒ 下次要么把它接进判据(在 `RADIUS_NUMERIC_EXPECTED` 之外再加一张「语义档也要在两张表登记」的期望表),
要么就一直这么明写着。❌ 别让它停在「以为有人在守」——那正是 §8 条 0 那次失真的起点。

### 5.3 已被 design.md 裁决覆盖的旧读数（保留）

> ~~`--radius: 0.5rem`(已存在于 `.emlight`/`.emdark`，本次复用未改)。
> 派生：`--radius-lg = --radius`、`--radius-md = --radius - 2px`、`--radius-sm = --radius - 4px`。
> calm-ui 约束为 `0.375–0.5rem`，当前取值位于区间上端 ✔。~~
>
> **已被 design.md 裁决覆盖。** 差在两处:① 这条相对公式派生出的是 8/6/4,而表里没有 4px 这一档,
> 且 `md` 是 8 不是 6;② 它是**第三套**刻度(当时全仓共六套,另有 session-ui 的 4/6/8/8/14/20/9999、
> session-chat-ui 的 6/8/14/9999、console 的 10px 基、dashboard 的 8px 基)。
> `--radius` 本身保留,值钉在 8px = `--radius-control`,只当 shadcn 组件的基准,
> ❌ 不再从它 calc 出派生档。

> ~~**判据（#3334 P1 落地）**：`rounded-xl` / `rounded-2xl` / `rounded-3xl`（含 `rounded-t-xl`
> 这类侧变体）一律禁用，没有逃生口——它们的存在方式就是「把 `--radius` 覆盖掉」。
> 会话页原有 9 处已全部收敛为 `rounded-lg`。~~
>
> **部分被覆盖**:`rounded-xl` **解禁** —— 它现在就是表里 12px 那一档(dialog / toast / floating card),
> 有自己的语义位置,不再是「把 `--radius` 覆盖掉」。`rounded-2xl` / `rounded-3xl` **仍禁**。
> ⚠️ 执行这条禁令的 `tests/visual-scale-guard-3334.test.ts` 已于 2026-09-11 被删(见 §10),
> 所以这条禁令当前**没有机器判据**,只是纸面约定。

> **`rounded-full` 为什么没进禁令**：规格说的是「**容器**不得用 `rounded-full` 覆盖 `--radius`」，
> 而「容器」与「形状」在源码文本层分不开——头像、圆点、徽标、进度条、图标按钮都正当地用它，
> 它们和一个真做错了的圆角面板在 class 串上完全同形。造一个分不开它俩的判据，等于把 51 处
> 正当写法系统性地报成违规。⇒ 判据只**计数并输出**（当前 51，且它同时是「这把尺子读得到类名」
> 的阳性对照），不判违规。要真判它，得先有一条能判假的「这是不是表面」的判据；
> 在那之前不假装这一格已经守住了。

### 5.4 三条有界例外（2026-09-22 裁决，Refs #6103）

shape 表是法,例外只能**有界**:写清范围、写清理由,超出范围就是违规。
本文目前只承认这三条,❌ 不许再靠「我这处也差不多」往上加 —— 一条无界的例外不是例外,是第二套刻度:

| 例外 | 范围（闭集，超出即违规） | 理由 | 判据 |
|---|---|---|---|
| composer 的圆形图标钮**可以**保持 `--radius-capsule` | **仅** composer 的发送 / 停止 / 滚到底三枚（是**许可**不是要求：本来就不圆的那枚不必改圆） | 它们在视觉上接近**状态点**而非按钮:一枚实心 ink 圆点,语义落在 shape 表 `status dot` 那一格;而 design.md 对最小图标按钮的口径是 6px(`--radius-sm`) | 无（同 §5.1.1 的理由：源码文本层分不开「圆按钮」与「状态点」） |
| `AgentInstallForm` 的 `rounded-[7px]` / `rounded-[5px]!` | **仅** `task/renderer/features/settings/agents-page/AgentInstallForm.tsx` 的分段控件底槽与段块 | **照稿复刻**:7/5/26/10 是设计稿 `.seg`/`.sg` 定死的一组数,把它改到 6/8 会让这颗控件与设计稿对不上,而它是逐像素复刻件 | `inlineRadiusLiterals` 棘轮计入（只减不增，所以它不会悄悄繁殖） |
| 页签「耳朵」的 9px（`--radius-tab-ear`） | **仅**活动页签的上两角与 `.session-tab-ears` 那两枚外探伪元素 | 9px 不是刻度上的一档,是**外探几何**:页签与下方内容连体,它自己的上两角与外探伪元素**必须是同一个数**,差 1px 接缝处就露一条亮边 | 有名字就有单一出处：两处共用 `--radius-tab-ear`，`rounded-t-tab-ear` 是真 utility ⇒ ❌ 别写回 `rounded-t-[9px]`，也别在伪元素里再拍一个 9 |

⚠️ **「照稿复刻」不是一张免死金牌。** 同一处的阴影就**没有**豁免:`data-pressed:shadow-sm`
在 2026-09-22 被删掉了,理由是 design.md「阴影全局归零,非浮层不得上阴影」——
选中块靠 `bg-background` 与底槽 `bg-background-3` 的密度差就够。
⇒ 豁免的粒度是**一条属性**,不是一个文件:同一个元素可以圆角照稿、阴影按规格。

---

## 6. 层级与阴影

### 6.0 一档 lift（2026-09-22 裁决，Refs #6104;已被 §0.0 覆盖:#7333 起分 lift / dialog / composer 三档,半像素轮廓画在投影里）

design.md:「**Shadows are zeroed globally. Only a floating surface may lift.**」+ Reject 列表的
「ornamental shadows」。

- **全 app 只有一档投影**:`--shadow-lift`(暗 `0 8px 24px rgb(0 0 0 / 0.45)`,浅 `/0.12`),
  给 dropdown / popover / dialog / toast / sheet。浅色侧**只**重定义这一档,
  ❌ 不再抄一排深浅 —— 深浅不是可选项:两个都能「浮起来」的浮层若投影一深一浅,
  读到的是「它们不是一类东西」,而它们是。
- 非浮层一律**靠密度分层**(`bg-foreground/[0.025]`),❌ 不给阴影。
  仓内的零阴影参照实现:`session/renderer/features/extensions/panel/extensions-panel.css`。
- 原来那 13 个具名 shadow 里,`--shadow-dropdown` / `-modal` / `-popover` / `-popover-strong` /
  `-overlay-panel` / `-floating` / `-toast` / `-toast-card` / `-call-panel` / `-drawer` /
  `-drawer-strong` / `-menu` 与 `--modal-shadow` / `--modal-light-shadow` 全部变成 `--shadow-lift`
  的**别名**(名字留着,消费点不必一次性全改)。

**为什么不是 `* { box-shadow: none }`**:`tokens.css` 那条 `*:not(.gugu-skin…)` 重置**不分层**,
而不分层恒压过分层(Tailwind 的 `@layer utilities`)⇒ 一条全局清零会连浮层的 lift 一起压掉,
且没有任何选择器权重救得回来。清零改用**删名字**:

| 已删的 token | 删了之后 | 残留消费点(归第二阶段) |
|---|---|---|
| `--shadow-card` | `var(--shadow-card)` 在 computed-value time 无效 ⇒ `box-shadow` 落回初始值 `none`,与全局清零等效 | ~~`components/ChatAreaPanel.tsx:2128`~~ ✅ 已清(改 `var(--shadow-lift)`) |
| `--shadow-panel` | 同上 | 无(删前实测 0 消费者) |
| `--shadow-sm` | 同上 | ~~`components/ui/Switch.tsx:31`(旋钮高光)~~ ✅ 已清(旋钮不是浮层,直接不给阴影) |
| `--shadow-switch-knob` | 同上 | 无(删前实测 0 消费者) |

⚠️ 上表最后一列 2026-09-22 复核过:两处残留消费点都清了,全仓 `var(--shadow-card)` / `var(--shadow-sm)`
的**实码**命中为 0(剩下的都在注释里,记录的是删掉的是什么)。
❌ 别把「token 删了所以不会炸」读成「所以可以不清消费点」—— 不清的话那个元素只是**静默**没了阴影,
而源码读起来仍像是有,下一个人会照着它再写一个。

`tailwind.config.cjs` 里那份与 tokens.css **同名不同值**的平行 `boxShadow.{dropdown,modal,card,panel}`
一并删掉(删前实测 4 个工具类在 `apps/` `packages/` 的消费者都是 0)。
`--listen-mode-active-shadow` 两侧都改成 `none`(分段控件不是浮层)。

**带理由留下的非浮层 `box-shadow`**(都不是装饰投影,已就地注明):
`tokens.css` 扫码取景框那条 `0 0 0 9999px`(是**遮罩**,把取景框外压暗)、
`msg-src-flash` 的闪烁环(**瞬态**强调)、`lib/ui/shortcut.tsx` 键帽的 `inset` 内高光。

### 6.2 已被 design.md 裁决覆盖的旧读数（保留）

> ~~- 阴影不超过 `shadow-sm`；❌ 有色阴影。~~
> ~~- 表面层级靠**底色**表达，不靠投影~~
>
> 第二条**仍然成立且被强化**(现在连浮层的层级也由底色给,投影只表示「它浮着」)。
> 第一条**已被覆盖**:方向从「不超过 shadow-sm」改成「默认零、只有浮层点亮」——
> 旧口径下 97 处 `shadow-*` 里有 13 处是 `shadow-none`,即「默认有阴影、个别关掉」,
> 与 design.md 正好相反。

> ~~**判据（#3334 P1 落地）**：`shadow-*` 只放行 `shadow-none` / `shadow-2xs` / `shadow-xs` / `shadow-sm`…~~
>
> **判据已不存在**:执行它的 `tests/visual-scale-guard-3334.test.ts` 于 2026-09-11 被删(见 §10)。
> 阴影这一格当前没有机器判据。

> **`shadow-[inset_…]` 不在这条限制内**：它是**内嵌高光**（`lib/ui/shortcut.tsx` 的键帽那圈 1px 边），
> 不是投影。规格禁的是「投影太重 / 有色投影」，把内嵌高光一起禁掉是把两件事混成一件。
> ⚠️ 这个豁免是「换一条断言」而不是「跳过断言」：非 inset 的任意值阴影照样红，有变异对照钉住。
> 第一版判据正是因为没分这两件事，把 4 处正当的键帽高光报成了违规。

### 6.3 浮层表达（2026-09-22 裁决改写；原 §6.1）

菜单 / 下拉 / 选择器 / combobox / 弹出层 / 对话框 / 模态 / 抽屉 / toast **只有一种表达**：

```
bg-background-quaternary + rounded-[--radius-surface | --radius-xl] + shadow-lift
```

—— **不再叠 `ring-1`**。design.md:「A hairline is `border-foreground/10`.
**Do not stack a border, a ring, and a shadow on one edge.**」上一版公式
(`shadow-sm + ring-1 ring-foreground/10`)正是这条规则逐字点名的写法:
浮起来这件事由 lift 一个人说,边不必重复说一遍。
圆角按角色分两档:菜单 / popover / tooltip 取 `--radius-surface`(10px),
对话框 / toast / 浮起来的卡片取 `--radius-xl`(12px)。

**这条公式的三个「无」同等重要:无 ring、无 border、无第二档阴影。**
公式写成「加什么」容易只落实一半 —— 实测就有一处只去了 ring 没去 border、一处只改了圆角没换阴影。
⇒ 验收的方法不是对着公式逐项打勾,而是**数这个浮层边上有几条线:一条都不该有**。

**校验失败态只换一条线,不叠 ring(2026-09-22 裁决)。** 输入框 / combobox 的
`aria-invalid` 态从前是「常态 border + shadow,失败再加 3px ring」= 三者共边,
正是 design.md「Do not stack a border, a ring, and a shadow on one edge」逐字点名的写法。
现在是 `aria-invalid:border-border-destructive` **一条线换颜色**,❌ 不加第二层。
为什么不是「加一圈红环更醒目」:醒目来自**对比**,而一条 10% 的 hairline 换成 destructive 色
已经是全屏唯一的彩色边;再叠一圈就变成两条线在说同一件事,而第二条抢的是厚度不是注意力。

**会话页侧栏「浮出态」承认它是浮层(2026-09-22 裁决)。**
停靠态与浮出态是两件事:停靠是**版面的一栏**(有右缘线,与主区并排),浮出是**盖在主区之上的一层**。
⇒ 浮出态去掉 `border-r border-border`,只留一档 lift,和菜单 / dialog 同一条公式。
理由是它本来就满足浮层的三问(它浮着、它盖住别的内容、它可以被点外面关掉),
而「既画边又画影」等于同时声称自己是一栏和一层。
落点:`session/renderer/lib/layout/workspace-layout.tsx` 的 `isPeekVisible` 分支。

**本轮(#6104)已落地的那半边**——`packages/session-ui` 的 vanilla-extract:

| 文件 | 改前 | 改后 |
|---|---|---|
| `styles/recipes/popup-surface.css.ts` 的 `popupShadow` | `shadow-sm` 两层 + `0 0 0 1px color-mix(foreground 10%)` 环 | `var(--shadow-lift, …)`,**无环** |
| `styles/recipes/popup-surface.css.ts` 的 `popupSurface` | `radiusMd`(8px) | `radiusSurface`(10px) |
| `primitives/combobox/combobox-popup.css.ts` | `radiusMd` | `radiusSurface` |
| `primitives/dialog/dialog.css.ts` | `radiusMd` | `radiusXl`(12px) |
| `EmdashSessionFrame.tsx` 的两条 `data-slot` 规则 | 各指 `--shadow-popover` / `--shadow-modal` | 并成一条,直接吃 `--shadow-lift` |

> ~~**还没落地的那半边**(renderer 的 Tailwind,归第二阶段):下表 9 个文件里的 `ring-1 ring-foreground/10`
> 仍在,加上 `lib/ui/input-group.tsx:16`(常态 border + shadow,校验态再加 3px ring = 三者共边)与
> `components/MemberProfileCard.tsx:16`(border + 一次性任意值阴影,不走任何 token)。~~
>
> **2026-09-22 已落地(#6106 / #6103)。** 实测 `ring-foreground/10` 在 `apps/` `packages/` 的
> **实码命中为 0**(剩下的三处命中都在注释里,记录的是旧公式长什么样);
> `input-group.tsx` 的校验态收成一条 `aria-invalid:border-border-destructive`;
> `MemberProfileCard.tsx` 的一次性任意值阴影改 `shadow-[var(--shadow-lift)]`。
> ⚠️ 最后清掉的那一处(`features/sidebar/sidebar-identity-card.tsx` 的手抄浮卡)有个值得记的细节:
> **它自己的文件头注释把「ring + lift」写成了正确配方** —— 改形状时要连注释一起改,
> 否则下一个照着注释写的人会原样再造一个,而判据看不见注释。

原 §6.1 的收敛读数(**保留**,它记录的是上一版公式兑现后的形态):

| 文件 | 收敛前 | 收敛后 |
|---|---|---|
| `context-menu.tsx:54` | `bg-background` `shadow-md` `ring-1` | 统一 |
| `dropdown-menu.tsx:46` | `shadow-md` `ring-1` | 统一 |
| `select.tsx:89` | `shadow-md` `ring-1` | 统一 |
| `combobox.tsx:124` | `shadow-sm` `ring-1` | 本来就是目标形态，未改 |
| `dialog.tsx:56` | `rounded-xl` `bg-background` 只有 `ring-1`、无 shadow | 统一 |
| `modal-renderer.tsx:145` | `rounded-xl` 无 shadow | 统一 |
| `popover.tsx:41` | 用 `border` 而不是 `ring-1` | 改 `ring-1`（`ring` 不占布局，`border` 占） |
| `sheet.tsx:56` | `shadow-lg` | `shadow-sm` |
| `sonner.tsx:14` | `bg-background` `shadow-lg` | 统一(该文件已随 #137 删除,提示条样式在 `notice-host.css`) |

> 上一版本文写的是「现存 `shadow-md` 与 `rounded-xl` 由 P1 chrome 车道收敛」——上表就是它兑现后的读数。
> ⚠️ 表里的 `shadow-sm` 与 `ring-1` 两列**已被 design.md 裁决覆盖**(见本节开头的新公式);
> `dialog.tsx` 那条 `rounded-xl` 现在是**合法**的(它就是 12px 那一档),不再是违规。

#### 另一半：`packages/session-ui` 的 vanilla-extract 浮层（#3334 P2 落地）

上表只覆盖了 renderer 的 Tailwind 那半边。**会话页输入区(composer)与它弹出的每一个浮层不在那里** ——
它们是 `packages/session-ui` 的 vanilla-extract，圆角/阴影写成属性值而不是类名。P1 收敛完之后，
composer 的卡片仍是 14px 圆角 + 12px 扩散的第二层投影，模型菜单仍是 `shadow-md` 那条公式。

**这不是疏忽，是判据的量程**：`visual-scale-guard` 按 class token 分词，对属性值结构上不可见
⇒ 它报的「0 违规」是真的，只是那个 0 的主语不包含这半边。补齐的判据见 §10。

| 文件 | 收敛前 | 收敛后 |
|---|---|---|
| `chat-composer.css.ts` 卡片 | `radiusXl`(14px) · `0 1px 3px …, 0 4px 12px …` 双层投影 | `--radius`(8px) · `shadow-sm` 两层 |
| `chat-composer.css.ts` notice band | `radiusXl` | `--radius` |
| `permission-band.css.ts` · `queued-prompts-band.css.ts` | `radiusXl` | `--radius` |
| `dropdown-menu.css.ts`（composer 的模型/强度面板） | 手抄一份 `shadow-md` 公式 + 整段 popupSurface 副本 | 组合 `popupSurface` + `popupShadow` |
| `popover.css.ts`（用量指示器） | `shadow-sm` 但**无环**，且用 `border`（占布局） | 组合 `popupSurface` + `popupShadow`（环不占布局） |
| `dialog.css.ts` | `radiusXl` · `shadow-md` | `--radius` · `popupShadow` |
| `combobox-popup.css.ts`（@提及 / 斜杠弹层） | 取值已是目标形态，但自己抄了一遍 | 消费 `popupShadow` |
| `combobox.css.ts`（agent 选择器） | 本来就消费共享取值，未改视觉 | 跟随改名 |
| `popup-surface.css.ts` | `popupShadowSm` + `popupShadowMd` 两档 | **一档** `popupShadow` |

> ⚠️ 上表的「收敛后」一列写的是 #3334 的目标形态(`--radius`(8px) + `shadow-sm` + 环)。
> **已被 design.md 裁决覆盖**:圆角按角色改成 surface(10)/ xl(12)/ thread(16),阴影改成唯一那档 lift,
> 环去掉。composer 卡片那档从 `radius2xl`(20px)改名 `radiusThread`(16px)——
> 20 在任何一张刻度上都没有对应值,改名 + 落到 16 之后它不再是特例,而是表里的一档。

> **`popupShadowMd` 的实测消费者是 0**（阳性对照：同一次普查里 `Sm` 读到 `combobox.css.ts` 的真实消费点），
> 而三处**没有**消费它的浮层各自手抄了一遍同样的 `shadow-md` 公式。一份没人用的「共享」取值配三份复制品，
> 是「浮层只有一种表达」这条规格在实现层的反面。合并成一档之后，它只有一个定义处。


---

## 6.4 颜色三条（2026-09-22 裁决，Refs #6104;① 与「选中属 live」已被 §0.0 覆盖:#7333 起中性纯灰、选中是前景 7.5%）

design.md 的 color register 有三条,咕咕原来三条全偏:

**① One knob.** 「`--tint` puts every neutral on one low-chroma oklch hue. This is sand,
not gallery grayscale. **Never introduce a neutral outside that family**」。
改之前的 OKLCH 实算:面层散在 **264°–294°**(跨 30°),而 `--fg` / `--text-muted` / `--text-icon-*`
一整族 chroma **精确为 0** —— 那不是同一族的浅端,是盖在偏蓝面族上的**第二族**中性。
现在:`--tint: 268`(取自 `--bg` `#111318` 的实算色相),全部中性写成 `oklch(L C var(--tint))`,
明度逐个贴住原 hex(每行行尾注着改写前的值,留作对拍),所以观感只「同族化」不大变。
`hover` / `press` / `selected` / `pinned` / `border` 这些叠色改成
`color-mix(in oklab, var(--fg) N%, transparent)` —— **一条式子通吃明暗两侧**,因为 `--fg` 自己分主题。
`tokens.css` 里的 `#fff` / `#000` 字面量清空,只剩四处带理由的例外(**都不是中性族的一员**):
`--color-white`(见 §7 那整段:白字画在饱和红上)、danger chip 的字、扫码浮层的字
(画在实时摄像头画面上,底色不可知)、Windows 关闭钮 hover 的 `#E81123`(平台惯例)。

**② Chrome is ink; product data may be colored.** design.md 的 Reject 列表逐字点名
「Rainbow type badges, colored category chips, and icons dropped into tinted tiles」。已改:

| 原来 | 现在 |
|---|---|
| `--category-notifications/appearance/keys/storage` 四色(H 262.5 / 82.5 / 182.5 / 244.7) | 六档同一个 `var(--fg)`;区分靠图标字形与标签 |
| `--team-peach/-lav/-mint` 三色底 + `-ico` 三色图标(H 55.5 / 281.1 / 154.3) | 同一层前景密度底(4% / 8%) |
| `--agent-bolt: #e0a13a`(H 75.6) | `var(--fg)` |
| session-chat-ui 的 mention chip **按种类**分色(issue 蓝 / symbol 紫) | 收成一档。宿主桥早就把两种映到同一档,本轮把它抬成**包的默认** |

token 名一律保留、**消费点一处没改**,改的只是取值 —— 这是有意的:
改名要动几十个消费点,而改值一行就让整族退回墨色,两件事分开做,红了也知道是哪一件红的。
⚠️ 副作用是**名字开始说谎**:`--agent-bolt` 现在是墨色,`--team-peach` 现在不是桃色,
而它们仍有 4 / 0 个消费者。⇒ 下一次清扫的动作是**删名或改名**,❌ 别再往这些名字上叠新语义。
**放行的 product-data 调色板**(不算违规):`--chart-1..5`、syntax theme、diff 色、terminal ANSI、
以及会话页保留的整套 jade / amber / blue / red 阶梯 —— jade 不删,只是不再当 accent。

**③ One accent at a time, and the accent is blue.**
新增 `--live`(浅 = blue-500 `oklch(0.623 0.188 260)`,暗提一档到 blue-400 `oklch(0.714 0.143 255)`)
与 `--live-soft`(14% 底);会话页 `@theme` 登记 `--color-live` / `--color-live-soft`。
它是全 app **唯一**表示 streaming / running / connected / currently selected 的色 ——
「页面上没有活着的东西,页面就没有蓝」。已归并:

| 原来 | 现在 | 原来错在哪 |
|---|---|---|
| `--state-tint-selected` 暗 `#fff` / 浅 `#3b82f6` | 两侧都 `var(--live)` | 同一个语义在两个主题里是两个身份 |
| `--status-in-progress: var(--amber-11)` | `var(--live)` | 「在动」用琥珀、「选中」用蓝 = 两个 accent |
| `--foreground-info: var(--blue-9)` | `var(--live)` | 角色保留,但「两个蓝竞争时必有一个是装饰」 |
| `--text-link: #576b95` / `--toast-info` / `--color-text-link` | `var(--live)` | 链接是信息,信息是同一个蓝 |

**③-a 链接是 live 蓝的一条有界例外(2026-09-22 裁决)。**
`--live` 是 live 的**唯一**色,但**链接是例外** —— 链接蓝是**跨产品共识**,
它在这里不表示「此刻在发生」,表示「这段字可以点」。
⇒ `--text-link` / `--foreground-info` 指向 `var(--live)` 这件事**不改**;
`badge` / `button` / `field` / `markdown-renderer` 里那些 `link` 变体的常驻蓝**不算违规**。
**边界**:只有「一段可点开的文字」享受这条例外。
❌ 一整张卡(边框 + 底色 + 文字三件套)全上 info 蓝不在例外内 —— 那不是链接,是给静态内容上了 accent;
实测仍在的一处:`session/renderer/lib/components/github-device-flow-modal.tsx:320`,标的是一枚静态配对码。

**③-b 常驻导航的选中项不用 live 蓝(2026-09-22 裁决)。**
底部 tab 栏、侧栏这类**常驻**导航,永远有且只有一项是选中的 ⇒ 蓝会**一直亮着**。
一个永远亮的信号不是信号:「页面上没有活着的东西,页面就没有蓝」这句话立刻不成立,
而真正在跑的那件事(流式、安装进度、正在连)就再也抢不到眼睛。
⇒ 常驻导航的选中态用**前景色 + 字重**表达(实测 `layouts/MainLayout.tsx` 底部 tab:
选中 `var(--text-primary)` + 600,未选 `var(--text-tertiary)` + 500)。
⚠️ 这条与上表的 `--state-tint-selected → var(--live)` **不矛盾**:
那条管的是**列表 / 菜单里的当前项**(选中是瞬时的、会跟着你走),这条管的是常驻导航(选中是常态)。
同一个词「selected」在两种控件里是两个东西 —— 判断标准是「它会不会一直亮着」。

**primary = ink.** design.md 的 chrome 是墨色,主按钮是前景/背景反相。
会话页 `--primary-button-background` 从 `var(--jade-12)`(浅)/ `var(--jade-4)`(暗)改成
`var(--foreground)`,前景改 `var(--background)`;`--composer-accent-solid/-text` 从 jade 的 9/11
两阶改成 `var(--live)`(滑杆的「当前档」是 live)。
主 app 的 `--primary` / `--accent` 本来就是黑白,只改写成同族 oklch。
⚠️ 这条推翻了 §7 表里「`primary` = 会话页皮肤的品牌实色(jade)」那一行的**取值**,映射结构不变。

**hairline = 前景 10%.** `--border` / `--border-color` 从 `#ffffff0e`(alpha≈5.5%)提到
`color-mix(in oklab, var(--fg) 10%, transparent)`。
⚠️ `tokens.css` 自己的注释早就写着「实测对比度约 1.05:1,对低视力用户等于不存在,
而 WCAG 1.4.11 对控件边界要求 3:1」,而当时的处置是只在 `prefers-contrast: more` 下提到 0.55,
**常态值原封不动**。现在常态就是 10%,`prefers-contrast` 那档改成「在 10% 之上再往上加」。
⚠️ 它与 §6 必须一起改:线变明显之后,那些「border + shadow 共存」的边会更刺眼。

**玻璃拟态已退役(桌面)。** 手机壳例外:2026-10-26 用户裁决全线渐变底 + 玻璃底栏 / 搜索框 / 气泡(§0.3,#446),消费咕咕页那组 `--ta-glass*`,不复活下面三个 `--glass-*`。
design.md 的 Reject 列表逐字点名 glass 与 ornamental shadows
(「The paper here is a structural register, never a texture」)。
`--glass-bg` / `--glass-border` / `--shadow-glass` 三个名字**保留**,取值换成实色面 + 同一条 hairline + 唯一那档 lift。
✅ **消费点也清了(2026-09-22,#6105)**:`layouts/MainLayout.tsx` 的底部 tab 栏从「悬浮玻璃岛」改回
贴边实心条 —— `borderRadius: var(--radius-page)`(0,满宽带必方)、无 `backdropFilter`、无投影,
与主体只由一条 `border-top` 分界。⇒ 三个 `--glass-*` 现在是 0 消费者的无害别名,可以在下一次清扫时删名。
⚠️ 这条与维护者 2026-09-05 定的「Web3/Liquid Glass 方向」直接冲突 ——
按 2026-09-22 的新裁决执行(design.md 为尺子),原定调**在此记录为已被覆盖**,
⚠️ **`AGENTS.md` 那句还没同步(2026-09-22 复核仍在)**:第 66 行写着
「底部 tab **任务/对话/联系人/发现/我的**(玻璃岛 `--glass-*`;维护者 2026-09-05 拍板…)」。
代码已经改回贴边实心条,而 `AGENTS.md` 是每个 agent 冷启动都会读的那份 —— 留着它等于
每次都给下一个人发一条过期指令。⇒ **这条要单独改 `AGENTS.md`**(不在本文可改范围内,列为交接项)。

---

## 6.5 遮罩：与投影同类，明暗两侧都用中性黑（2026-09-22 裁决，Refs #6103）

**规定**:模态遮罩**两个主题都用中性黑,只改不透明度**。
❌ 不用前景色掺透明(`color-mix(in oklab, var(--fg) N%, transparent)`),
即便 §6.4 ① 说「叠色一条式子通吃明暗两侧」——**遮罩不是叠色**。

**为什么**:遮罩和投影是同一类东西 —— **压下来的一层暗**,不是一个面的颜色。
§6.4 ① 那条「中性必须在 `--tint` 族里」管的是**面色与字色**;
投影早就按同一条判断留在中性黑上(`tokens.css` 的 `@@@one-knob` 段:「投影是投下来的光,不是一个面的颜色
⇒ 它不在中性族里」),遮罩跟投影同一格。
换成前景色掺透明的后果是可算的:暗色主题下 `--fg` 近白 ⇒ 遮罩变成**一层白纱**,
模态反而比它盖住的页面更亮,「压下去」这件事整个反向。
design.md 那条「never write `#fff` / `bg-white` / `text-black`」因此不构成反例。

**建议(尚未落地):遮罩该有自己的语义 token。** 现在它散成四套写法,不透明度四个值:

| 落点 | 现在写的是什么 |
|---|---|
| `styles/tokens.css:402-404 / 656-658` | `--bg-overlay-soft / -modal / -strong`(暗 0.28/0.56/0.35,浅 0.18/0.44/0.28)—— **已经是语义 token**,消费者是主 app 的几处二次封装 |
| `session/renderer/lib/ui/dialog.tsx` · `sheet.tsx` | 字面 Tailwind 类 `bg-black/30`,**不消费**上面那族 |
| `packages/session-ui/.../dialog/dialog.css.ts` | 字面 `rgba(0, 0, 0, 0.4)`,文件注释自陈「留作规格增补建议」 |
| `components/ImagePreviewProvider.tsx` | 字面 `rgba(0,0,0,0.82)` |

⇒ 同一件事(压暗底下那一层)现在**四处各写各的数字**:0.30 / 0.40 / 0.82,外加语义那族自己的三档。
这与 §6.0 把 13 档具名投影并成一档 lift 是同一类收敛,只是还没做。
❌ 别顺手「各自改成 0.4」——那是把四个数字改成一个数字,定义处仍然是四处;要的是**一个名字**。
**判据**:无。当前连「遮罩一共有几种」都只能靠人工 grep 数出来。

---

## 6.6 列表分组用密度面板，不用逐行卡、不用逐行分隔线（2026-09-22 立条，Refs #6107 / #6108）

**规定**:一组同类行(日志、设置项、自动化记录、集成项、子代理…)的分组表达是
**一块密度面板**:`bg-foreground/[0.02]`(暗色 `/[0.03]`;更实的一档用 `bg-background-1`),
配 `space-y-*` / `gap-*` 的节奏与 `hover:bg-row-hover` 的填色。
❌ 不给每一行配一张带框卡;❌ 不给每一行配一条发丝线;❌ 不给分组画外框。

**为什么单立一条**:design.md 的 line budget 里已经有「Rows breathe on rhythm and a hover fill,
not on dividers」和「Prefer a change of density over a box」,但它们是**两条否定**,
而实现层每次都要重新发明一个肯定形式。本轮实测:**C 区 3 条清单条目覆盖 9 个落点,D 区另有 4 条**
(逐行线 → `space-y`、带框卡 → 去 border 只留底色、`border-dashed` → 实线 + 密度底),
同一个答案在两个区被独立发明了十几遍 ⇒ 它够格成为一条**显式条文**,而不是每次从两条禁令里现推一遍。

**「空槽位」的密度档**:原来用 `border-dashed` 表示「这里还没填东西」。虚线不在词汇表里
(design.md 的线只有 hairline 一种),而「空」这件事本来就该由**密度**说,不该由线型说。
⇒ 现在写作 `border border-foreground/10 bg-foreground/[0.02] dark:bg-foreground/[0.03]` ——
一条正常 hairline + 最低那一档底色。实测落点:`settings/components/IntegrationDetailSidebar.tsx`、
`settings/components/GitHubAccountsSection.tsx`、`integrations/components/github-auth-disclaimer.tsx`。

**判据**:无。这条判不了 —— 「这一组行该不该有线」在源码文本层与「这是一张独立内容卡」同形
(同 §5.3 末尾 `rounded-full` 那条的处境)。所以它是**评审时的对照条文**,不是闸。
⚠️ 主 renderer 侧仍有两处 `border-dashed`(`components/agentsettings/agentSettingsStyles.ts` 的两个空态),
本轮未改;`components/assistant-ui/thread.aui.tsx` 那处是**拖拽态**的临时虚线,不在本条范围内
(它表达的是「松手可以放这里」,不是「这里是空的」)。

---

## 7. shadcn 语义名 → 会话页皮肤 token 映射表

会话页 `@theme` 现已登记全部 19 个 shadcn 语义色。**每条都是 `var(会话页皮肤-token, gugu-token)` 两段**——
第二段不是装饰：`#2804` 拆掉 shadow root 后两张样式表在同一个 `<head>`，会话页那张后注入 ⇒
同名 utility **全文档赢**，包括咕咕自己的节点；而会话页皮肤 token 只在 `.emlight`/`.emdark` 下有定义。
单段写法会让咕咕 `pages/` 里的 `bg-card` / `bg-muted` / `bg-accent` 解析成 `transparent`。

| shadcn 语义名 | 会话页皮肤段（`.emlight`/`.emdark` 内） | 咕咕兜底段 | 备注 |
|---|---|---|---|
| `background` | `--background` | *(无，既有缺陷)* | 见 §8 |
| `foreground` | `--foreground` | *(无，既有缺陷)* | 见 §8 |
| `card` | `--background-1` | `--card` | 比页底高一阶的表面 |
| `card-foreground` | `--foreground` | `--text-primary` | |
| `popover` | `--background-quaternary` | `--popover` | 跟随 `popover.tsx:42` / `dropdown-menu.tsx:46` 既有底色 |
| `popover-foreground` | `--foreground` | `--text-primary` | |
| `primary` | `--primary-button-background` | `--primary` | ~~会话页皮肤的品牌实色（jade）~~ → **墨色**(`var(--foreground)`),见 §6.4;映射结构不变 |
| `primary-foreground` | `--primary-button-foreground` | `--primary-fg` | |
| `secondary` | `--background-2` | `--muted` | 跟随 `button.tsx` 的 secondary 变体 |
| `secondary-foreground` | `--foreground-muted` | `--text-primary` | 同上 |
| `muted` | `--background-2` | `--muted` | shadcn 默认主题里 muted 与 secondary 本就同值 |
| `muted-foreground` | `--foreground-muted` | `--muted-fg` | |
| `accent` | `--background-quaternary-1` | `--hover` | **不是**品牌色；见下方说明 |
| `accent-foreground` | `--foreground` | `--text-primary` | |
| `destructive` | `--red-9` | `--danger` | 会话页皮肤的语义层没有「实心 destructive 表面」这一格；Radix step 9 就是承担实心填充的那一步 |
| `destructive-foreground` | `--color-white` | `#fff`（字面值） | **本组唯一不是两段式的一条**，见下方说明 |
| `border` | `--border` | *(无，既有缺陷)* | 见 §8 |
| `input` | `--border` | `--border-color` | shadcn 的 input 是输入框**边框**色，不是背景 |
| `ring` | `--border-primary` | `--primary` | ❌ 不用 `--ring`：见下方说明 |

**`accent` 为什么不取 `--hover`（与 `--color-row-hover` 不同源）**：`--hover` 是咕咕皮肤 2.4% 的半透明叠加，
给长列表 hover 刚好；而 shadcn 组件把 `bg-accent` 当**选中/高亮项**的实底（Select/Menu/Command 的当前项），
2.4% 叠加在那个角色上等于没高亮。会话页自己的菜单项用的就是不透明的 `--background-quaternary-1`。
本映射维持不变：选中/高亮项与列表 hover 承担不同角色，不强行同源。

**`destructive-foreground` 为什么不是两段式**：两段式存在的理由是「会话页皮肤 token 只在 `.emlight`/`.emdark` 下有定义，
咕咕作用域取不到」。而 `--color-white` 不属于任何一边的主题块——它是 Tailwind v4 **默认主题**自带的色标，
被引用时会连同 `:root{--color-white:#fff}` 一起编译进**每一张**用到它的表。
实测（独立构建的会话页样式表，不含咕咕那张）：`--color-white:#fff` 命中 1 处，
`.text-destructive-foreground{color:var(--color-white)}` ⇒ 脱离咕咕样式表也成立。
⚠️ **但不能据此推出「单段也没事」**：它成立靠的是 Tailwind 默认主题这条*另一个*机制，不是靠其余 15 条的兜底机制。
末段 `#fff` 是那条机制万一被掐断（比如有人用 `--color-*: initial` 清空默认色标）时的最后一跳。
该豁免在判据里写成**换一条断言**而不是跳过断言——跳过的话，改回裸单段不会有任何东西变红。

**`ring` 为什么不取 `--ring`**：旧 `.emlight` 与 `.emdark` 声明都曾是 `hsl(0 0% 3.9%)`（近黑，
暗色下等于隐形），且会话页主题声明在运行时产品源码中有 **0 个 `var(--ring)` 消费者**；同一把尺子的阳性对照
`var(--radius)` 有真实 TSX/CSS 消费。那是 shadcn neutral 基底的浅色值被复制进暗色块留下的死声明，现已删除。
焦点强调色继续走既有口径 `--color-ring` → `--border-primary`；真 Chromium 判据读取已编译的
`ring-1 ring-border-primary` 的 computed `box-shadow` / `--tw-ring-color`，确保删除主题死声明没有影响
Tailwind utility。`--color-ring` 位于 `@theme inline`，是编译期映射而非 DOM 运行时变量；它到 `--border-primary`
的结构由 `shadcn-token-bridge-3334` 判据钉住，不能伪装成 computed-style 读数。

---

## 8. 已知缺口

0. **本文 §5/§6/§10 声明过的机器判据,在 2026-09-11 被一次删掉了 7 个文件 1814 行（Refs #6104 查证，#6103 补全）。**
   `f7332ce85`「slim: 2026-09-11 瘦身集成(product spec ≤50%、单测 ≤70%)」一次删掉:

   | 文件 | 行数 | 本文哪里在引用它 |
   |---|---|---|
   | `…/tests/visual-scale-guard-3334.test.ts` | 172 | §2 字阶上限、§5 圆角禁令、§6 阴影上限 |
   | `…/tests/visual-scale-guard.ts` | 265 | 同上(实现) |
   | `…/tests/vanilla-extract-visual-guard-3334.test.ts` | 324 | §6.1 的 vanilla-extract 那半边(`MAX_RADIUS_PX = 8`) |
   | `…/tests/vanilla-extract-visual-guard.ts` | 549 | 同上(实现) |
   | `…/tests/shadcn-token-bridge-3334.test.ts` | 98 | §10「19 个语义名齐全 + 两段结构」 |
   | `tests/unit/scripts/uiVisualSpecGeometryDebt.test.ts` | 232 | §2.1 那两条**可达性阳控** |
   | `…/tests/browser/font-unification-3334.test.tsx` | 174 | §8 条 2「宿主侧能判的那一半」、§10「三个面 computed font-family 相等」 |

   > ⚠️ **最后一行是 2026-09-22 补上的 —— 本条自己漏了一个（Refs #6103）。**
   > 上一版这张表写的是「三条判据 / 六个文件 / 1600+ 行」,而 `git show --stat f7332ce85` 读出来是
   > **7 个文件 1814 行**:`font-unification-3334.test.tsx` 也在同一次删除里,而本文
   > §8 条 2 与 §10 都还在按「它存在」写。
   > 一份「判据表失真了」的更正本身又漏了一条,说明**查证不能只查自己记得的那几个名字** ——
   > 该查的是那次提交删了什么,不是那次提交有没有删我想到的东西。
   > ⇒ 补一条做法:以后核这类事,先 `git show --stat <commit> -- <目录>` 拿全集,再逐条回填。

   ⇒ §10 的判据表里那几行「✔ 在 CI」**在 2026-09-11 之后就不成立了**,而本文一直这么写着。
   本轮没有重建它们(不在 token 层的范围内,且重建 1800+ 行判据该有自己的批次与验收),
   只把这件事记在这里并在 §10 就地标注。
   ⚠️ 后果:字阶上限、圆角禁令(含 `rounded-2xl/3xl`)、阴影上限、两段式语义桥结构、
   三个面 computed font-family 相等,这**五格**当前**只有纸面约定,没有机器判据**。
   新增的 `radiusScaleParity` 只覆盖「三张表是同一张表」。

0.1 **四门(typecheck / lint / test:unit)不编译任何 CSS。**
   本轮实撞:`tokens.css` 的一处注释被 `*/` 提前闭合(整个文件 postcss 解析失败),
   **三门全绿**,一个都没照出来。照出来的是 `--project session-browser`
   (12 个测试文件全部 collection 失败,报 `Failed to fetch dynamically imported module: …/tokens.css`)
   与 `pnpm build:renderer`。
   ⇒ **只改 CSS 的批次,四门绿不构成「能编」的读数**;必须另跑 `build:renderer`(和 session-browser)。

0.2 **本轮只把 token 定义层改到了新合同,以下三块的中性仍在族外。**
   - 会话页 `.emlight` / `.emdark` 自带的 Radix display-p3 原始色阶(`--neutral-1..12` 等):
     在咕咕宿主里它们**被皮肤桥整族接到 `--tint` 族**(`EmdashSessionFrame.tsx` 的 `--neutral-*` 映射),
     所以产品里不成立;**脱开宿主**(独立会话页 / storybook)时仍是 Radix 自己的色相。
   - 顾客面板与中台(现均在本仓之外)的 shadcn oklch 色板(H 247–265,`--tint` 是 268):
     本轮只统一了它们的圆角与 reduced-motion,颜色没动。
   - `packages/session-chat-ui` 的 transcript 色板:本轮只并了 mention chip 的 per-kind 分色。
   这三块要不要一起进 `--tint`,是维护者的一格(它们分别涉及 Radix 阶梯的整族重算、
   两个中台的整体换肤、以及 transcript 的测量输入),不自签。

1. **CJK 跨平台落点未测（Refs #3334）。** 当前判据只钉三条字体栈的声明；Windows 与 Android 的运行时落点
   没有产品读数。详见 §1.3。

2. **`measure() === offsetHeight` 防线不存在（#3369）。**
   `packages/session-chat-ui/src/tests/contract.tsx` 提供了 `renderAndMeasureUnit` 夹具，
   但**没有任何消费者**（阳性对照：同法查 `generateMockTranscript` 能查到真实消费者）。
   实测把 `DEFAULT_CONFIG.roles.body.lineHeight` 由 20 改成 21 后，
   `session-chat-ui` + `session-chat-ui-browser` 两个 project **232 条测试仍然全绿**。
   ⇒ 任何未来改动 transcript 字体/字号/行高的车道，**目前没有判据接着它**。
   本车道不许动 session-chat-ui 引擎，故只报告不修。
   > ⚠️ **原文写的「宿主侧能判的那一半已补在 `tests/browser/font-unification-3334.test.tsx`」已经不成立(2026-09-22 更正)。**
   > 那个文件在 2026-09-11 与另外六个一起被 `f7332ce85` 删了(见条 0)。
   > ⇒ 现在连**宿主侧那一半**也没有判据:三个面的 computed font-family 相不相等,当前没有任何东西在量。

3. ~~**两套圆角刻度的 `lg` 不等值（Refs #3334）。**~~ ✅ **2026-09-03 关闭。**

   > **关闭方式:删档,不是改值。** `radiusLg`(0.625rem / 10px) 这一档从 `packages/session-ui`
   > 与 `packages/session-chat-ui` 两个包的 token 契约里**整体删除**,全部消费者收敛到
   > `radiusMd`(0.5rem / 8px) —— 与 renderer 的 `--radius` 等值,也与主 app 的 `Button`
   > (`rounded-[var(--r,8px)]`) 等值。
   >
   > ❌ **没有把 `radiusLg` 改成 0.5rem**:那会留下两个名字同一个取值,正是「11/12/13 三档
   > 干一档的事」在圆角上的翻版。消灭一档的办法是删掉它,不是把它挪到别的档上。
   >
   > ⚠️ **本条原文低估了盘子。** 它写的是 `control` / `card` / `update-card` 三处;
   > 真实消费者含 `session-chat-ui` 的 5 处、两个包的 sprinkles `lg` 档、`card` 的 `lg` 变体、
   > 宿主 CSS 里三份逐条列举的 `--chat-radius-lg`,以及 **15 处 `rounded="lg"` 属性写法**——
   > 最后这 15 处 grep 抓不到(只认 `borderRadius: 'lg'` 的形态),是 **TypeScript 报出来的**。
   > ⇒ 删 token 时把编译器当仪器,别把 grep 的零命中当盘子已清。

   历史读数(仍然有效,记录当时的分叉形态):renderer 的 `--radius-lg = --radius = 0.5rem`，
   而 `packages/session-ui` 的 `radiusLg = 0.625rem`（`radiusMd` 才等于 0.5rem）。
   P2 把 composer 与浮层收敛到 `radiusMd`，但 `control` / `card` / `update-card` 三处仍用 10px。
   `vanilla-extract-visual-guard` 的门槛当时因此设在「比 `radiusLg` 还大」；
   关闭后门槛降到 `MAX_RADIUS_PX = 8`，即「比基准圆角还大」。

   **`packages/session-chat-ui` 是同一条分叉的第三份，本条原文没点它的名（P3 第四批实测补上）。**
   它自己的 `radiusLg` 同样是 `0.625rem`，且那是 transcript 的**面级圆角**——真 Chromium computed
   style 读到用户卡片四角 `10px`；同一把尺子在同一张卡片里读到附件缩略图是 `8px`（`radiusMd`）。
   源码层的消费者共 5 处：用户卡片、代码块、表格、mermaid、diff。
   ⇒ **不能只把用户卡片改成 8px**：那不是收敛，是在包内造第四种刻度——卡片 8px 而它自己
   包着的代码块仍 10px。要动就 5 处一起动，属于 token 级改写，该有自己的批次与验收。
   （**2026-09-03 就是那一批**：5 处连同 token 一起动，没有留下中间态。）

   **那 5 处里的 3 处（代码块 / 表格 / mermaid）位于 markdown 的块根，P3 第五批实测补齐。**
   真 Chromium computed style，亮暗双主题 × 420/180 两档宽度 × 每种 block 的全部状态
   （code 未高亮 / 已高亮 / 超宽，mermaid 占位 / 错误，table 容得下 / 超宽）：三者在块根上
   各有 **1 个带边框元素、4 条边、10px 圆角、0 个填色面、0 个投影**，逐项不随主题或宽度变化。
   ⇒ 它们不是「自造卡片」，是 agent 正文与内嵌逐字产物之间的边界，与第四批保留用户气泡
   同一条理由（只在容器承载意义的地方留容器）。本批不动它们，判据钉在
   `packages/session-chat-ui/src/tests/markdown-rows.contract.test.tsx`，两个方向都能红：
   加卡片红、剥掉这层面也红。

   > ⚠️ **开这一批的源码文本扫描把这三处读成 `border=0`，并且它的阳性对照不可能发现这一点。**
   > 那把尺子的模式只认「带引号的数字字面量」开头的边框值，而本仓写的是模板串
   > （`` border: `1px solid ${vars.border}` ``）或 token（`borderWidth: cardVars.cardBorder`）。
   > 它选的阳性对照是 `execute` —— 一个**已知为零**的对象：它读 0 是对的，所以它无法暴露
   > 这把尺子**因为错误的理由也读 0**。⇒ **阳性对照必须选已知非零的那个**；
   > 用已知为零的对象作对照，等于没有对照。本节的取值以真 Chromium computed style 为准。

   **同时记下一条尚未收敛的重复**：`code` / `mermaid` / `table` 各自**手抄了一遍**同一条面公式
   （`1px solid var(--border)` + `radiusLg`），三份定义处。这与 §6.1 把 `popupShadowMd` 与三份
   手抄合并成一档是同一类问题，但合并属于 token 级改写；只并其中一部分同样会造出第四种刻度，
   所以与本缺口一起留给它自己的批次 —— ✅ **2026-09-03 收尾时并了**：那条公式
   （`1px solid var(--border)` + 基准圆角）现在只有一份定义，在
   `packages/session-chat-ui/src/styles/effects.css.ts` 的 `artifactSurface`，
   三个块 spread 它。名字取自契约测试里已有的领域词「artifact surface」。

   > ⚠️ **导出的是规则对象，不是 class —— 这一点是被实测逼出来的。**
   > 先用 `style([artifactSurface, {…}])` 组合过一版，三个块全瞎了（mermaid 契约测试报
   > `no mermaid wrapper: expected +0 to be 1`）。根因在 vanilla-extract 源码：
   > `composeStylesIntoSet(set, ...className.trim().split(' '))` —— 组合的导出是**空格分隔
   > 的多个类名**，而这三个文件都用 `globalStyle(\`${x} svg\`)` 拿它拼选择器，
   > `"a b"` 一插进去就变成后代选择器 `.a .b svg`，再也匹配不到任何东西。
   > ⇒ **谁的 class 会被拼进选择器，谁就不能用 composition。**
   >
   > 可达性有证：把 `artifactSurface` 的圆角临时改成 `radiusXl`，24 条契约测试红，
   > 且 `code` / `mermaid` / `table` **三种块全部**报 `expected 14 to be 8` ——
   > 这一份定义确实到达了三处，不是三处各自留着旧值恰好一样。

5. **markdown 块的裁剪来自 `content-visibility`，而不是 `overflow`（P3 第五批实测）。**
   `packages/session-chat-ui/src/components/engine/block-frame.css.ts` 的 `pblock` 写着
   `overflow: visible`，读起来像「这个 frame 不裁剪」。真正拦住 measure-vs-render 瞬时失配的是
   `content-visibility: auto` 施加的 paint containment。实测（16px skew，富 markdown fixture）：
   保持原样 **10 个候选 0 个可命中**；同一条 fixture 上强制 `content-visibility: visible` ⇒
   **10 个候选 10 个可命中**。

   `code` / `mermaid` / `table` 不依赖它——三者各自用 inset 铺满 frame 的面自己裁；
   **只有 `prose` 靠它**，而 prose 是 transcript 里最常见的 block。

   ⚠️ **这件事任何样式层读数都看不见**：`getComputedStyle(el).contain` 在这里读到 `none`。
   ⇒ 有人为性能调整这个属性时会连带改掉裁剪，而没有任何东西会红。因此判据用 hit-test 读，
   并把「摘掉该属性后同一条 fixture 必须逃逸」写成判据自身的对照。
   ❌ **没有**给 `pblock` 补 `overflow: hidden`：量下来它不需要，而「补上是空操作」这个判断
   一次读数给不出（多状态才算数，见 #3458 与第四批）。缺的是判据不是规则。

4. **6 处 `bg-background` 在咕咕作用域透明（#3370）。**
   `bg-background` / `text-foreground` / `border-border` 是 #3334 之前就有的**单段**声明。实测（真 Chromium，
   两张样式表同 head）：
   会话页样式表注入后，咕咕作用域的 `bg-background` 解析成 `rgba(0, 0, 0, 0)` —— 即
   **咕咕主 renderer 里 6 处 `bg-background` 在会话页被打开过之后会变透明**。
   本次不修（它会改变咕咕的长相），但判据里显式跳过并写明理由，
   不假装它是绿的。修法与本次 16 条一致：补上兜底段。

6. **焦点可供性（已由 #7333 偿还:全局只清鼠标焦点的环,键盘 `:focus-visible` 统一画环,见 §0.0）。** 原条文:全局 `*:focus-visible{outline:none}` 是待偿债务（2026-09-22 裁决，Refs #6108）。

   两处声明当前**互相打架**,实测都还在:

   | 位置 | 写的是什么 |
   |---|---|
   | `apps/desktop/src/styles/tokens.css:819-820` | `*:focus, *:focus-visible { outline: none; }`,注释是维护者 2026-07-24 的「焦点环全废…❌ 任何组件私自加 outline/ring」 |
   | `session/renderer/features/extensions/panel/extensions-panel.css:65 / :237` | `.xp-segment-btn:focus-visible` 与 `.xp-card-hit:focus-visible` 各自 `outline: 1px solid var(--border-primary)` |

   **裁决:局部恢复是对的。** 键盘用户需要知道焦点在哪 —— 2026-07-24 那条裁决的原话是
   「输入框光标即焦点指示」,那对**输入框**成立,对分段按钮、卡片热区这类**没有光标的可聚焦元素**不成立。
   一个 `:focus-visible` 只在键盘导航时出现,不会影响鼠标用户看到的样子 ⇒ 它不是「私自加环」,
   是补上一个整条全局规则一刀切掉的可供性。

   **全局那条 `outline: none` 记为待偿,本轮不动。**
   为什么不顺手删:它是 2026-07-24 的维护者裁决,推翻它要维护者自己点头(本轮只拿到「局部恢复是对的」这半句);
   而且 `*:focus` 这条**不分层**的重置盖住的是全仓每一个可聚焦元素,删掉会在同一次改动里
   改变几十处未知控件的长相 —— 那是一次独立的可访问性批次,该有自己的票、自己的截图验收。
   ⇒ **需单独立票**:范围是「把全局清零换成 `:focus-visible` 上的统一焦点表达」,
   验收要覆盖键盘 tab 全流程 + 双主题。
   ⚠️ 在那之前,❌ 别照着 `tokens.css` 那句注释去删别处的局部恢复 —— 那句注释的适用面已经被本条收窄了。

---

## 9. 原语与依赖边界

- 通用控件（alert/sheet/switch/tabs/toggle/select…）唯一实现在渲染层的 shadcn(`base-vega`) 组件目录；
  ❌ 在 `packages/session-ui` 再造 vanilla-extract 孪生体（见 `session-ui` spec）。
- **`radix-ui` = 记有界例外**（维护者已定），**已落地**：边界是 `.eslintrc.cjs` 里一条
  base `no-restricted-imports`，只放行 `apps/desktop/src/session/renderer/lib/ui/assistant-ui/**`，
  目录外出现 `radix-ui` / `@radix-ui/*` 即 `pnpm lint` 红。双向变异自测见 §10。
  ⚠️ 用的是 **base** 规则而不是 `@typescript-eslint/no-restricted-imports`：后者已被 task renderer
  的 ACP barrel 闸占用，而 eslint 的 overrides 对同名规则是**替换**不是合并——写同一个名字会让
  两条闸互相顶掉，且不报任何错。
- **本轮实测：vendored 目录内 radix import 数 = 0。** 上游 `TooltipIconButton` 唯一那处
  `Slot.Slottable` 只在 `asChild` 组合下有意义，纯展示适配里不需要 ⇒ 例外记着但没被用掉。
  ❌ 别把这读成「所以不需要这条闸」——它守的是下一次 `shadcn add` 拉进来的东西。
- 颜色只能来自 CSS 变量；❌ `bg-gray-*` / `bg-white` / 硬编码色值。

---

## 10. 本文档的判据

规格不是口头约定。当前已有机器判据的条目：

> ⚠️ **本表在 2026-09-11 之后失真过一段时间,2026-09-22 重新逐行核过一遍(Refs #6103)。**
> 两件事同时发生过:① `f7332ce85` 一次删掉五条判据、七个文件(见 §8 条 0),而本表一直写着它们「✔ 在 CI」;
> ② 反过来,`5ce49e368`(2026-09-19)把两个 browser project 接进了 CI,而本表还写着它们 ✘。
> ⇒ **一张判据表会朝两个方向失真**,而「写着有其实没有」与「写着没有其实有」造成的伤害不对称:
> 前者让人以为守住了,后者只是让人多跑一遍。所以核的时候两头都要核,❌ 别只找变差的那一半。
> 下面 **🗑️ 已删** 一律指 `f7332ce85`;✔/✘ 一律按 `.github/workflows/ci.yml` 当前内容判定。

| 条目 | 判据 | 在 CI |
|---|---|---|
| 19 个语义名齐全 + 两段结构 | ~~`tests/shadcn-token-bridge-3334.test.ts`~~ | 🗑️ **已删** |
| 语义名解析到正确 token（双作用域 × 双主题） | `tests/browser/design-tokens-3334.test.tsx` | ✔（`session-browser`，见下） |
| 实底可见（非透明、非纯黑） | 同上 | ✔ |
| 三个面 computed font-family 相等 | ~~`tests/browser/font-unification-3334.test.tsx`~~ | 🗑️ **已删**（2026-09-22 补记，本表此前漏标） |
| 编译后的 ring utility computed color 仍走 `--border-primary` | `tests/browser/design-tokens-3334.test.tsx` | ✔ |
| session-chat-ui 内禁硬编码几何**（只管 Tailwind class 串）** | `scripts/checks/check-session-chat-ui-geometry.mjs` | ✔（`pnpm lint`，量程见下） |
| markdown 五件的装饰口径（两种口径 × 全部状态 × 双主题 × 双宽度） | `packages/session-chat-ui/src/tests/markdown-rows.contract.test.tsx` | ✔（`session-chat-ui-browser`） |
| markdown 块的裁剪机制（hit-test，自带「摘掉它必须逃逸」的对照） | 同上 | ✔ |
| 表格预留行高 == 渲染行高，且两侧都跟随宿主 `roles.body.lineHeight` | 同上 | ✔ |
| 字阶上限 / 圆角 / 阴影（会话页 renderer） | ~~`tests/visual-scale-guard-3334.test.ts`~~ | 🗑️ **已删** |
| 圆角 / 阴影（`packages/session-ui` 的 vanilla-extract 那半边） | ~~`tests/vanilla-extract-visual-guard-3334.test.ts`~~ | 🗑️ **已删** |
| §2.1 两条可达性阳控 | ~~`tests/unit/scripts/uiVisualSpecGeometryDebt.test.ts`~~ | 🗑️ **已删** |
| **圆角三张表是同一张表**(见 §5.2，**不含 surface 这一档**) | `scripts/checks/check-ui-visual-spec.mts` 的 `radiusScaleParity` | ✔（`pnpm lint`） |
| radix 只在 vendored assistant-ui 目录内 | `.eslintrc.cjs` 的 `no-restricted-imports` | ✔（`pnpm lint`） |
| task/main/assistant-ui 的 0.5 步进与几何债计数双向棘轮 | `scripts/checks/check-ui-visual-spec.mts` | ✔（`pnpm lint`） |
| **每个 `.css` 能被 postcss 解析**（补的是「四门不读 CSS」这个洞，见本节末尾的变异自测） | `scripts/checks/check-css-parses.mjs` | ✔（`pnpm lint`，2026-09-22 新增） |
| 12 / 14 / 半像素字号硬闸（一处都不许有） | 同上 | ✔（`pnpm lint`，扫描面见下） |
| task renderer 保持 desktop-only（移动壳引用为 0） | 同上 | ✔（`pnpm lint`） |
| 「在等」只有一个样子（product spec）：手转图标 `animate-spin` 按文件只减不增，新写的一律用 `@/lib/loading/LoadingIndicator`（行内 `size="inline"`） | 同上的 `handRotatedSpinners`（基线在 `ui-visual-spec-baseline.json`，扫主 renderer + 会话页 + session-ui + session-chat-ui） | ✔（`pnpm lint`，2026-09-24 新增，Refs #6264） |

**两个 browser project 已经在 CI 里了(2026-09-19,`5ce49e368`)。**
`ci.yml` 的 `session-db` job 有一步 `Browser projects (Vitest browser mode)` 跑 `pnpm test:browser`
(= `--project session-browser --project session-chat-ui-browser`),前一步 `playwright install chromium` 备浏览器。
⇒ 本表里所有 computed-style 判据现在都是**门**,不再只是「产品层证据」。

**三条判据的量程，写下来免得下次又把 0 读成合格：**

| 判据 | 它看得见什么 | ❌ 它看不见什么 |
|---|---|---|
| `check-ui-visual-spec.mts` 的**硬闸**(12 / 14 / 半像素) | 五个扫描根:主 renderer、`…/session/renderer`、`…/components/assistant-ui`、`packages/session-ui/src`、**`packages/session-chat-ui/src`**(2026-09-22 新接入)。正则吃得下 `fontSize: '12px'` 这种 CSS-in-JS 写法 | 中台与顾客面板已拆出本仓,不在本仓任何一个根里 |
| 同文件的**棘轮**(半步间距 / 内联字号 / 内联圆角 / 裸 button / 内联 style) | 前四个根,各自一档独立基线 | **`packages/session-chat-ui/src` 不在棘轮里** —— 硬闸接了它,棘轮没接 ⇒ 本包里「不在字阶上但不犯硬闸」的值(9px / 10px / 一批 11px)没有东西判 |
| `check-session-chat-ui-geometry.mjs` | `packages/session-chat-ui/src` 里 JSX 的 `class` / `className` / `classList` **字符串**与 CSS `@apply` | **vanilla-extract 的对象字面量**(`style({ fontSize: '12px' })`)——本包几乎全是这种写法,结构上抓不到 |
| `radiusScaleParity` | 两张 Tailwind 表的**七档数字别名** + `tokens.css` 的九档语义表 | 两张 Tailwind 表里的 `surface` 档(见 §5.2) |

⇒ 读这张表的方法:**一条判据报 0,先问它的主语是谁。**
2026-09-22 之前 `packages/session-chat-ui` 的 12px 一直是 0 违规,而那个 0 的主语根本不包含这个包
—— 与 §6.3 末尾那条「`visual-scale-guard` 报的 0 违规是真的,只是那个 0 的主语不包含 vanilla-extract
那半边」一模一样,**同一个错误在同一份规格里犯了两次**。
这一格与 §2.2 是同一件事的两半:**先有角色名,闸才有意义** —— 本轮两件一起做了
(接入硬闸扫描面 + 立 `typeChrome*` 三档),❌ 别只做其中一件:
只接闸会逼出一批「为了不红而随便挪一档」的值,只立角色名则没有东西拦住下一个人绕开它。

**`.gg-type-page-title` / `.gg-type-display` 的两份定义没有判据**(见 §2)。
`radiusScaleParity` 对拍的是圆角,字阶这两份靠人工同步 —— 改一处不改另一处,四门全绿,
只有独立会话页构建会掉回继承字号,而那条路径没有截图验收。这一格明写为缺判据。

> **工程教训(与判据同等重要):四门曾经不编译任何 CSS。**
> `typecheck` / `lint` / `test:unit` 对 CSS 语法错误**全盲** —— §8 条 0.1 有实撞读数:
> `tokens.css` 一处注释被 `*/` 提前闭合、整个文件 postcss 解析失败,三门全绿。
> 病根不是谁粗心:那三门**根本不读 .css** —— tsc 不认识它,eslint 的解析器不管它,
> vitest 只在真挂样式的那几个 project 里才碰它。一个没人读的文件,写错了当然没人红。
>
> **2026-09-22 已补上闸(Refs #6103):`scripts/checks/check-css-parses.mjs`,挂在 `pnpm lint` 里。**
> 它只做一件事:把每个 `.css` 交给 postcss 真解析一遍,语法错就红并指到行列。
> ❌ 它不判样式对不对(那是 `check-ui-visual-spec` 的活),只判「这个文件还能不能被编译器读懂」。
> 扫描面跳过 `tests/fixtures/`:别的判据拿坏 CSS 当阳性对照,那是它们的样本不是产品文件。
>
> **变异自测(复刻真事故,变异不进提交):**
>
> | 变异 | 新闸 | 旧三门 |
> |---|---|---|
> | `tokens.css` 注释里写 `text-*/font-*`(把注释提前闭合) | 🔴 rc=1,指到 `tokens.css:481:42 Unknown word` | 🟢 `tsgo --noEmit` rc=0 |
> | 还原 | 🟢 33 个样式表全过 | 🟢 |
>
> 右边那一列是这条教训本身的证据:**同一个变异,新闸红、旧门绿** —— 补闸之前,这个洞是真的没人守。
>
> ⚠️ 闸补上了,但**它只判「能不能解析」,不判「解析出来对不对」**。
> `.css.ts`(vanilla-extract)走的是 TypeScript 那条路,由 tsc 覆盖,不在这道闸的量程里;
> 而「变量引用了一个不存在的名字」这类错误 postcss 照样点头 ⇒ 动了 CSS 仍然建议跑
> `pnpm build:renderer` 与 `pnpm exec vitest run --project session-browser`,
> 因为一个没被真正编译过的样式表,后面所有 computed-style 断言量的都是上一次的产物。

### `radiusScaleParity` 的变异自测（2026-09-22，Refs #6104）

**真实产品文件**,变异不进提交;每条先确认变异在 `git diff --numstat` 里看得见。
带「必须绿」的一组,因为一台只会变红的尺子和一台永远放行的尺子一样没用:

| 变异 | 结果 |
|---|---|
| M1 `tailwind.config.cjs` 的 `full` 改回 `'50%'` | 🔴 rc=1「`tailwind.config.cjs: full = 50%,另两张表是 9999px`」 |
| M2 会话页 `@theme` 删掉 `--radius-3xl` | 🔴 rc=1「`没有显式给出 3xl —— 不写就落回 Tailwind 默认…`」 |
| M3 `tokens.css` 的 `--radius-surface` 改回 16px(旧 `--radius-menu` 的值) | 🔴 rc=1「`--radius-surface = 16px,design.md shape 表是 10px`」 |
| M4 **必须绿**:`tailwind.config.cjs` 的 `md: '8px'` 改写成等价的 `'0.5rem'` | 🟢 rc=0(判的是几何,不是我写的那串字面量) |
| M5 **必须绿**:`tokens.css` 的 `--radius-page: 0` 写成 `0px` | 🟢 rc=0 |
| 还原三处 | 🟢 rc=0 |

> ⚠️ **M4 第一版是红的,而那是判据不合格、不是读数。** 第一版按源码文本逐字比,于是
> 「把 8px 改写成等价的 0.5rem」这条**本该绿**的控红了 —— 那台尺子量的是**拼写**,不是圆角。
> 修法是给判据加上单位归一(rem 按根字号 16px 折算,`0` 与 `0px` 同值),
> **不是**把 M4 从对照组里划掉。一条只会因为改写而变红的判据,会教下一个人忽略它。

> **可达性**:同一次 `pnpm lint` 的输出里能读到这条判据自己的行
> (`radius scale parity problems=0`),所以那个 0 不是「它没跑」。

三条视觉判据的变异自测（**真实产品文件**，变异不进提交）：

| 变异 | 结果 |
|---|---|
> ⚠️ 下面这两组表记录的是 **2026-09-03 当时**的读数;执行它们的两条判据已于 2026-09-11 被删
> (见 §8 条 0),所以这两组表现在是**历史记录**,不是「当前守得住」的证明。

| `thread-welcome.tsx` 拿掉 `gg-type-page-title` | 红 @ `lib/ui/assistant-ui/thread-welcome.tsx:44:31` [type-scale] |
| `dialog.tsx` 改回 `rounded-xl` | 红 @ `lib/ui/dialog.tsx:56:161` [radius] |
| `thread-scroll-to-bottom.tsx` 改回 `shadow-md` | 红 @ `lib/ui/assistant-ui/thread-scroll-to-bottom.tsx:45:66` [shadow] |
| 还原三处 | 14/14 绿 |

vanilla-extract 那条判据的变异自测（**真实产品文件**，变异不进提交），同样带「必须绿」的一组：

| 变异 | 结果 |
|---|---|
| composer 卡片投影改回 `0 1px 3px …, 0 4px 12px …` | 红 2 条（base + dragActive），都指到 `0 4px 12px` |
| composer 卡片圆角改回 `radiusXl` | 红 1 条 [radius] |
| 模型菜单叠回 `shadow-md` 公式 | 红 1 条 [shadow] @ `dropdown-menu.css.ts:21` |
| **必须绿**：把 `CARD_SHADOW` 换成另一种等价的 shadow-sm 写法 | 0 违规（判的是几何，不是我写的那串字面量） |
| 还原 | 0 违规 |

> ⚠️ 第三条第一次跑出来是「0 违规」，而当时我把它读成了「判据说合格」。实际是 `perl` 的缩进写错、
> **变异根本没落地** —— `rc≠0` 的两种（判据说不合格 / 判据没跑）在这里表现为同一个绿。
> 补上「改动必须在 `git diff` 里看得见」这一步之后才拿到真读数。表里这一行是重跑后的。

> ⚠️ 另一条自咬：把卡片投影抽成同文件的 `const CARD_SHADOW` 之后，判据对那两处的读数从
> 「合格」变成了**「未判定」**——即一次回退不会让任何东西变红，而两种情况下总数都显示 0 违规。
> 修法是让解析器跟进同文件的 `const` 字符串绑定，不是把常量改回去。判据看不见的地方等于没有判据。

radix 边界的变异自测是**双向**的——只验一个方向会造出一台一刀切或一台永远放行的仪器：

| 变异 | 结果 |
|---|---|
| 目录**外**（`acp-chat-panel.tsx`）加 `import { Slot } from 'radix-ui'` | `pnpm lint` rc=1，红 @ `12:1` |
| 目录**内**（`tooltip-icon-button.tsx`）加同一行 | 无 radix 违规（例外成立） |
| ↑ 的阳性对照：同一次 eslint run 同时报出临时塞进去的 `unusedProbe` | 证明 eslint 确实读了这个文件，那条「绿」不是因为文件被忽略 |
| 还原 | `pnpm lint` rc=0 |

markdown 五件那条判据的变异自测（**真实产品文件**，变异不进提交；每条都先确认变异在
`git diff --numstat` 里看得见），同样带「必须绿」的一组：

| 变异 | 结果 |
|---|---|
| M1 `codeWrapper` 去掉 `border` | 8 红（**仅** code 的两态 × 双主题 × 双宽度） |
| M2 给 `pline` 加边框 + 底色 + 圆角 | 20 红（**仅** prose 的四个「无容器」变体 × 4，加引用轨那条 × 4） |
| M3 `pblock` 去掉 `content-visibility` | 4 红（**仅** prose 的容纳用例；code / table 一条不红） |
| M4 `tableScroll` 去掉 `overflow-x` | **0 红 —— 这是失败的变异，不是判据说合格**，见下 |
| M5 **必须绿**：把 code 边框换成另一个颜色 token | 0 红（判的是有没有这张面，不是我写的色值） |
| M6 **必须绿**：把表格圆角写成 `calc(var * 1)` | 0 红（判的是 computed 几何，不是字面量） |
| M7 = M4 + M3 同时 | 7 红，含那条横向裁剪断言 |

> ⚠️ **M4 那个 0 必须连着 M7 一起读。** 表格的横向裁剪有**两条互相独立**的防线
> （`tableScroll` 自己的 `overflow-x`，以及 frame 的 paint containment），所以任何
> **单属性**变异都动不了它。只看 M4 会把「变异没能生效」读成「判据说合格」——
> 这正是 `rc≠0` 的两种混为一谈在变异侧的样子。M7 证明那条断言能红。

§4 间距按裁决 ③ 只做**双向棘轮**（P1-B 落地），不把 449 处存量改写成静默违规。

### 动效降级的覆盖面（2026-09-22，Refs #6104）

design.md:「**Every one of these is disabled under `prefers-reduced-motion`,
and any new keyframe must be too.**」
咕咕原来只有 `tokens.css` 那一段万能选择器兜底。它比 design.md 的「9 个具名 keyframe 逐个登记」
**更抗遗漏**(新增 keyframe 不会漏),这条**保留**,❌ 不为了对齐「具名清单」退回逐个登记。
缺的是覆盖面,本轮补齐到五处:

| 位置 | 补之前 | 那里有多少动效 |
|---|---|---|
| `apps/desktop/src/styles/tokens.css` | 已有(**定义处**) | — |
| `apps/desktop/src/session/renderer/index.css` | 只有 3 处点名降级 | 4 个 `--animate-*` + 5 个 keyframes + 整套 tw-animate-css |
| 中台 `src/styles/index.css`(现已拆出本仓) | `prefers-reduced-motion` 命中 **0** | `animate-in/-out` + `animate-spin`(infinite) |
| 顾客面板 `src/styles/index.css`(现已拆出本仓) | 同上(全 app 只有 `LoginPage.tsx` 一处内联块) | 同上 + `animate-pulse`(infinite) |
| `packages/session-ui/src/styles/effects/animations.css.ts` | 无 | 12 个 keyframes |

五处同选择器同内容,所以同时在场是**幂等**的,不是「两套值」。
`animation-iteration-count` 必须配对压成 1 —— 只压时长的话 infinite 动画会变成每圈 0.01ms 的
高频闪烁,比不降级更糟。

> ⚠️ **一处有意的不逐字相同**:vanilla-extract 那份**没有** `scroll-behavior: auto !important`。
> 它的 `scrollBehavior` 类型是关键字联合(不是 `string`),写不进 `!important`;而本包源码里
> `scroll-behavior: smooth` 的实测命中是 **0** ⇒ 没有需要被压过的声明,`auto` 本来就是初始值。
> ❌ 没用 `as` 断言把类型糊过去。真有人在本包里写 `smooth` 时,这条要连同判据一起重判。

`待定`：§3 字重仍**没有**机器判据 —— 需要先有一次全 app 计数，再决定可执行边界。本轮不加：
加一条会红一片的判据，和不加判据，都不会让代码变好，但前者会让下一个人学会忽略红灯。

> ~~`session-browser` / `session-chat-ui-browser` 当前不在 CI，因此 computed-style 判据是产品层证据，
> CI 仍由同主题的结构判据兜住。~~
>
> **已失效(2026-09-22 核对)**:`5ce49e368`(2026-09-19)把这两个 project 接进了 `ci.yml` 的 `session-db` job,
> 跑法是 `pnpm test:browser`。⇒ computed-style 判据现在就是门,上面那句「只是产品层证据」不再成立。
> 本条按本文的规矩**保留不删**:删掉的话,下一个人读到「有 computed-style 判据在 CI」时,
> 无从判断这是一直如此、还是中间被补上的。
