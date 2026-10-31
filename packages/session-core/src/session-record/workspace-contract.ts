/**
 * #6264 别的电脑打开这台机器上的会话时,工作区里「字节要过线」的那几件的形状(按块读写:预览、上传、下载)
 * 与端口页签、git 署名。文件树、编辑器、git 本身走的是与本机同一套 `workspace.*` 动词。
 *
 * ⚠️ 这个文件要能进浏览器:❌ import 任何带 node 依赖的模块。
 */

/** 读 / 写一段最多这么多字节(base64 后约 700KB)。 */
export const REMOTE_WORKSPACE_CHUNK_BYTES = 512 * 1024;

/**
 * 那台机器上的文件,编辑器最多读 / 写这么大 —— 与本机编辑器的硬上限同一个数
 * (`EDITOR_HARD_MAX_FILE_BYTES`,= `IFileSystem` 的 MAX_READ_BYTES)。
 */
export const REMOTE_WORKSPACE_MAX_FILE_BYTES = 100 * 1024 * 1024;

/**
 * 输入框附件(文件夹按总量)最多这么大 —— 本机会话与别的机器上的会话同一个数
 * (本机落盘那一侧的 `MAX_DROPPED_BLOB_BYTES` 就是它)。
 */
export const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

export type SessionpageWorkspaceEntryKind = 'dir' | 'file' | 'symlink';

export type SessionpageWorkspaceEntry = {
  name: string;
  /** 那台机器上的绝对路径。 */
  path: string;
  kind: SessionpageWorkspaceEntryKind;
  /** 指向目录的符号链接:能展开(与本机文件树一致)。 */
  isDirectory: boolean;
  size: number;
};

export type SessionpageWorkspaceReadRequest = {
  sessionId: string;
  path: string;
  offset: number;
  length: number;
};

/** 写回时的「打开时那一版」:`'*'` = 人已经看过冲突、明确要覆盖。 */
export const WORKSPACE_WRITE_FORCE = '*';

export type SessionpageWorkspaceWriteRequest = {
  sessionId: string;
  path: string;
  /** 这一次保存的代号(桌面生成);同一次保存的各段带同一个。 */
  uploadId: string;
  /** 这一段从第几个字节起(必须紧接上一段)。 */
  offset: number;
  /** base64。 */
  data: string;
  /** 整个文件多少字节。 */
  total: number;
  /** 最后一段:收齐后核对版本、落盘。 */
  final: boolean;
  /** 打开时那一版的 etag;`WORKSPACE_WRITE_FORCE` = 覆盖;null = 这是一个新文件(那台机器上不该已经有它)。 */
  expectedEtag: string | null;
};

/** 写回时版本对不上:error.code 就是它,message 里是那台机器上此刻的 etag。 */
export const WORKSPACE_CONFLICT_CODE = 'conflict';

/** 名字已被占用(新建 / 改名 / 不替换的上传)。 */
export const WORKSPACE_EXISTS_CODE = 'already_exists';

export type SessionpageGitIdentity = { name: string; email: string };

/** 名字与邮箱能不能写进 git 配置:非空、不超过 200 字、没有换行;邮箱里有 @。 */
export function isValidGitIdentity(value: unknown): value is SessionpageGitIdentity {
  if (!value || typeof value !== 'object') return false;
  const { name, email } = value as Record<string, unknown>;
  const ok = (s: unknown): s is string =>
    typeof s === 'string' && s.trim().length > 0 && s.length <= 200 && !/[\r\n\0]/.test(s);
  return ok(name) && ok(email) && /^[^\s@<>]+@[^\s@<>]+$/.test(email.trim());
}

/** #6264 那台机器上有程序在听的一个端口(只报这个账号自己的进程、只报本机回环 / 全部网卡上的)。 */
export type SessionpageListeningPort = {
  port: number;
  /** 程序名(读得到才有;读不到不猜)。 */
  process?: string;
};

export type SessionpageWorkspacePortsResult = {
  /** 那台机器能不能这么查(不是 Linux 就不能:表上只剩转着的与输出里发现的)。 */
  supported: boolean;
  ports: SessionpageListeningPort[];
  /** 咕咕自己的进程在听的端口(钩子 / MCP / 模型中转):输出里冒出来也不当用户服务。旧版 server 没有这一项。 */
  ownPorts?: number[];
};
