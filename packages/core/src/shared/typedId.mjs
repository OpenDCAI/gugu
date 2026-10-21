// id 收敛第三刀：**边界带类型标签的 id**。
//
// 存储层照旧裸 UUID（identity.users.id 是 Supabase Auth 发的，人和 agent 同表同列，存储层加不了前缀）。
// 越过 MCP 工具边界、进入 agent 提示词或界面的 id 一律带类型：`session:<uuid>` /
// `msg:<uuid>` / `agent:<uuid>` / `user:<uuid>` / `chat:<uuid>` / `project:<uuid>`。三串裸 UUID 印在一起谁也
// 认不出哪个是哪个；带了类型，传错 id 当场报错（"expected a session: id but got a project: id"），
// 而不是静默 not found。编解码只在这里做一次，双向强制。历史会话文本里仍是旧格式（裸 UUID）：
// 解码器对旧格式报错并指明正确形态，agent 拿工具最新返回的值即可。

/** @typedef {'session' | 'project' | 'msg' | 'agent' | 'user' | 'chat' | 'gugu' | 'extension' | 'device' | 'schedule' | 'post' | 'reply'} TypedIdKind */

/** @type {readonly TypedIdKind[]} */
export const TYPED_ID_KINDS = Object.freeze(['session', 'project', 'msg', 'agent', 'user', 'chat', 'gugu', 'extension', 'device', 'schedule', 'post', 'reply'])

/**
 * @param {TypedIdKind} kind
 * @param {string} raw storage-form id (bare)
 * @returns {string}
 */
export function encodeTypedId(kind, raw) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new Error(`cannot encode an empty ${kind} id`)
  }
  if (raw.includes(':')) {
    throw new Error(`refusing to double-encode "${raw}" as a ${kind}: id`)
  }
  return `${kind}:${raw}`
}

/**
 * Decode an agent-supplied id of the expected kind back to its storage form. Fails loud on a bare id
 * (the pre-prefix format) and on a mismatched kind — both are the exact mistakes the prefix exists
 * to catch.
 *
 * @param {TypedIdKind} kind
 * @param {unknown} value
 * @param {string} field the parameter name, for the error message
 * @returns {string}
 */
export function decodeTypedId(kind, value, field) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field}: expected a ${kind}: id, got ${JSON.stringify(value)}`)
  }
  const trimmed = value.trim()
  const separator = trimmed.indexOf(':')
  if (separator === -1) {
    throw new Error(
      `${field}: expected a ${kind}: id (${kind}:<id>), got the bare id "${trimmed}" — pass the exact value the tool returned`,
    )
  }
  const prefix = trimmed.slice(0, separator)
  const raw = trimmed.slice(separator + 1)
  if (prefix !== kind) {
    throw new Error(`${field}: expected a ${kind}: id but got a ${prefix}: id ("${trimmed}")`)
  }
  if (raw.length === 0) throw new Error(`${field}: ${kind}: id has no value ("${trimmed}")`)
  return raw
}

/**
 * Tolerant read for text the host wrote itself in either era (persisted envelopes predate the
 * prefix): a prefixed id of the expected kind decodes, a bare id passes through, a prefixed id of
 * another kind fails loud.
 *
 * @param {TypedIdKind} kind
 * @param {unknown} value
 * @returns {string | null}
 */
export function readTypedIdLenient(kind, value) {
  if (typeof value !== 'string' || value.trim().length === 0) return null
  const trimmed = value.trim()
  const separator = trimmed.indexOf(':')
  if (separator === -1) return trimmed
  const prefix = trimmed.slice(0, separator)
  if (!TYPED_ID_KINDS.includes(/** @type {TypedIdKind} */ (prefix))) return trimmed
  if (prefix !== kind) return null
  const raw = trimmed.slice(separator + 1)
  return raw.length > 0 ? raw : null
}

/** @typedef {{ kind: 'user', id: string } | { kind: 'gugu', number: number }} IdentityAddress */

/**
 * 身份地址(#5048,owner 2026-09-05):agent 在任何收身份的位置都可以写两种 typed 形态 ——
 * `user:<uuid>`(canonical `identity.users.id`)或 `gugu:<咕咕号>`(同一个身份的短写法:几个 token,
 * 而不是一个 uuid 的 25-30 个)。这里只做**语法**:`gugu:` 要换成 uuid 得问一份名录,那是各条腿自己的事
 * (chat 腿问 identity.search_users,session_message 的 roster 腿问 session_peers),解析都发生在任何
 * 副作用之前。裸 uuid、裸数字、别的类型一律当场报错并指明两种正确形态 —— 裸数字与 chat_id 收的
 * public_id 同形,前缀是唯一能识破「填错格」的东西。
 *
 * 号限 1-9 位:与 identity.search_users 的精确号支同一条上限(int4),10 位以上在名录里必然落空。
 *
 * @param {unknown} value
 * @param {string} field the parameter name, for the error message
 * @returns {IdentityAddress}
 */
export function decodeIdentityAddress(value, field) {
  // `aid:` 是产品面的写法 —— 分享浮层那一栏原文就叫 **Agent ID**,前缀跟界面上的词对上
  // (owner 2026-09-16 拍板)。`user:` 是它的旧拼法,继续收:线上已经有带 `user:` 的会话记录与
  // 排队中的消息,改名不能让它们当场失效(❌ 只改新的、留旧的自生自灭)。两种解出同一个东西。
  const forms = 'aid:<Agent ID> or gugu:<咕咕号>'
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field}: expected an identity address (${forms}), got ${JSON.stringify(value)}`)
  }
  const trimmed = value.trim()
  const separator = trimmed.indexOf(':')
  if (separator === -1) {
    throw new Error(
      `${field}: expected an identity address (${forms}), got the bare value "${trimmed}" — pass the Agent ID with its aid: prefix exactly as a tool returned it, or gugu:<number> for a 咕咕号`,
    )
  }
  const prefix = trimmed.slice(0, separator)
  const raw = trimmed.slice(separator + 1)
  if (prefix === 'aid' || prefix === 'user') {
    if (raw.length === 0) throw new Error(`${field}: ${prefix}: has no Agent ID after the prefix ("${trimmed}")`)
    return { kind: 'user', id: raw }
  }
  if (prefix === 'gugu') {
    if (!/^[1-9][0-9]{0,8}$/.test(raw)) {
      throw new Error(`${field}: gugu:<咕咕号> needs a positive integer 咕咕号 (1-9 digits), got "${trimmed}"`)
    }
    return { kind: 'gugu', number: Number(raw) }
  }
  throw new Error(`${field}: expected an identity address (${forms}) but got a ${prefix}: id ("${trimmed}")`)
}
