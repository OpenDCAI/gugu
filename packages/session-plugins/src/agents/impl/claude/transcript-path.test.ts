/**
 * 聊天面板腿认 Claude 实际用的配置目录:包装器在进程里设的 `CLAUDE_CONFIG_DIR` 宿主看不见,只有 Claude 在 hook 里报的
 * `transcript_path` 说得准。桥接把它带在一条无标题的 `session_info_update._meta.claudeCode.transcriptPath` 上转来;
 * 这里把它变成 `transcript_path` 事件,宿主再交给终端腿同一个入口(harness-config-roots)。
 */
import type { SessionUpdate } from '@agentclientprotocol/sdk/experimental/v2';
import { describe, expect, it } from 'vitest';
import { createClaudeSessionDecoder } from './acp-transform';

const TRANSCRIPT = '/home/u/wrapped-claude-config/projects/-work-repo/0b6f-session.jsonl';
const decode = createClaudeSessionDecoder();
const info = (update: Record<string, unknown>) => decode({ sessionUpdate: 'session_info_update', ...update } as SessionUpdate);

describe('claude ACP transcript path', () => {
  it('the bridge-reported transcript path becomes a transcript_path event', () => {
    expect(info({ _meta: { claudeCode: { transcriptPath: TRANSCRIPT } } })).toEqual({ kind: 'transcript_path', path: TRANSCRIPT });
  });

  it('a title update stays a title; an info update without the field stays ignored', () => {
    expect(info({ title: 'Fix it' })).toEqual({ kind: 'title', title: 'Fix it' });
    expect(info({ _meta: { claudeCode: {} } })).toEqual({ kind: 'ignored' });
  });
});
