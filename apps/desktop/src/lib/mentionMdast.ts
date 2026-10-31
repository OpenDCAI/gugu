// @@@2017 — 聊天正文 @提及高亮的**内容层**原语。上层 buildMentionRender 用它把被 to_user_ids 背书的 @token 注入为
// 标记链接、并据「注入后再解析」定高亮/兜底;Markdown 渲染注入后的内容并认本次 marker。
//
// owner 铁律:群内定向消息的每个路由收件人必须恰好一个可见表达(正文高亮 XOR 气泡兜底徽标),绝不「都没有」= 寻址
// 静默消失。三条约束一并满足:
//  · 不可伪造(019 二审破口①):背书真源 = to_user_ids,不是用户可手打的 markdown 串。marker = **每次渲染唯一 nonce**
//    (`#ggm-<uuid>`,见 useMentionRender),发消息者无从预知 → 无法伪造 data-mention。
//  · 判定 ≡ 渲染(019 二审破口②):高亮名单 = 把**注入后的最终内容**再解析一遍(survivingMarkedNames)收集真正存活为
//    本次 marker link 的名字 = 渲染真相。`\@X` 注入后被反斜杠转义破坏 link → 不存活 → 走兜底,不会误判可高亮而静默丢。
//  · 缓存安全:Streamdown 按块内容字符串缓存渲染块、无视 remarkPlugins 状态;nonce 令注入后内容每次挂载唯一 →
//    缓存 key 不同 → 同 body 不同路由不串味(返工初版靠插件按 backedMentions 选择性切,命中该缓存盲区、会串味)。
// link/inline-code/code-fence/image 里的 @X 不进注入(见 findInjectableMentionSpans)→ 走兜底徽标。

import { markdownMentionReferences, parseMarkdown } from '@gugu/session-shared/markdown/dialect'
import { findMentionSpans } from '@gugu/core/shared/mentionToken.mjs'

export type MdNode = {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
  position?: { start: { offset?: number }; end: { offset?: number } }
}

// @@@2017 019f64ea 二审:@提及标记链接的 url 前缀。**完整 marker = 前缀 + 每次渲染唯一的 nonce**(见 mentionRenderModel
// 由 crypto.randomUUID 每个 Markdown 实例生成)。为什么带 nonce:固定 marker(旧 `#gg-mention`)是用户可在正文
// 手打的 markdown 串 → `[@X](#gg-mention)` 能伪造 data-mention、绕过 to_user_ids 背书(019 抓到的破口①)。nonce 在接收端
// 渲染时才生成,发消息者写正文时无从预知 → 无法伪造。components.a 仅当 href===本次 nonce marker 才渲 mention;其余
// `#ggm-*`(非本 nonce / 陈旧 / 伪造)一律中和成纯文本。纯 # 片段,过 rehype-sanitize。
export const MENTION_MARKER_PREFIX = '#ggm-'

/** 该 url 是否是内部 mention marker 家族(本次 nonce `#ggm-*`,或旧固定 marker `#gg-mention`)——components.a 用于识别+中和。 */
export function isMentionMarkerUrl(url: string | undefined): boolean {
  return typeof url === 'string' && (url.startsWith(MENTION_MARKER_PREFIX) || url === '#gg-mention')
}

/** @@@2017 正文里一个可注入的 @token 区间(全局字符偏移 [start,end),含 '@')与其背书名。 */
export interface InjectableMentionSpan {
  start: number
  end: number
  name: string
}

// @@@2017 找出正文里**可安全注入为标记链接**的被背书 @token 全局区间:解析成 mdast(与渲染同一份方言
// parseMarkdown),只在**普通 text 节点**上按 findMentionSpans 的边界找(跳过 link 子树防嵌套;
// code/inlineCode 是叶子节点天然不入;html / image / imageReference 跳过——它们要么被字面化、要么不宜在其语法里塞
// 链接)。findMentionSpans 跑在**原始源码切片**(按 position.offset 取)而非解码后的 value 上,故返回的偏移
// 直接可用于对原文 splice。注:这只是**注入位置**;最终「是否会高亮」以注入后再解析的 survivingMarkedNames 为准
// (注入后可能被反斜杠转义等破坏 link → 不存活 → 走兜底),两者以「同一份最终内容」对齐。
/** `content[index]` 是否被前面奇数个反斜杠转义(markdown 转义语义)。 */
function isBackslashEscaped(content: string, index: number): boolean {
  let bs = 0
  for (let i = index - 1; i >= 0 && content[i] === '\\'; i--) bs++
  return bs % 2 === 1
}

