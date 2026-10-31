/** @jsxImportSource solid-js */
/**
 * agent-send-to —— agent 经 message_send / session_message 说出去的那段话下面那一行:发到了哪里。
 *
 * 话本身就是一条 agent 消息(segmenter 交给 message 那一套画、量),这一行只说去向,所以读起来是
 * 「agent 说了这句,发到了 X」—— ❌ 一行「调用了 MCP 工具」把话藏进参数里(群里派的任务,话全是这么回的)。
 * 哪些调用算、去向怎么认:session-core `agentSendOf`(手机会话页读同一份)。
 */
import { defineUnit } from '@session-chat/core/units';
import type { AgentSendItem } from '@session-chat/model';
import { agentSendLabel } from '@session-chat/state/agent-send';
import type { MeasureCtx } from '@session-chat/core/define';
import { readableLabel, rowTranslator } from '../readable-label';
import { toRow } from './agent-send.css';

/** 一行高(px)。⚠️ 改它要同时改 `agent-send.css.ts` 的 height / line-height。 */
export const AGENT_SEND_TO_ROW_H = 18;

function destinationLayout(data: AgentSendItem, ctx: MeasureCtx) {
  const t = rowTranslator(ctx);
  const where = agentSendLabel(data.send.to, t, ctx.chatName ?? (() => null));
  return readableLabel(data.status === 'running' ? `${where} · ${t('transcript.agentSending')}` : where, ctx);
}

export const agentSendToUnitDef = defineUnit<AgentSendItem, { rowH: number }>({
  kind: 'agent-send-to',
  // 紧贴在那段话下面,和下一行之间照常留一档。
  margin: { top: 2, bottom: 8 },
  vars: { rowH: AGENT_SEND_TO_ROW_H },

  measure(data, ctx) { return destinationLayout(data, ctx).height; },

  Render(props) {
    const layout = () => destinationLayout(props.data, props.ctx.measureCtx!());
    return <div class={toRow} style={{ height: `${layout().height}px` }} data-agent-send-to={props.data.id}>{layout().text}</div>;
  },
});
