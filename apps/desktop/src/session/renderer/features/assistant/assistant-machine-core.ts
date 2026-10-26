// #7199 助理主页读写云电脑上的文件(核心:问哪台、走哪条线由调用方交进来,桌面与手机壳共用):全走那台机器已有的动词(cloudpc.4 起就有,❌ 为这一页另开协议)——
//   列目录 = files.browseDirectory;读、写、删、改名、建夹、分块上传 = 主目录那个项目的 workspace.files.*。
// 助理在主目录里干活(云电脑开通时就是这样建的),所以主目录项目就是它的工作区:管家写的 CLAUDE.md、
// 它的记忆夹、人放给它的资料,都在这个工作区里头,删 / 改名的边界(只能动工作区里的)正好圈住它们。
import { WORKSPACE_WRITE_FORCE } from '@gugu/session-core/session-record/contract';
import type { rpcOn } from '@renderer/lib/ipc';
import type { DirectoryEntry } from '@shared/core/fs/fs';
import type { AssistantHomeKind } from '@gugu/core/shared/assistantPolicy';
import type { AssistantPanelFiles } from '@gugu/core/cloud/assistantPanelFiles';
import { assistantPaths, joinPath, memoryIndexHints, parseMemoryNote, type AssistantPaths, type MemoryNote } from './assistant-files';

/** 问那台机器用的那张路由表:桌面经会话页的线(rpcOn),手机经手机壳的线(sessionpage-rpc 的 machineRpc),同一组动词。 */
export type MachineRpc = Pick<ReturnType<typeof rpcOn>, 'projects' | 'files' | 'workspace' | 'app'>;

export type AssistantMachine = {
  deviceId: string;
  /** 走哪条线问那台(`rpcOn` 的参数):眼前这台 = null(本机);别的 = 它的 id。手机壳不用它(问的线在 `rpc`)。 */
  target?: string | null;
  rpc: MachineRpc | null;
  /** Cloud-backed panel resources. Explicit execution/migration retains native RPC. */
  panel?: AssistantPanelFiles;
  home: string;
  projectId: string;
  workspaceId: string;
  paths: AssistantPaths;
};

/** 那台机器答的失败:带上原因码,界面按码说人话;原话进日志。 */
export class AssistantFileError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function fail(error: { type?: string; message?: string } | string | undefined): never {
  if (typeof error === 'string') throw new AssistantFileError('fs_error', error);
  throw new AssistantFileError(error?.type ?? 'fs_error', error?.message ?? error?.type ?? 'failed');
}

/**
 * 在那台机器的某个项目名下拿到读写用的工作区(项目要已在那台机器的项目表里)。桌面用主目录项目;
 * 手机壳(没有会话页的项目表)用它自己那条会话所在的项目 —— 读 `~/.claude/...` 这类工作区外的文件走 readExternalFile,哪个项目都一样。
 */
export async function openMachineWith(
  rpc: MachineRpc,
  {
    deviceId,
    projectId,
    home,
    workdir,
    kind = 'cloud',
  }: { deviceId: string; projectId: string; home: string; workdir: string; /** 住云上 / 住电脑:它家里几样东西的位置不同(assistantHomePaths)。 */ kind?: AssistantHomeKind }
): Promise<AssistantMachine> {
  const opened = await rpc.projects.openProject(projectId);
  if (!opened.success) fail({ type: 'project', message: 'message' in opened.error ? String(opened.error.message) : opened.error.type });
  const workspaceId = opened.data.repositoryWorkspaceId;
  if (!workspaceId) fail({ type: 'project', message: `no workspace for ${projectId}` });
  // 项目开着 ≠ 工作区在那台机器上登记着:云电脑睡过一觉醒来,只有助理那条会话真跑起来才会登记它。读写动词认的是登记,
  // 所以这里自己领一份(与新建框的工作区面板同一个动词)。❌ 离开时释放 —— 释放 = 拆掉那个工作区,助理自己的会话也在用它。
  const acquired = await rpc.projects.acquireProjectWorkspace(projectId, workspaceId);
  if (!acquired.success) fail({ type: acquired.error.type, message: acquired.error.message });
  return { deviceId, target: deviceId, rpc, home, projectId, workspaceId, paths: assistantPaths(home, workdir, kind) };
}

function isMissing(message: string | undefined): boolean {
  return !!message && /ENOENT|not found|no such file/i.test(message);
}

/** 列一个目录;目录还不存在 = 空(记忆夹、技能夹、资料夹在助理第一次用之前都没有)。 */
export async function listDirectory(machine: AssistantMachine, dir: string): Promise<DirectoryEntry[]> {
  if (machine.panel) return machine.panel.list(dir);
  const result = await nativeRpc(machine).files.browseDirectory({ type: 'local', path: dir });
  if (result.success) return result.data;
  const message = 'message' in result.error ? String(result.error.message) : undefined;
  if (isMissing(message)) return [];
  fail({ type: result.error.type, message });
}

/** 读一个文本文件;不存在 = null。 */
export async function readText(machine: AssistantMachine, path: string): Promise<string | null> {
  if (machine.panel) return machine.panel.text(path);
  const result = await nativeRpc(machine).workspace.files.readExternalFile(machine.projectId, machine.workspaceId, path, 1_048_576);
  if (result.success) return result.data.content;
  const message = 'message' in result.error ? String(result.error.message) : undefined;
  if (isMissing(message)) return null;
  fail({ type: result.error.type, message });
}

