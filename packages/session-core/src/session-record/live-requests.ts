import { changedFilePaths } from '../acp/models/file-patch';
import { projectToolContent } from '../acp/models/tool-payload';
import { permissionTitle, permissionDescription, type AcpPermissionRequest } from '../acp/models/permissions';
import { type ToolCallItem } from '../acp/models/turns/tool-calls';
import type { PendingRequest, SettlementOption } from './contract';

/**
 * ACP 的一条 `session/request_permission` → 时间线认得的一条待结算。
 *
 * 这条请求**不在会话记录里**（它是请求应答，只有当时连着的那个 ACP 客户端看得见），
 * 所以宿主要把活运行时里的它同步进时间线，手机才画得出卡。
 *
 * `optionId` 原样取 provider 给的那个字符串 —— 回答时要一字不差发回 `resolvePermission`。
 * ❌ 不许按序号或文案另造一个（契约 `SettlementOption` 上写死了这条）。
 */

/** 卡片副标题的长度上限。整份 diff / 整个文件正文没必要经 Realtime 发到手机上。 */
const DETAIL_LIMIT = 300;

function clip(text: string): string {
  const body = text.trim();
  return body.length <= DETAIL_LIMIT ? body : `${body.slice(0, DETAIL_LIMIT)}…`;
}

/**
 * 「它到底要动什么」。
 *
 * 光有 title（"Write"、"Bash"）不够让人在手机上判断该不该批 —— 要批的是**哪个文件**、
 * **哪条命令**。按 kind 取那一个决定性的字段，取不到就退回 provider 自己的 `inputSummary`。
 */
function describeToolCall(toolCall: ToolCallItem): string | undefined {
  switch (toolCall.kind) {
    case 'execute-tool-call':
      return toolCall.command ?? toolCall.inputSummary;
    case 'read-tool-call':
      return toolCall.path ?? toolCall.resource ?? toolCall.inputSummary;
    case 'patch-tool-call':
      return changedFilePaths(projectToolContent(toolCall.contentBlocks ?? []).diffs).join(', ') || toolCall.inputSummary;
    case 'search-tool-call':
      return toolCall.query;
    case 'web-fetch-tool-call':
      return toolCall.url;
    case 'spawn-subagent-tool-call':
      return toolCall.name;
    case 'mcp-tool-call':
      // MCP 调用没有一个决定性的字段:要做什么全在入参里(Claude Code 原生客户端也是带着入参显示)。
      return toolCall.inputSummary ?? toolCall.rawInput;
    case 'create-plan-tool-call':
      return toolCall.inputSummary;
    case 'unknown-tool-call':
      return toolCall.inputSummary ?? toolCall.name;
  }
}

export function permissionToPendingRequest(request: AcpPermissionRequest): PendingRequest {
  const options: SettlementOption[] = request.options.map((option) => ({
    optionId: option.optionId,
    name: option.name,
    ...(option.kind ? { kind: option.kind } : {})
  }));
  const title = permissionTitle(request);
  const detail = (permissionDescription(request) ?? (request.toolCall ? describeToolCall(request.toolCall) : undefined))?.trim();
  return {
    itemId: request.requestId,
    // ACP 这条通道上问的永远是「准不准做这件事」。提问（从几项里挑一个）在协议上不是
    // requestPermission，本仓今天也没有从宿主结算它的口（write-bridge 对它 fail loud）。
    kind: 'permission',
    title,
    ...(request.subject !== undefined ? { subject: request.subject } : {}),
    ...(detail && detail !== title ? { detail: clip(detail) } : {}),
    options
  };
}
