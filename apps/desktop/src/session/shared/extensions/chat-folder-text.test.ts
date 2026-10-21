import { describe, expect, it, vi } from 'vitest';
import { readChatFolderTextWith, type ChatFolderReadPlatform } from './chat-folder-text';

// #7199 「今天」页读私聊文件夹里的 today.json:没有这个文件 ≠ 读不到,两种如实分开;读不到说是哪一步。
type Row = { id: string; kind: string; updated_at: string };

function platform(over: { token?: string | null; rows?: Row[]; listError?: string; fetch?: ChatFolderReadPlatform['fetch'] } = {}) {
  const asked: { token?: string; chat?: string; filename?: string } = {};
  const fetchMock = vi.fn(over.fetch ?? (async () => ({ ok: true, json: async () => ({ text: '' }) }) as Response));
  const p: ChatFolderReadPlatform = {
    token: async () => (over.token === undefined ? 'token-1' : over.token),
    latest: async (token, chat, filename) => {
      Object.assign(asked, { token, chat, filename });
      return over.listError ? { data: null, error: { message: over.listError } } : { data: over.rows ?? [], error: null };
    },
    filesUrl: () => 'https://db.example/files',
    fetch: fetchMock as unknown as ChatFolderReadPlatform['fetch'],
  };
  return { p, asked, fetchMock };
}

const doc: Row = { id: 'item-1', kind: 'document', updated_at: '2026-10-15T00:00:00Z' };

describe('readChatFolderTextWith', () => {
  it('没有这个文件 = null,❌ 去问文件服务', async () => {
    const { p, asked, fetchMock } = platform();
    await expect(readChatFolderTextWith(p, 'chat-1', 'today.json')).resolves.toBeNull();
    expect(asked).toEqual({ token: 'token-1', chat: 'chat-1', filename: 'today.json' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('有就问文件服务要此刻的文本(带登录令牌)', async () => {
    const { p, fetchMock } = platform({ rows: [doc], fetch: async () => ({ ok: true, json: async () => ({ text: '{"version":1}' }) }) as Response });
    await expect(readChatFolderTextWith(p, 'chat-1', 'today.json')).resolves.toEqual({ itemId: 'item-1', updatedAt: '2026-10-15T00:00:00Z', text: '{"version":1}' });
    expect(fetchMock).toHaveBeenCalledWith('https://db.example/files/item-1', { headers: { Authorization: 'Bearer token-1' } });
  });

  it('读不到就说是哪一步:没登录 / 列不出 / 文件服务不答 / 不是文本', async () => {
    await expect(readChatFolderTextWith(platform({ token: null }).p, 'c', 'today.json')).rejects.toMatchObject({ kind: 'signed-out' });
    await expect(readChatFolderTextWith(platform({ listError: 'denied' }).p, 'c', 'today.json')).rejects.toMatchObject({ kind: 'list', message: 'denied' });
    const notFound = platform({ rows: [doc], fetch: async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response });
    await expect(readChatFolderTextWith(notFound.p, 'c', 'today.json')).rejects.toMatchObject({ kind: 'file-service', message: 'HTTP 404' });
    // 窗口里被跨域预检挡住时 fetch 只说「Failed to fetch」:同样落在文件服务这一步。
    const blocked = platform({ rows: [doc], fetch: async () => Promise.reject(new TypeError('Failed to fetch')) });
    await expect(readChatFolderTextWith(blocked.p, 'c', 'today.json')).rejects.toMatchObject({ kind: 'file-service', message: 'Failed to fetch' });
    await expect(readChatFolderTextWith(platform({ rows: [{ ...doc, kind: 'file' }] }).p, 'c', 'today.json')).rejects.toMatchObject({ kind: 'not-text' });
  });
});