export async function writeText(machine: AssistantMachine, path: string, content: string, expectedRevision?: string): Promise<void> {
  if (machine.panel) return machine.panel.write(path,new TextEncoder().encode(content),'text/plain',expectedRevision);
  const result = await nativeRpc(machine).workspace.files.writeExternalFile(machine.projectId, machine.workspaceId, path, content);
  if (!result.success) fail({ type: result.error.type, message: 'message' in result.error ? String(result.error.message) : undefined });
}

export async function removePath(machine: AssistantMachine, path: string, recursive = false): Promise<void> {
  if (machine.panel) return machine.panel.remove(path,recursive);
  const result = await nativeRpc(machine).workspace.files.removeFile(machine.projectId, machine.workspaceId, path, { recursive });
  if (!result.success) fail({ type: result.error.type, message: 'message' in result.error ? String(result.error.message) : undefined });
  if (!result.data.success) fail(result.data.error);
}

export async function renamePath(machine: AssistantMachine, path: string, name: string): Promise<void> {
  if (machine.panel) return machine.panel.rename(path,name);
  const result = await nativeRpc(machine).workspace.files.renameEntry(machine.projectId, machine.workspaceId, path, name);
  if (!result.success) fail({ type: result.error.type, message: 'message' in result.error ? String(result.error.message) : undefined });
}

/** 建一个文件夹;已经有了不算错(资料夹第一次上传时顺手建)。 */
export async function makeFolder(machine: AssistantMachine, dir: string, name: string): Promise<string> {
  if (machine.panel) { const path = joinPath(dir,name); await machine.panel.mkdir(path); return path; }
  const result = await nativeRpc(machine).workspace.files.createEntry(machine.projectId, machine.workspaceId, dir, name, 'folder');
  if (result.success) return result.data.path;
  if (result.error.type === 'exists') return joinPath(dir, name);
  fail({ type: result.error.type, message: 'message' in result.error ? String(result.error.message) : undefined });
}

/** 与会话页文件树上传同一块大小(那台机器一块最多收 512KB)。 */
const CHUNK_BYTES = 512 * 1024;

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** 把这台电脑上选的一个文件分块写到那台机器的 dir 里(同名覆盖:人刚在选择框里挑的就是它)。 */
export async function uploadFile(
  machine: AssistantMachine,
  dir: string,
  file: File,
  onProgress?: (sent: number) => void
): Promise<string> {
  const path = joinPath(dir, file.name);
  if (machine.panel) {
    await machine.panel.write(path,new Uint8Array(await file.arrayBuffer()),file.type || 'application/octet-stream');
    onProgress?.(file.size);
    return path;
  }
  const uploadId = crypto.randomUUID();
  const total = file.size;
  let offset = 0;
  do {
    const slice = new Uint8Array(await file.slice(offset, offset + CHUNK_BYTES).arrayBuffer());
    const final = offset + slice.length >= total;
    const result = await nativeRpc(machine).workspace.files.writeChunk(machine.projectId, machine.workspaceId, {
      path,
      uploadId,
      offset,
      data: toBase64(slice),
      total,
      final,
      expectedEtag: WORKSPACE_WRITE_FORCE,
    });
    if (!result.success) fail({ type: result.error.type, message: 'message' in result.error ? result.error.message : undefined });
    offset += slice.length;
    onProgress?.(offset);
  } while (offset < total);
  return path;
}

export function nativeRpc(machine: AssistantMachine): MachineRpc {
  if (!machine.rpc) throw new AssistantFileError('execution-required','This action requires an execution host');
  return machine.rpc;
}

export type MemoryEntry = MemoryNote & { path: string; modifiedAt: string | null };

function entryTime(entry: DirectoryEntry): string | null {
  const value = (entry as { modifiedAt?: unknown }).modifiedAt;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value).toISOString();
  return null;
}

/** 它的记忆夹:每条一个 .md(新改的在前),外加索引 MEMORY.md;夹子还没有 = 空。 */
export async function readMemoryNotes(machine: AssistantMachine): Promise<{ notes: MemoryEntry[]; index: string | null }> {
  const [entries, index] = await Promise.all([listDirectory(machine, machine.paths.memoryDir), readText(machine, machine.paths.memoryIndex)]);
  const hints = memoryIndexHints(index ?? '');
  // The recovery pointer belongs to the coordinator, not the person's memory cards.
  const files = entries.filter((e) => e.type === 'file' && /\.md$/i.test(e.name)
    && e.name !== 'MEMORY.md' && e.name !== 'working-context.md');
  const notes = await Promise.all(
    files.map(async (entry) => {
      const text = (await readText(machine, entry.path)) ?? '';
      return { ...parseMemoryNote(entry.name, text, hints.get(entry.name)), path: entry.path, modifiedAt: entryTime(entry) };
    })
  );
  notes.sort((a, b) => (b.modifiedAt ?? '').localeCompare(a.modifiedAt ?? ''));
  return { notes, index };
}
