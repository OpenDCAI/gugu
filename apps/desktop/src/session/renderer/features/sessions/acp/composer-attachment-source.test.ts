import { expect, it } from 'vitest';
import { mustCopyRatherThanReference } from '@renderer/lib/pty/terminal-image-paths';
import { composerAttachmentSource } from './composer-attachment-source';

const sourceOf = (originalPath: string, isHeicLike = false) =>
  composerAttachmentSource({ originalPath, mustCopy: mustCopyRatherThanReference(originalPath), isHeicLike });

it('lets the agent work on the person’s own file in place', () => {
  expect(sourceOf('/Users/me/Documents/report.pdf')).toBe('reference');
});

// #985 现场:剪贴板 App 沙盒里的截图被原样写进首轮正文，agent 读它时卡在 macOS「访问其他 App 的数据」弹窗上 114 秒。
it('points the agent at Gugu’s copy for files in another app’s container or a temp folder', () => {
  expect(sourceOf('/Users/apple/Library/Containers/com.wiheads.paste/Data/tmp/images/咕咕 Beta 2026-10-30 00.58.29.png')).toBe('copy');
  expect(sourceOf('/var/folders/ab/cd/T/TemporaryItems/shot.png')).toBe('copy');
  expect(sourceOf('/tmp/notes.txt')).toBe('copy');
});

it('still copies pasted files with no path and HEIC images', () => {
  expect(sourceOf('')).toBe('copy');
  expect(sourceOf('/Users/me/Pictures/photo.heic', true)).toBe('copy');
});
