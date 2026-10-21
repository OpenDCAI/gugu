/**
 * #6264 把别的机器上的文件 / 文件夹下载到这台电脑(照 VS Code 远程资源管理器的「下载...」:文件弹「另存为」,
 * 文件夹选一个目录、整个文件夹原样落进去 —— https://code.visualstudio.com/updates/v1_36#_remote-development)。
 *
 * 字节由会话页一段一段从那台机器读回(与打开文件同一个读动词,SSH 直连或云端中转都行),这里只管落盘:
 *  · `begin` 问人放哪(默认「下载」文件夹),记下这一次下载的落点,交回一个代号;
 *  · `write` 只认代号 + 落点里的相对路径(每一段都是单个名字,❌ `..`、❌ 分隔符)—— 渲染层给不出落点外的路径;
 *  · `finish` 成功就交回落点;失败 / 取消把写了一半的东西删掉,❌ 留半个文件冒充下好了。
 */
import { createWriteStream, type WriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export type DownloadKind = 'file' | 'folder';

export type DownloadDialogs = {
  /** 文件:另存为。返回选的路径;取消 = undefined。 */
  saveFile(defaultPath: string): Promise<string | undefined>;
  /** 文件夹:选一个放它的目录。 */
  pickDirectory(defaultPath: string): Promise<string | undefined>;
  /** 「下载」文件夹(electron 的 app.getPath('downloads'))。 */
  downloadsDir(): string;
};

type Session = {
  kind: DownloadKind;
  target: string;
  streams: Map<string, { stream: WriteStream; written: number }>;
};

function validSegment(segment: string): boolean {
  return !!segment && segment !== '.' && segment !== '..' && !/[\\/\u0000]/.test(segment);
}

/** `dir` 里一个还没被占用的名字:`报告.pdf` → `报告 (1).pdf`(与浏览器下载同一种编号)。 */
export async function freeName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 0; n < 10_000; n += 1) {
    const candidate = path.join(dir, n === 0 ? name : `${stem} (${n})${ext}`);
    try {
      await stat(candidate);
    } catch {
      return candidate;
    }
  }
  throw new Error('no free name');
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((error?: Error | null) => (error ? reject(error) : resolve()));
  });
}

export function createRemoteDownloads(dialogs: DownloadDialogs, newId: () => string = () => crypto.randomUUID()) {
  const sessions = new Map<string, Session>();

  return {
    async begin(args: { name: string; kind: DownloadKind }): Promise<{ token: string; target: string } | null> {
      if (!validSegment(args.name)) throw new Error('invalid name');
      const downloads = (() => {
        try {
          return dialogs.downloadsDir();
        } catch {
          return homedir();
        }
      })();
      let target: string | undefined;
      if (args.kind === 'file') {
        target = await dialogs.saveFile(path.join(downloads, args.name));
      } else {
        const parent = await dialogs.pickDirectory(downloads);
        if (parent) {
          target = await freeName(parent, args.name);
          await mkdir(target, { recursive: true });
        }
      }
      if (!target) return null;
      const token = newId();
      sessions.set(token, { kind: args.kind, target, streams: new Map() });
      return { token, target };
    },

    /**
     * 往这一次下载里写一段。`segments` = 落点里的相对路径(文件夹下载时逐层的名字;单个文件时是空数组)。
     * `offset` 必须紧接着上一段(一段丢了就整次失败,❌ 拼出一个中间缺一块的文件)。
     */
    async write(args: { token: string; segments: string[]; offset: number; data: string; final: boolean }): Promise<void> {
      const session = sessions.get(args.token);
      if (!session) throw new Error('unknown download');
      if (session.kind === 'file' ? args.segments.length !== 0 : args.segments.length === 0) throw new Error('bad path');
      if (!args.segments.every(validSegment)) throw new Error('bad path');
      const file = path.join(session.target, ...args.segments);
      const key = args.segments.join('/');
      let open = session.streams.get(key);
      if (!open) {
        if (args.offset !== 0) throw new Error('missing earlier parts');
        await mkdir(path.dirname(file), { recursive: true });
        open = { stream: createWriteStream(file, { flags: 'w' }), written: 0 };
        session.streams.set(key, open);
      }
      if (args.offset !== open.written) throw new Error('missing earlier parts');
      const bytes = Buffer.from(args.data, 'base64');
      await new Promise<void>((resolve, reject) => {
        open!.stream.write(bytes, (error) => (error ? reject(error) : resolve()));
      });
      open.written += bytes.length;
      if (args.final) {
        session.streams.delete(key);
        await closeStream(open.stream);
      }
    },

    /** 收尾。`ok: false`(失败 / 人取消了)= 删掉写了一半的东西。返回落点(成功时)。 */
    async finish(args: { token: string; ok: boolean }): Promise<string | null> {
      const session = sessions.get(args.token);
      if (!session) return null;
      sessions.delete(args.token);
      for (const { stream } of session.streams.values()) await closeStream(stream).catch(() => undefined);
      if (args.ok) return session.target;
      await rm(session.target, { recursive: true, force: true }).catch(() => undefined);
      return null;
    },

    /** 测试钩子。 */
    pending(): number {
      return sessions.size;
    },
  };
}

export type RemoteDownloads = ReturnType<typeof createRemoteDownloads>;
