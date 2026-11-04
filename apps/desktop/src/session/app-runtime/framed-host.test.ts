import { expect, it } from 'vitest';
import { messageHost } from './framed-host';
import { APP_FRAME_MARKER, type FrameToHost } from '@shared/extensions/app-runtime-protocol';

it('exposes task resource creation only to a program and packs opening its own pages without a task selector', async () => {
  const frames: FrameToHost[] = [];
  let deliver: (message: unknown) => void = () => {};
  const host = messageHost({ post: frame => frames.push(frame), listen: fn => { deliver = fn; } }, { program: true });
  const show = host.showTaskPages as () => Promise<string[]>;
  expect(typeof show).toBe('function');
  const opening = show();
  expect(frames[0]).toMatchObject({ method: 'showTaskPages', args: {} });
  const frame = frames[0] as Extract<FrameToHost, { t: 'call' }>;
  deliver({ m: APP_FRAME_MARKER, t: 'result', id: frame.id, ok: true, value: ['own.preview'] });
  await expect(opening).resolves.toEqual(['own.preview']);
  const page = messageHost({ post: () => {}, listen: () => {} }, { framed: true, session: true });
  expect(page.showTaskPages).toBeUndefined();
  expect(page.pages).toBeUndefined();
});
