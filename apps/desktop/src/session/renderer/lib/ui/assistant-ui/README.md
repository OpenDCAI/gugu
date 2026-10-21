# assistant-ui Elements（vendored）

本目录是 assistant-ui 的 shadcn registry 组件在本仓的落点：**抄源码，不装依赖**。

上游有**两族**，性质完全不同，别混为一谈（这是本目录最容易被搞错的一件事）：

| 族 | registry 名 | 绑不绑 runtime | 能不能直接 vendored |
|---|---|---|---|
| **Elements** | `elements-<slug>`，共 104 个（2026-09-06 重数，8 月是 96） | **不绑**。零 `@assistant-ui/react`、零 `*Primitive` | ✅ props 进、回调出，抄进来就能用 |
| 核心组件 | `thread` · `follow-up-suggestions` · `markdown-text` · `attachment` · `model-selector` … | **绑**。npm 依赖里就写着 `@assistant-ui/react` | ❌ 要 `AssistantRuntimeProvider` |

`npx shadcn@latest add @assistant-ui/thread` 拉的是**后者**；
`npx shadcn@latest add @assistant-ui/elements-tool-call` 拉的是**前者**。

> ⚠️ **同一个能力可能在两族里各有一个条目，名字还很像。** 光看官网 `…/elements/<slug>` 这个 URL
> **分不出族别** —— 官网把两族都挂在 `/elements/` 下，但 registry 里只有 `elements-` 前缀那个是 Elements。
> 实例（2026-09-06 撞到）：MCP 有 **`mcp-config`**（npm deps `@assistant-ui/react-mcp` +
> `@assistant-ui/store`，源码里两个都 import，自带一套连接状态机与 storage —— 它文档里的
> `data-mcp-hydrated` / `data-connection-state` / `data-has-error` 就是那套东西的外显 ⇒ **不能抄**）
> 和 **`elements-mcp-server-panel`**（npm 只有 `lucide-react`，registry 只依赖已 vendored 的
> `elements-surfaces` ⇒ 可以抄）两个条目。
> ⇒ **动手前先按下面那段探针查族别**，❌ 别按官网 URL 判断。

本目录是 **#3334 记下的那条有界例外的唯一落点**：如果将来某个 vendored 组件确实需要
`radix-ui`，只有这里可以 import 它，产品代码继续用 Base UI。边界由 `.eslintrc.cjs` 的
`no-restricted-imports` 守，不靠下一个人记得（见 `design-system` spec body）。

### 族别对了，还有第二道闸：**这个 Element 要的 props，我们有没有那份数据**

`elements-mcp-server-panel` 就卡在这第二道：它的 props 硬要
`status: connected|connecting|needs-auth|failed` 与 `tools: readonly string[]`，
而咕咕这条链（`McpService.loadAll` → 各家 `behavior.mcp.readServers(fs)`）读的是**各家自己的配置文件**，
`McpLoadAllResponse` 只有 `{ installed, catalog }` —— **既不持有连接，也没有工具表**。
整体搬进来 = 状态点永远同一个颜色、`{N} tools` 永远是 0。

⇒ 这是最难发现的一种假件：**它不报错、不空白，只是永远显示同一个值** ——
既不会让任何判据变红，也不会告诉你它没在工作（铁律 10）。

⇒ 这种时候正确的做法是**只取它的解剖与视觉词汇**（`data-slot` 命名 + `surfaces.tsx` 的 class 配方），
❌ 不整体 vendored。逐元素判定见 design notes（MCP 那一格是 #31）。

## 为什么是「抄源码」而不是 `pnpm add @assistant-ui/react`

因为 **Elements 那 104 个根本用不到它**，装了纯属多一个依赖；而真绑 runtime 的核心组件那一族，
我们又不能用——咕咕会话页已经有 `ChatState.transcript` 与 `AcpChatStore` 两份真相，
再接一层 runtime 就是同一份消息两个来源。

⇒ **不装 `@assistant-ui/react`。** Elements 只作为纯展示组件消费（props 进、回调出），
这既是上游本来的形态，也是 `design-system` spec 对本目录的要求。

### 这个结论怎么验（别只是相信这段话）

