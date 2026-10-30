/**
 * harness 报的会话记录路径(`transcript_path` 事件)记在 cell 上、不进转录,变了才通知 —— 会话摘要据此带上它,
 * 宿主从摘要读出 harness 实际用的配置目录。
 */
import type { AcpAgentApi } from '@gugu/session-core/agents/plugins';
import { noopLogger } from '@gugu/session-shared/logger';
import { expect, it, vi } from 'vitest';
import { SessionCell } from './cell';

it('keeps the latest reported transcript path out of the transcript and notifies only on change', () => {
  const onSessionStateChanged = vi.fn();
  const cell = new SessionCell({ sessionId: 'c', projectId: 'p', providerId: 'claude', acpSessionId: 's',
    agent: { prompt: vi.fn(), cancel: vi.fn(async () => {}) } as unknown as AcpAgentApi,
    resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }), logger: noopLogger,
    callbacks: { onSessionStateChanged } });
  cell.applySessionReady();
  expect(cell.transcriptPath).toBeNull();
  const before = cell.history();
  onSessionStateChanged.mockClear();

  cell.push({ kind: 'transcript_path', path: '/cfg/projects/-w/a.jsonl' });
  cell.push({ kind: 'transcript_path', path: '/cfg/projects/-w/a.jsonl' });
  expect(cell.transcriptPath).toBe('/cfg/projects/-w/a.jsonl');
  expect(onSessionStateChanged).toHaveBeenCalledTimes(1);
  expect(cell.history(), 'not a transcript event').toEqual(before);

  cell.push({ kind: 'transcript_path', path: '/cfg/projects/-w/b.jsonl' });
  expect(cell.transcriptPath).toBe('/cfg/projects/-w/b.jsonl');
  expect(onSessionStateChanged).toHaveBeenCalledTimes(2);
});
