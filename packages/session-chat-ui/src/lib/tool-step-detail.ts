import type { ToolNode } from '@session-chat/model';
import { deriveToolInputSummary } from '@session-chat/components/rows/tools/tool-input-summary';

/** Real arguments shared by parent process rows and child progress rows. */
export function toolStepDetail(item: Exclude<ToolNode, { kind: 'tool-group' }>): string | undefined {
  switch (item.kind) {
    case 'execute-tool-call': return item.command ?? item.inputSummary ?? deriveToolInputSummary(item.rawInput);
    case 'read-tool-call': return item.path ?? item.resource;
    case 'search-tool-call': return item.query;
    case 'web-fetch-tool-call': return item.url;
    case 'spawn-subagent-tool-call': return item.name;
    default: return item.inputSummary ?? deriveToolInputSummary(item.rawInput);
  }
}