```bash
# 全家 elements-* 的依赖与 runtime import，带阳性对照
# ⚠️ 走 curl，❌ 别用 urllib：r.assistant-ui.com 现在对 urllib 的默认 UA 一律 403。
#    2026-08-12 那版用的正是 urllib，今天原样重跑会直接抛异常 —— 幸好阳性对照跟着一起抛，
#    所以它是**响亮**地坏掉的，不会伪装成「一条 RUNTIME-BOUND 都没有」。
curl -sS --noproxy '*' https://r.assistant-ui.com/registry.json -o /tmp/registry.json
python3 - <<'PY'
import json, re, subprocess
names = [i['name'] for i in json.load(open('/tmp/registry.json'))['items']]
def probe(n):
    r = subprocess.run(['curl','-sS','--noproxy','*','-f',f'https://r.assistant-ui.com/{n}.json'],
                       capture_output=True, text=True)
    if r.returncode != 0:
        return 'FETCH-FAIL'                            # ❌ 不当成「没绑 runtime」
    d = json.loads(r.stdout)
    imports = {m for f in d.get('files', []) for m in re.findall(r'from ["\']([^"\']+)["\']', f['content'])}
    return d.get('dependencies') or [], sorted(i for i in imports if 'assistant-ui' in i)
for n in ['thread', 'follow-up-suggestions']:          # 阳性对照：确知绑 runtime
    print('CONTROL', n, probe(n))
for n in [x for x in names if x.startswith('elements-')]:
    r = probe(n)
    if r == 'FETCH-FAIL':
        print('FETCH-FAIL', n); continue               # 仪器失败单独一支，❌ 不并进阴性读数
    deps, aui = r
    if aui or any('assistant-ui' in d for d in deps):
        print('RUNTIME-BOUND', n, deps, aui)
PY
```

⚠️ 连着打 100+ 个请求会被限流，`FETCH-FAIL` 是**常态**而不是异常。**逐个重取到 0 为止再读结论** ——
「没打印 RUNTIME-BOUND」与「那几个压根没取到」在输出里同形，而后者不是阴性读数。

两个对照必须都打印出 `@assistant-ui/react`，否则说明探针坏了、这次读数作废。

- **2026-08-12 实测**：对照命中，96 个 `elements-*` **零命中**；全家 npm 依赖只有
  `lucide-react`(67) / `tw-shimmer`(1) / `@base-ui/react`(1) / `heat-graph`(1)，
  registry 依赖只有 `collapsible`(4)。
- **2026-09-06 重跑**（registry 已长到 151 条 = 104 个 `elements-*` + 47 个非 Elements）：
  两个对照都命中；首轮 100/104，4 个 `FETCH-FAIL`（`score-breakdown` / `cost-meter` /
  `quota-banner` / `agent-handoff`，限流）逐个重取全部 HTTP 200 并单独判读，
  **104/104 零命中** —— 结论至今成立。

> ⚠️ 这段话在 2026-08-12 之前写反过：旧版本说「上游 Elements 的每一个组件都绑在 `ThreadPrimitive` 上，
> 装了也没有一个组件是能合法使用的」。当时最早 vendored 的三个组件恰好取自 `thread.json`
> ——那一族确实绑 runtime——于是**一个从未被检验的理由，在它恰好正确的那一次之后被继续引用**，
> 并让「Elements 不能直接抄」成了全队的默认前提。上面那段脚本就是为了让下一个人**重跑它**，
> 而不是重新相信一句话。

## ⛔ `ThreadPrimitive.Viewport` 一行都不许进来

**理由与 runtime 无关**（旧版本把它挂在「所有组件都绑 primitive」上，那个前提是错的；
一条正确的禁令配一个错误的理由，会在理由被推翻时连禁令一起被推翻）。

真正的理由是**滚动的写者只能有一个**：咕咕 transcript 是 Solid + Fenwick 虚拟化，
`projectAnchor()` 是唯一 scrollTop 写者，滚动意图 event-sourced。
`ThreadPrimitive.Viewport` 自带一套粘底实现——它的 auto-scroll 假设每条消息都已挂载，
基于 resize 的重新贴底会和虚拟器的测量调整互相打架。引入它 = 第二个粘底实现 + 第二个
scrollTop 写者，症状是「偶尔跳一下」，且难以归因。上游自己的虚拟化指南也写明：
自建虚拟化就必须放弃 Viewport。

