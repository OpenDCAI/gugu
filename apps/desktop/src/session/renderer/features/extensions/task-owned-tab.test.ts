import { describe, expect, it } from 'vitest';
import { isTaskOwnedTab } from './task-owned-tab';

/**
 * #7317 真机(617c47bc):「电脑」页签右键「在新窗口打开」开出一扇只有这枚页签的空白窗 —— 它那一页只在它的任务里。
 * 一个任务一份的 App 页签认的是页签自己身上的标记,所以 App 清单还没到时也不会被当成能成窗的普通 App 页签。
 */
describe('#7317 a tab that is one per task stays in its task', () => {
  it('is the App tab marked per task, and nothing else', () => {
    expect(isTaskOwnedTab({ kind: 'computer-use.preview', state: { perSession: true } })).toBe(true);
    // Controls: an App's ordinary tab, an App tab with a file, a built-in tab that somehow carries the mark.
    expect(isTaskOwnedTab({ kind: 'computer-use.preview' })).toBe(false);
    expect(isTaskOwnedTab({ kind: 'office.doc', state: { filePath: '/a.docx' } })).toBe(false);
    expect(isTaskOwnedTab({ kind: 'terminal', state: { perSession: true } })).toBe(false);
  });
});
