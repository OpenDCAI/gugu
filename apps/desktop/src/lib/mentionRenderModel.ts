// @@@2017 019f64ea 二审终版 —— 群内 @提及寻址的「单重显示」模型:每个路由收件人**恰好一个可见表达**(正文高亮 XOR
// 气泡兜底徽标,绝不两头落空)。背书唯一真源 = 结构化 `to_user_ids`,**不是**用户可手打的 markdown 串。
//
// 机制(治两条破口):
//  · 破口①(伪造):把被路由的 @token 就地包成 `[@Name](marker)`,marker = **接收端渲染时生成的每次挂载唯一 nonce**
//    (见 useMentionRender)。发消息者写正文时无从预知 nonce → 无法伪造 data-mention;`components.a` 仅当 href===本次
//    marker 才渲 mention。用户手打 `[@X](#gg-mention)` / 猜的 nonce → 不匹配 → 中和成纯文本。
//  · 破口②(静默丢):高亮名单**不看注入前 span**,而是把**注入后的最终内容**再解析一遍(survivingMarkedNames),
//    收集真正存活为本次 marker link 的名字 = 渲染真相。`\@X` 注入成 `\[@X](marker)` → 再解析 `\[` 转义 → 无 link →
//    不存活 → 走兜底徽标;渲染侧同源同结论 → 既不误判可高亮、也不静默丢。
//  fallback = 路由对象 − 存活高亮;excludeIds(reply 被回复者)未高亮时不挂徽标(其表达归引用条)。

import { MENTION_ALL_USER_ID, mentionAllName, mentionAllBadge } from './mention'
import { injectBackedMentions, survivingMarkedNames } from './mentionMdast'

/** 一条消息的渲染模型:注入 nonce marker 后的正文 + 兜底徽标名单。 */
export interface MentionRenderModel {
  /** 交给 Markdown 渲染的正文(已把被路由 @token 注入为本次 nonce marker link)。 */
  content: string
  /** 路由有、但正文里没有一个能真正渲成高亮的 @token 的对象(兜底徽标:displayName / 「全员」)。 */
  fallbackLabels: string[]
}

/**
 * 从路由真源 `to_user_ids` + 正文 + 本次渲染 `marker`(nonce)构建渲染模型。
 * `nameOf` 解析显示名,解析不到回退裸 id(fail-loud);`excludeIds`(如 reply 被回复者)未高亮时不挂徽标。按 id 去重。
 */
export function buildMentionRender(
  body: string,
  toUserIds: string[] | null | undefined,
  opts: { nameOf: (id: string) => string | undefined; excludeIds?: readonly string[]; marker: string },
): MentionRenderModel {
  const ids = toUserIds ?? []
  const nameOfId = (id: string): string => (id === MENTION_ALL_USER_ID ? mentionAllName() : opts.nameOf(id) ?? id)

  // 候选名 = 全部路由对象的显示名(去重、去空);注入只针对这些名字(背书真源)。
  const candidateNames: string[] = []
  const seenName = new Set<string>()
  for (const id of ids) {
    const name = nameOfId(id)
    if (name && !seenName.has(name)) {
      seenName.add(name)
      candidateNames.push(name)
    }
  }

  const content = injectBackedMentions(body, candidateNames, opts.marker)
  const surviving = survivingMarkedNames(content, opts.marker) // 真正会渲成高亮的名字集(= 渲染真相)

  const fallbackLabels: string[] = []
  const exclude = new Set(opts.excludeIds ?? [])
  const seenId = new Set<string>()
  for (const id of ids) {
    if (seenId.has(id)) continue
    seenId.add(id)
    const name = nameOfId(id)
    if (surviving.has(name)) continue // 正文里真高亮 → 单重靠高亮,不挂徽标
    if (!exclude.has(id)) fallbackLabels.push(id === MENTION_ALL_USER_ID ? mentionAllBadge() : name) // 高亮不到 → 兜底
  }

  return { content, fallbackLabels }
}
