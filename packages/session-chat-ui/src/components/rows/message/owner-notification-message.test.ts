// @vitest-environment jsdom
import { expect, it } from 'vitest';
import type { SegmentCtx } from '@session-chat/core/units';
import type { ChatMessage } from '@session-chat/model';
import { messageFromItem } from './message.def';

it('renders committed owner files as attachments without a streaming placeholder in an active turn', () => {
  const message: ChatMessage = { kind: 'message', id: 'notification', role: 'assistant', text: 'report.html', ownerNotification: {
    requestId: '11111111-1111-4111-8111-111111111111', requestHash: 'hash', sourceTurnId: 'active',
    files: [{ path: '/workspace/.gugu/attachments/request/report.html', name: 'report.html', mimeType: 'text/html', sizeBytes: 10, sha256: 'hash' }],
  } };
  const shown = messageFromItem(message, { active: true } as SegmentCtx);
  expect(shown.streaming).toBe(false);
  expect(shown.text).toBe('');
  expect(shown.attachments).toEqual([{ id: 'path:/workspace/.gugu/attachments/request/report.html', name: 'report.html', kind: 'file' }]);
  expect(messageFromItem({ ...message, text: 'Committed text', ownerNotification: { ...message.ownerNotification!, files: undefined } }, { active: true } as SegmentCtx).streaming).toBe(false);
});
