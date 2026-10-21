import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AttachmentMimeType, AttachmentRef } from '@gugu/session-core/acp';
import type { AttachmentStore, StoredAttachment } from '../runtime/attachment-store';

/**
 * 一件 ACP 附件在盘上的记录。字节一律存一份(#5269,owner 2026-09-10 拍板)。
 * 那之前写下的 `kind: 'reference'` 记录(只记着用户盘上的路径,不存字节)不再读:载入时跳过,
 * 下一次写索引时随之消失 —— 09-10 前老消息里的图因此点不开,owner 接受(2026-10-17)。
 */
type AttachmentRecord = {
  ref: AttachmentRef;
  createdAt: number;
  /** 用户自己盘上那个文件在哪(拖进来的才有)。只作来历,❌ 不是取字节的地方。 */
  originalPath?: string;
  source: { kind: 'copy'; storedPath: string };
};

export class LocalAttachmentStore implements AttachmentStore {
  private readonly indexPath: string;
  private readonly objectsDir: string;
  private readonly records = new Map<string, AttachmentRecord>();
  private loadPromise: Promise<void> | null = null;
  private persistQueue = Promise.resolve();

  constructor(private readonly rootDir: string) {
    this.indexPath = join(rootDir, 'index.json');
    this.objectsDir = join(rootDir, 'objects');
  }

  async put(input: {
    data?: Uint8Array;
    name?: string;
    mimeType: AttachmentMimeType;
    originalPath?: string;
  }): Promise<AttachmentRef> {
    await this.ensureLoaded();
    const id = crypto.randomUUID();
    const ref: AttachmentRef = {
      id,
      name: input.name ?? (input.originalPath ? basename(input.originalPath) : 'attachment'),
      mimeType: input.mimeType,
    };

    // 一律存一份:调用方给了字节就用它,只给了路径就自己读一份进来。
    // ❌ 不再「有原路径就只记指向」—— 那条记录会随着用户挪走/删掉那个文件当场作废,
    // 而消息里那张图是要长期画得出来的。
    if (!input.data && !input.originalPath) {
      throw new Error('Attachment needs either its bytes or a path to read them from');
    }
    const data = input.data ?? new Uint8Array(await readFile(input.originalPath as string));

    await mkdir(this.objectsDir, { recursive: true });
    const storedPath = join(this.objectsDir, id);
    await writeFile(storedPath, data);
    this.records.set(id, {
      ref,
      createdAt: Date.now(),
      ...(input.originalPath ? { originalPath: input.originalPath } : {}),
      source: { kind: 'copy', storedPath },
    });
    await this.persist();
    return ref;
  }

  async get(id: string): Promise<StoredAttachment | null> {
    await this.ensureLoaded();
    const record = this.records.get(id);
    if (!record) return null;
    try {
      return { ref: record.ref, data: new Uint8Array(await readFile(record.source.storedPath)) };
    } catch (error) {
      // 副本不在了(用户清过 userData)= 取不到,消息里退回占位块;读不了(权限等)照实抛。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(id: string): Promise<void> {
    await this.ensureLoaded();
    const record = this.records.get(id);
    if (!record) return;
    this.records.delete(id);
    await unlink(record.source.storedPath).catch(() => undefined);
    await this.persist();
  }

  private async ensureLoaded(): Promise<void> {
    this.loadPromise ??= this.load();
    await this.loadPromise;
  }

  private async load(): Promise<void> {
    await mkdir(this.objectsDir, { recursive: true });
    let contents: string;
    try {
      contents = await readFile(this.indexPath, 'utf8');
    } catch {
      return;
    }

    const parsed: unknown = JSON.parse(contents);
    if (!Array.isArray(parsed)) return;
    for (const value of parsed) {
      if (isAttachmentRecord(value)) {
        this.records.set(value.ref.id, value);
      }
    }
  }

  private persist(): Promise<void> {
    this.persistQueue = this.persistQueue.then(async () => {
      await mkdir(this.rootDir, { recursive: true });
      const tmpPath = `${this.indexPath}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmpPath, JSON.stringify([...this.records.values()], null, 2));
      await rename(tmpPath, this.indexPath);
    });
    return this.persistQueue;
  }
}

function isAttachmentRecord(value: unknown): value is AttachmentRecord {
  if (!value || typeof value !== 'object') return false;
  const record = value as AttachmentRecord;
  if (!record.ref || typeof record.ref.id !== 'string') return false;
  if (typeof record.ref.name !== 'string' || typeof record.ref.mimeType !== 'string') return false;
  if (!record.source || typeof record.source !== 'object') return false;
  return record.source.kind === 'copy' && typeof record.source.storedPath === 'string';
}