export function findInjectableMentionSpans(content: string, names: readonly string[]): InjectableMentionSpan[] {
  if (!content) return []
  const uniq = names.filter((n, i) => Boolean(n) && names.indexOf(n) === i)
  if (uniq.length === 0) return []

  const tree = parseMarkdown(content) as unknown as MdNode
  const spans: InjectableMentionSpan[] = []
  const walk = (node: MdNode): void => {
    if (!node.children) return
    if (node.type === 'link') return // link 子树里的 @X 不注入(已是链接,不能嵌套)→ 走兜底徽标
    for (const child of node.children) {
      if (child.type === 'text') {
        const off = child.position?.start?.offset
        if (typeof off !== 'number') continue // 无位置信息(理论上不会)→ 跳过,宁可走兜底也不错位 splice
        const raw = content.slice(off, child.position?.end?.offset)
        for (const s of findMentionSpans(raw, uniq)) {
          // 用户手写的 `\@X`(转义 @)= 字面 @,非提及:注入 `[` 会被那个反斜杠转义成字面 marker 串,污染正文显示。
          // 不注入 → 正文渲成干净 `@X`,该名字再解析不存活 → 走兜底徽标(不高亮、不静默丢、不污染)。
          if (isBackslashEscaped(content, off + s.start)) continue
          spans.push({ start: off + s.start, end: off + s.end, name: s.name })
        }
      } else if (child.type === 'image' || child.type === 'imageReference' || child.type === 'html') {
        // 图片/裸 html 的 @X 不注入(不宜在其语法里塞链接;渲染侧会字面化,无高亮)→ 走兜底徽标
      } else {
        walk(child)
      }
    }
  }
  walk(tree)
  spans.sort((a, b) => a.start - b.start)
  return spans
}

// markdown link 文本里逐字回显 @token:只转义在**链接文本**里有语义的字符(`\ [ ] ` * _ ~ <`),昵称含它们才不会破坏
// 链接结构、也不会被当 emphasis/code/autolink 二次解释。其余标点(@ . - / : # ! 等)在链接文本里是字面量,不转义(内容更干净)。
export function escapeMentionText(token: string): string {
  return token.replace(/[\\[\]`*_~<]/g, '\\$&')
}

/** References reveal names, never a task's contents or an implicit sharing link. */
export function displayAgentReferences(content: string, addressed?: (id: string, label: string) => string): string {
  let rendered = content
  for (const ref of markdownMentionReferences(content).reverse()) {
    if (!ref.target.startsWith('aid:')) continue
    const name = addressed?.(ref.target.slice(4), ref.label) ?? escapeMentionText(`@${ref.label}`)
    rendered = rendered.slice(0, ref.start) + name + rendered.slice(ref.end)
  }
  return rendered
}

// @@@2017 把被背书的 @token 就地包成标记链接 `[@Name](marker)`(marker = 本次渲染唯一 nonce),交给 Streamdown 前完成
// → 缓存安全(nonce 令每次挂载内容唯一,不串味)+ 免疫 markdown 对昵称的拆解 + 不可伪造(用户不知 nonce)。
// 倒序 splice 保留靠前区间偏移。names 空 / 无命中 → 原样返回(零改动、零开销)。
export function injectBackedMentions(content: string, names: readonly string[], marker: string): string {
  const spans = findInjectableMentionSpans(content, names)
  if (spans.length === 0) return content
  let out = content
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i]
    const token = out.slice(s.start, s.end)
    out = out.slice(0, s.start) + `[${escapeMentionText(token)}](${marker})` + out.slice(s.end)
  }
  return out
}

// @@@2017 019f64ea 二审「判定 ≡ 渲染」的关键:把**注入后的最终内容**按渲染同一份方言(parseMarkdown)再解析一遍,
// 收集真正**存活为本次 nonce-marker link** 的名字(@token 去掉前导 @)。这就是渲染真相——`components.a` 也是对同一份
// 内容解析后、按 href===marker 渲 mention。故「会不会高亮」= 本函数结论,`\@X` 这类注入后被转义(`\[` 破坏 link)的
// case 两侧同为「不存活」→ 判定不误判可高亮 → 走兜底,不再静默丢。只认本次 marker,伪造的 `#gg-mention`/其它 nonce 不计。
export function survivingMarkedNames(injectedContent: string, marker: string): Set<string> {
  const found = new Set<string>()
  if (!injectedContent || !marker) return found
  const tree = parseMarkdown(injectedContent) as unknown as MdNode
  const textOf = (node: MdNode): string => (node.type === 'text' ? node.value ?? '' : (node.children ?? []).map(textOf).join(''))
  const walk = (node: MdNode): void => {
    if (!node.children) return
    for (const child of node.children) {
      if (child.type === 'link' && child.url === marker) {
        const text = textOf(child) // = 注入时的 `@name`(解码后)
        if (text.startsWith('@')) found.add(text.slice(1))
      } else {
        walk(child)
      }
    }
  }
  walk(tree)
  return found
}