贴底状态只由现有 `onAtBottomChange` **单向**喂进来（`acp-chat-panel.tsx`）。

⇒ 这条禁令与「Elements 可不可以直接抄」是**两件独立的事**：Elements 可以抄，Viewport 不能进。

## 目录内容

| 文件 | 是什么 | 上游 |
|---|---|---|
| `surfaces.tsx` | **全家公共底座**：class 配方 + `ShimmerLabel` / `SwapLabel` | `elements-surfaces` |
| `range.ts` | 数值归一化（`clamp` / `take` / `pct` / `progressOf` …） | `elements-range` |
| `thread-welcome.tsx` | 空态 + 建议芯片 | `thread.json` 内的 `ThreadWelcome` / `ThreadSuggestions` |
| `thread-scroll-to-bottom.tsx` | 回到底部按钮 | `thread.json` 内的 `ThreadScrollToBottom` |
| `tooltip-icon-button.tsx` | 带 tooltip 的图标按钮 | `tooltip-icon-button.json` |

`surfaces.tsx` / `range.ts` 是 94 个元素里绝大多数的公共依赖，**先落它们**，
否则每搬一个元素都要重抄一份同样的配方。逐条改动写在各自文件头。

## 逐条改动（相对上游）

`surfaces.tsx` 与 `range.ts` 的改动表在文件头部。其余三个：

| 组件 | 上游 | 这里 | 为什么 |
|---|---|---|---|
| `TooltipIconButton` | `import { Slot } from 'radix-ui'`，用 `Slot.Slottable` 包 children | 直接渲染 `children` | `Slot.Slottable` 只在 `asChild` 组合下有意义，这里不用 `asChild`。⇒ **本目录当前 0 个 radix import**，例外记着但没被用掉 |
| `TooltipIconButton` | `@/components/ui/tooltip`（radix 版） | `@renderer/lib/ui/tooltip`（Base UI） | 本仓 tooltip 已经是 Base UI |
| `ThreadScrollToBottom` | `<ThreadPrimitive.ScrollToBottom asChild>` | `atBottom` / `onScrollToBottom` props | 贴底状态不由这里推导，见上一节 |
| `ThreadScrollToBottom` | `rounded-full p-4` | Button `icon-md` 自带的 `--radius` 派生圆角 | 视觉规格：圆角走 `--radius`，容器不覆盖它 |
| `ThreadWelcome` | `text-2xl` | `text-xl` + `gg-type-page-title` | 视觉规格字阶上限：禁 `text-2xl`+，`text-xl` 仅页标题 |
| `ThreadWelcome` | `duration-200` | `duration-[var(--dur-med,180ms)]` | 时长走 token 档位 |
| `ThreadSuggestions` | `SuggestionPrimitive.Trigger send` | `items` + `onSelect` props | 无 runtime |
| `ThreadSuggestions` | `rounded-full` | Button 默认 `--radius` 派生圆角 | 同上 |

上游取值与本仓 calm-ui 硬限冲突时**本仓规格赢**（`docs/ui-visual-spec.md` §2/§4/§5/§6）
——这些差异就是各改动表存在的理由，不要在下次同步 registry 时把它们「改回去」。

⚠️ 抄新元素进来时会撞到的两把尺子（都真实存在，都会红）：

- `tests/visual-scale-guard-3334.test.ts` —— 按 **TS 字符串字面量**判 `text-2xl`+ / `rounded-xl`+ /
  `shadow-md`+ 与非 inset 任意值阴影。注释不算字面量，注释里的取值它看不见。
- `scripts/check-ui-visual-spec.mjs` —— 按 **原始源码文本**给 0.5 步进间距 utility 记双向棘轮
  （会话页基线 341，只减不增）。**注释算数** —— 在 `.ts`/`.tsx` 的注释里引用一句上游的半步取值
  （`gap-1.5` 这种），棘轮照样顶破一格（落 `surfaces.tsx` 时实测踩到：342 vs 341）。
  它只扫 `.css/.js/.jsx/.ts/.tsx`，所以本 README 这类 `.md` 不在它的量程里。

两把尺子扫描面不同，别拿一把的绿去推另一把。

## 完整对照表

122 个上游元素 × 咕咕三个面（transcript / chrome / composer）的逐个对照与移植判定，
见 design notes。
