import type { ChatFileRef } from './app-files-core';
// #7199 一条聊天文件夹(群文件夹 / 私聊文件夹,`chat.workspace_items`)里某个文件此刻的文本。「助理」App 的「今天」页
// 读和助理那条私聊里的 today.json 用。两处读:桌面在主进程(electron/.../extensions/chat-folder-text.ts),
// 手机 / 网页在窗口里(lib/chatFolder.ts)—— 各自交进令牌、库、文件服务地址,读法只有这一份。
// 此刻的内容只问文件服务(它在自己那边把活文档序列化好,JSON 缩进好),与 App 的 downloadSource、agent 的 workspace__read
// 同一条路;`inline_text` 只是最后一次保存,❌ 当此刻。

export type ChatFolderText = { itemId: string; updatedAt: string; text: string };

/** 读不到是哪一步:没登录 / 列不出 / 文件服务不答 / 那是存的文件不是文本。 */
export type ChatFolderReadKind = 'signed-out' | 'list' | 'file-service' | 'not-text';

export class ChatFolderReadError extends Error {
  constructor(
    readonly kind: ChatFolderReadKind,
    message: string,
    readonly status?: number
  ) {
    super(message);
    this.name = 'ChatFolderReadError';
  }
}

type ItemRow = { id: string; kind: string; updated_at: string };

export interface ChatFolderReadPlatform {
  /** 此刻登录着的令牌;没登录 = null。 */
  token(): Promise<string | null>;
  /** 这条聊天文件夹里叫 filename 的、最近改的那一行(以这个令牌的身份问库)。 */
  find(token: string, ref: ChatFileRef): Promise<{ data: ItemRow[] | null; error: { message: string } | null }>;
  /** 文件服务在哪(不带末尾斜杠)。 */
  filesUrl(): string;
  fetch: typeof fetch;
}

/**
 * 这条聊天文件夹里叫 `filename` 的那个文件此刻的文本;没有这个文件 = null(还没人写过,❌ 当成读失败)。
 * 同名不止一个时取最近改的那个。读不到就抛 ChatFolderReadError,由看的一方说是哪一步。
 */
export async function readChatFolderTextWith(platform: ChatFolderReadPlatform, ref: ChatFileRef): Promise<ChatFolderText | null> {
  const token = await platform.token();
  if (!token) throw new ChatFolderReadError('signed-out', 'Not signed in');
  const { data, error } = await platform.find(token, ref);
  if (error) throw new ChatFolderReadError('list', error.message);
  const row = (data ?? [])[0];
  if (!row) return null;
  if (row.kind !== 'document') throw new ChatFolderReadError('not-text', `${row.id} is a stored file, not a text document`);
  const text = await readDocumentText(platform, token, row.id);
  return { itemId: row.id, updatedAt: row.updated_at, text };
}

/** The file service's current text: the same read used by App download, previews and folder reads. */
export async function readDocumentText(platform: Pick<ChatFolderReadPlatform, 'filesUrl' | 'fetch'>, token: string, itemId: string, asAgent?: string | null): Promise<string> {
  const res = await platform.fetch(`${platform.filesUrl()}/${encodeURIComponent(itemId)}`, {
    headers: { Authorization: `Bearer ${token}`, ...(asAgent ? { 'X-Gugu-As-Agent': asAgent } : {}) },
  }).catch((cause: unknown) => {
    throw new ChatFolderReadError('file-service', cause instanceof Error ? cause.message : String(cause));
  });
  if (!res.ok) throw new ChatFolderReadError('file-service', `HTTP ${res.status}`, res.status);
  const body = (await res.json()) as { text?: unknown };
  if (typeof body.text !== 'string') throw new ChatFolderReadError('file-service', 'no text in the answer');
  return body.text;
}

/** 问库那一句(两处都用 chat schema 的 workspace_items)。 */
export const CHAT_FOLDER_ITEM_COLUMNS = 'id, kind, updated_at';
