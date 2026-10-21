// @@@fork-identity — 持久分叉出来的是**新 agent**,但 codex 不认 `thread/fork` 带的新 developerInstructions。
//
// 上游已确认的缺陷 openai/codex#19045(未修;0.153.2 / 0.154.0 / 0.155.1 实测同样):冷 fork 从历史重建
// 上下文,新指令只进运行时状态、不进模型请求 ⇒ 分叉出来的 agent 读到的仍是源会话的身份块,以为自己
// 还是源 agent(工具凭据却已是新 agent 的)。
//
// 修法:fork 之后用官方的 `thread/inject_items` 在历史**末尾**追加一条开发者消息 —— 只含身份差异
// 与交接说明,❌ 不重发整份平台提示词,❌ 不改前缀(缓存照常命中)。实测(ZEBRA/TIGER 探针):分叉后
// 第一轮即按新身份回应,强制压缩后仍是新身份,3/3。上游修好 #19045 后删掉本模块与两处调用。
//
// 两条腿共用这一份:会话页 TUI(codex-pty-provisioning 的临时 app-server fork)与聊天界面
// (codex-app-server-acp 的 session/fork,仅持久分叉)。

const IDENTITY_BLOCK = /<agent_identity\b[^>]*>[\s\S]*?<\/agent_identity>/
const SPECIAL_FOCUS_BLOCK = /<special_focus\b[^>]*>[\s\S]*?<\/special_focus>/

const HANDOFF = `<fork_handoff reason="forked_conversation">
This conversation was forked from another agent's conversation. Everything above this point is that source conversation's history: any identity stated there belonged to the source agent and no longer applies to you. Your identity from now on is the one below.
Do not resume or continue the source conversation's unfinished work. A fork is usually made for a different task — wait for your new instructions.
</fork_handoff>`

/**
 * 从新 agent 的 developerInstructions 里取出身份块,拼成要注入的那条开发者消息(Responses API item)。
 * 取不到身份块 ⇒ THROW:这正是本缺陷的症状(新 agent 顶着旧身份),❌ 不许静默放过。
 */
export function codexForkHandoffItems(developerInstructions) {
  const text = typeof developerInstructions === 'string' ? developerInstructions : ''
  const identity = text.match(IDENTITY_BLOCK)?.[0]
  if (!identity) {
    throw new Error(
      'codex fork handoff: 新 agent 的 developerInstructions 里没有 <agent_identity> 块 —— '
      + '分叉出来的会话会顶着源 agent 的身份跑(openai/codex#19045),拒绝继续(fail-loud)',
    )
  }
  const focus = text.match(SPECIAL_FOCUS_BLOCK)?.[0]
  return [{
    type: 'message',
    role: 'developer',
    content: [{ type: 'input_text', text: [HANDOFF, identity, ...(focus ? [focus] : [])].join('\n') }],
  }]
}
