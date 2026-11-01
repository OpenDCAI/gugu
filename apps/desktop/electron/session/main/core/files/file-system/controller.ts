import { isFileNotFoundError } from '@gugu/session-core/files';
import { err, ok } from '@gugu/session-shared';
import { events } from '@main/lib/events';
import { planEventChannel } from '@shared/events/appEvents';
import { createRPCController } from '@shared/lib/ipc/rpc';
import { resolveWorkspace } from '../../projects/utils';
import { workspaceFileIndexService } from '@main/core/search/workspace-file-index-service';
import { fileErrorToMessage, isPermissionDenied } from './file-errors';
import { readInlineBinaryDataUrl, readWorkspaceImage } from './image-support';
import { copyLocalFilesToWorkspace } from './local-imports';
import {
  assertWorkspaceRemoveAllowed,
  assertWorkspaceWriteAllowed,
  resolveWorkspacePath,
} from './workspace-file-policy';
import { dirnameMachinePath, isAbsoluteMachinePath, joinMachinePath } from '../path-utils';
import { createChatFolderPreview, createDocumentPreview, createPreview, createRemotePreview, previewAssetsChanged, releasePreview, setPreviewDocument, type PreviewFailureCopy } from '../preview-protocol';
import {
  createWorkspaceUploads,
  readWorkspaceChunk,
  WorkspaceTransferError,
  type WorkspaceWriteChunk,
} from '../workspace-transfer';

const uploads = createWorkspaceUploads();
/** watchDirectory 的租约:id → 撤掉它。 */
const directoryWatches = new Map<string, () => void>();

/** 分块读写的失败:原因码原样带回(那台电脑据此说「在目录外 / 被改过 / 太大」)。 */
async function transfer<T>(run: () => Promise<T>) {
  try {
    return ok(await run());
  } catch (error) {
    const type = error instanceof WorkspaceTransferError ? error.code : 'internal_error';
    return err({ type, message: (error as Error)?.message ?? String(error) });
  }
}

/** 一段名字:非空、不是 . / ..、不含分隔符(新建与改名都只在同一个目录里)。 */
function isSingleSegmentName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed === name && name !== '.' && name !== '..' && !/[\\/\0]/.test(name);
}

function resolveWorkspaceFiles(projectId: string, workspaceId: string) {
  const env = resolveWorkspace(projectId, workspaceId);
  if (!env)
    return err({ type: 'not_found' as const, entity: 'filesystem' as const, detail: undefined });

  return ok({ env, fileSystem: env.fileSystem });
}

export const workspaceFileSystemController = createRPCController({
  /** 已授权读出的群正文:没有项目、目录或文件系统权限。 */
  createDocumentPreview: async (documentHtml: string) => ok(createDocumentPreview(documentHtml)),
  /** A document in a chat's folder, previewed with the files beside it (its place read here, as the signed-in person). */
  createChatFolderPreview: async (itemId: string, documentHtml: string, failureCopy: PreviewFailureCopy) => {
    const created = await createChatFolderPreview(itemId, documentHtml, failureCopy);
    return created ? ok(created) : err({ type: 'not_found' as const, message: 'This document is not in a chat folder you can read' });
  },
  readExternalFile: async (
    projectId: string,
    workspaceId: string,
    filePath: string,
    maxBytes?: number
  ) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    if (!isAbsoluteMachinePath(filePath)) {
      return err({ type: 'fs_error' as const, message: 'External file path must be absolute' });
    }
    const result = await resolved.data.fileSystem.readText(filePath, { maxBytes });
    if (!result.success) {
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(result.error) });
    }
    return ok(result.data);
  },

  /**
   * 写一个工作区**之外**的文件。
   *
   * 与 `writeFile` 的分工是故意的:那条是 agent 的计划要走的路,所以有「必须落在工作区里」
   * 那道闸 —— 圈住 agent 能改什么,是在控爆炸半径。这条是用户在编辑器里按下保存,改的是
   * 他自己机器上的文件,那道闸不该套到人身上(#5585)。
   *
   * 寻址与 `readExternalFile` 同一条分岔:绝对路径按原样写,❌ 不另立第三种寻址方式。
   */
  writeExternalFile: async (
    projectId: string,
    workspaceId: string,
    filePath: string,
    content: string
  ) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    if (!isAbsoluteMachinePath(filePath)) {
      return err({ type: 'fs_error' as const, message: 'External file path must be absolute' });
    }
    const result = await resolved.data.fileSystem.writeText(filePath, content);
    if (!result.success) {
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(result.error) });
    }
    return ok({ success: true as const, bytesWritten: result.data.bytesWritten });
  },

  /**
   * 给一份 HTML 文档登记一次网页预览,拿回它的 `gugu-preview://` 地址(#6156)。
   *
   * 预览此前把整页字符串塞进 `srcdoc`,文档因此没有自己的地址 —— 相对资源要手工内联、
   * 页内锚点会把 iframe 整个导走。换成真地址之后这两件事都归浏览器,渲染层只剩「拿地址」。
   */
  createPreview: async (
    projectId: string,
    workspaceId: string,
    filePath: string,
    documentHtml?: string
  ) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    const preview = createPreview(projectId, workspaceId, filePath, documentHtml);
    if (!preview) {
      return err({ type: 'fs_error' as const, message: 'Could not resolve a preview URL' });
    }
    return ok(preview);
  },

  /**
   * #6264 别的机器上一条会话的工作目录登记一次网页预览:「文件」页签的 HTML 预览(`pane`,带文档)
   * 或「浏览器」页签加载那台机器上的 `file:` 网页(`browser`)。字节经会话工作区的读文件动词取,
   * 路径边界由那台机器核(见 preview-protocol.ts 的 createRemotePreview)。
   */
  createRemotePreview: async (input: {
    projectId: string;
    workspaceId: string;
    root: string;
    surface: 'pane' | 'browser';
    documentPath?: string;
    documentHtml?: string;
    /** 取不到时页里那一句(按界面语言写好)。 */
    failureCopy?: { unavailable: string; outside: string };
  }) => {
    const preview = createRemotePreview(input);
    if (!preview) {
      return err({ type: 'fs_error' as const, message: 'Could not resolve a preview URL' });
    }
    return ok(preview);
  },

  /** 编辑器里的正文变了 —— 下一次取这份文档发新的(预览看的是缓冲区,不是磁盘)。 */
  setPreviewDocument: async (previewId: string, documentHtml: string) => {
    setPreviewDocument(previewId, documentHtml);
    return ok({ success: true as const });
  },

  previewAssetsChanged: async (previewId: string, changedPaths?: string[]) =>
    ok(await previewAssetsChanged(previewId, changedPaths)),

  /** tab 关掉就撤登记 —— 留着等于那份文件一直可被取。 */
  releasePreview: async (previewId: string) => {
    releasePreview(previewId);
    return ok({ success: true as const });
  },

  /**
   * #6264 按块读一份文件(别的电脑上的预览、下载):字节过线要分块,单帧有上限。
   * 路径可以是工作区里的相对路径,也可以是落在工作区里的绝对路径。
   */
  readChunk: async (projectId: string, workspaceId: string, request: { path: string; offset: number; length: number }) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    return transfer(() => readWorkspaceChunk(resolved.data.env.path, request));
  },

  /** #6264 按块写一份文件(从别的电脑上传 / 在别的电脑上存大文件),最后一段落盘并核版本。 */
  writeChunk: async (projectId: string, workspaceId: string, request: WorkspaceWriteChunk) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    return transfer(() => uploads.write(resolved.data.env.path, request));
  },

  readFile: async (projectId: string, workspaceId: string, filePath: string, maxBytes?: number) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    const { env, fileSystem } = resolved.data;

    const target = resolveWorkspacePath(env.path, filePath);
    if (!target.success) {
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(target.error) });
    }

    const result = await fileSystem.readText(target.data.path, { maxBytes });
    if (!result.success) {
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(result.error) });
    }
    return ok(result.data);
  },

  writeFile: async (projectId: string, workspaceId: string, filePath: string, content: string) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    const { env, fileSystem } = resolved.data;

    const target = await assertWorkspaceWriteAllowed(fileSystem, env.path, filePath);
    if (!target.success) {
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(target.error) });
    }

    const result = await fileSystem.writeText(target.data.path, content);
    if (!result.success) {
      if (isPermissionDenied(result.error)) {
        events.emit(planEventChannel, {
          type: 'write_blocked' as const,
          root: projectId,
          path: filePath,
          message: result.error.message,
        });
      }
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(result.error) });
    }
    return ok({ success: true as const, bytesWritten: result.data.bytesWritten });
  },

  removeFile: async (
    projectId: string,
    workspaceId: string,
    filePath: string,
    options?: { recursive?: boolean }
  ) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    const { env, fileSystem } = resolved.data;

    const target = await assertWorkspaceRemoveAllowed(fileSystem, env.path, filePath);
    if (!target.success) {
      return ok({ success: false as const, error: fileErrorToMessage(target.error) });
    }

    const result = await fileSystem.remove(target.data.path, options);
    if (!result.success) {
      if (isPermissionDenied(result.error)) {
        events.emit(planEventChannel, {
          type: 'remove_blocked' as const,
          root: projectId,
          path: filePath,
          message: result.error.message,
        });
      }
      return ok({ success: false as const, error: fileErrorToMessage(result.error) });
    }
    return ok({ success: true as const });
  },

  /**
   * 读一张图给界面显示。
   *
   * 寻址与 `readInlineBinary` / `readExternalFile` 同一条分岔:绝对路径按原样读,
   * 相对路径按工作区解析。❌ 不另立第三种寻址方式。
   *
   * 这一支是 #5814 补的:此前只有工作区那一条,于是工作区外的 HTML 预览里,
   * 页面引用的图一律裂图 —— 而同一个文件用浏览器面板打开却正常,
   * 产品甚至允许用户改写并保存那张图。拦住「看」而放行「改」不是边界,是漏掉的旧管道。
   */
  readImage: async (projectId: string, workspaceId: string, filePath: string) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    const { env, fileSystem } = resolved.data;

    if (isAbsoluteMachinePath(filePath)) {
      return await readWorkspaceImage(fileSystem, filePath);
    }

    const target = resolveWorkspacePath(env.path, filePath);
    if (!target.success) {
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(target.error) });
    }

    return await readWorkspaceImage(fileSystem, target.data.path);
  },

  /**
   * 把一份图片或 PDF 读成 data URL,交给界面里的渲染器(#5269)。
   *
   * 绝对路径按原样读(附件的副本、任何工作区之外的文件都是这一支),相对路径按工作区解析 ——
   * 与 `readExternalFile` / `readFile` 那一对是同一条分岔,❌ 不另立第三种寻址方式。
   */
  readInlineBinary: async (projectId: string, workspaceId: string, filePath: string) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    const { env, fileSystem } = resolved.data;

    if (isAbsoluteMachinePath(filePath)) {
      return await readInlineBinaryDataUrl(fileSystem, filePath);
    }
    const target = resolveWorkspacePath(env.path, filePath);
    if (!target.success) {
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(target.error) });
    }
    return await readInlineBinaryDataUrl(fileSystem, target.data.path);
  },

  /**
   * 「界面在看这个目录」(打开着的文件所在的目录,见 Workspace.watchDirectory)。返回一个租约 id,
   * 页签关掉时 `releaseDirectoryWatch`;工作区 dispose 时没撤的一并撤掉。
   */
  watchDirectory: async (projectId: string, workspaceId: string, dirPath: string) => {
    const env = resolveWorkspace(projectId, workspaceId);
    if (!env) return err({ type: 'not_found' as const, entity: 'filesystem' as const, detail: undefined });
    const watched = env.watchDirectory(dirPath);
    if (!watched.success) return err({ type: 'fs_error' as const, message: fileErrorToMessage(watched.error) });
    const leaseId = crypto.randomUUID();
    directoryWatches.set(leaseId, watched.data);
    return ok({ leaseId });
  },

  // projectId / workspaceId 只用来把这一调路由到开租约的那台机器(与 watchDirectory 同一条)。
  releaseDirectoryWatch: async (_projectId: string, _workspaceId: string, leaseId: string) => {
    directoryWatches.get(leaseId)?.();
    directoryWatches.delete(leaseId);
  },

  /**
   * 「这个工作区下面可能变过」:窗口回到眼前、改动面板 / 搜索被打开时界面发来。git status、App 这些粗粒度
   * 订阅各重算一次;`reindex`(搜索被打开)且这一下兑现了,再让文件索引重扫一遍,扫完才返回 `rescanned: true`
   * —— 没人盯着的目录里新建的文件靠这一步进索引,界面据此把搜索再查一次。
   */
  nudgeWorkspace: async (projectId: string, workspaceId: string, options?: { reindex?: boolean }) => {
    const env = resolveWorkspace(projectId, workspaceId);
    if (!env) return err({ type: 'not_found' as const, entity: 'filesystem' as const, detail: undefined });
    const honored = await env.nudge();
    // 只有这一下真的兑现了(一个目录一个 watch 的平台),索引才可能缺东西;否则它由变化流实时维护,❌ 白扫。
    const rescanned = honored && !!options?.reindex;
    if (rescanned) await workspaceFileIndexService.reindex(workspaceId);
    return ok({ rescanned });
  },

  fileExists: async (projectId: string, workspaceId: string, filePath: string) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    const { env, fileSystem } = resolved.data;

    const target = resolveWorkspacePath(env.path, filePath);
    if (!target.success) {
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(target.error) });
    }

    // 存在性顺带回答「是不是目录」:调用方要用它决定目录走系统文件管理器而不是编辑器
    // tab(目录塞进编辑器只会开出永远 Loading 的页签)。missing 时 isDirectory 恒为 false。
    const result = await fileSystem.stat(target.data.path);
    if (!result.success) {
      if (isFileNotFoundError(result.error)) {
        return ok({ exists: false, isDirectory: false });
      }
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(result.error) });
    }
    return ok({ exists: true, isDirectory: result.data.type === 'directory' });
  },

  /**
   * 工作区**之外**那条绝对路径是什么(stat):不存在 / 目录 / 普通文件。
   * 与 `readExternalFile` 同一条分岔、同一个 fileSystem —— 外部文件 tab 读它读的那份,
   * 点开路由判断(缺失 toast、目录→系统文件管理器)也问它,❌ 不另立第三种寻址方式。
   */
  statExternalFile: async (projectId: string, workspaceId: string, filePath: string) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    if (!isAbsoluteMachinePath(filePath)) {
      return err({ type: 'fs_error' as const, message: 'External file path must be absolute' });
    }
    const { fileSystem } = resolved.data;
    const result = await fileSystem.stat(filePath);
    if (!result.success) {
      if (isFileNotFoundError(result.error)) {
        return ok({ exists: false, isDirectory: false });
      }
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(result.error) });
    }
    return ok({ exists: true, isDirectory: result.data.type === 'directory' });
  },

  /**
   * 工作区里一条路径的真实绝对路径(跟随符号链接)。`.` / 空串 = 工作区根本身 —— 只读的查询,根是合法答案
   * (#6264 别的机器上的会话问「这条会话的工作目录在那台机器上是哪儿」就靠它;「不许为空」那道闸是给写/删用的)。
   */
  getAbsolutePath: async (projectId: string, workspaceId: string, filePath: string) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    const { env, fileSystem } = resolved.data;

    const target = resolveWorkspacePath(env.path, filePath, { allowEmpty: true });
    if (!target.success) {
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(target.error) });
    }

    const result = await fileSystem.realPath(target.data.path);
    if (!result.success) {
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(result.error) });
    }
    return ok({ path: result.data });
  },

  /**
   * 文件树里「新建文件 / 新建文件夹」(照 VS Code 资源管理器,#6264 与别的机器上的会话同一套界面)。
   * 名字只给一段(不含分隔符),目录给绝对路径;完整路径在这里拼,落点必须仍在工作区里。
   * 同名已有 = `exists`,❌ 覆盖。
   */
  createEntry: async (
    projectId: string,
    workspaceId: string,
    dirPath: string,
    name: string,
    kind: 'file' | 'folder'
  ) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    const { env, fileSystem } = resolved.data;
    if (!isSingleSegmentName(name)) return err({ type: 'invalid_name' as const, message: 'Invalid name' });
    const target = await assertWorkspaceWriteAllowed(fileSystem, env.path, joinMachinePath(dirPath, name));
    if (!target.success) return err({ type: 'fs_error' as const, message: fileErrorToMessage(target.error) });
    const exists = await fileSystem.exists(target.data.path);
    if (exists.success && exists.data) return err({ type: 'exists' as const, message: 'Name already exists' });
    const made =
      kind === 'folder'
        ? await fileSystem.mkdir(target.data.path)
        : await fileSystem.writeText(target.data.path, '');
    if (!made.success) return err({ type: 'fs_error' as const, message: fileErrorToMessage(made.error) });
    return ok({ path: target.data.path });
  },

  /** 文件树里「重命名」(同一个目录里换名字)。同名已有 = `exists`。 */
  renameEntry: async (projectId: string, workspaceId: string, filePath: string, name: string) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    const { env, fileSystem } = resolved.data;
    if (!isSingleSegmentName(name)) return err({ type: 'invalid_name' as const, message: 'Invalid name' });
    const source = await assertWorkspaceRemoveAllowed(fileSystem, env.path, filePath);
    if (!source.success) return err({ type: 'fs_error' as const, message: fileErrorToMessage(source.error) });
    const target = await assertWorkspaceWriteAllowed(
      fileSystem,
      env.path,
      joinMachinePath(dirnameMachinePath(source.data.path), name)
    );
    if (!target.success) return err({ type: 'fs_error' as const, message: fileErrorToMessage(target.error) });
    const moved = await fileSystem.rename(source.data.path, target.data.path);
    if (!moved.success) {
      if (moved.error.type === 'fs-error' && moved.error.code === 'EEXIST') {
        return err({ type: 'exists' as const, message: 'Name already exists' });
      }
      return err({ type: 'fs_error' as const, message: fileErrorToMessage(moved.error) });
    }
    return ok({ path: target.data.path });
  },

  copyLocalFiles: async (
    projectId: string,
    workspaceId: string,
    srcPaths: string[],
    destDirPath: string,
    options?: { overwrite?: boolean }
  ) => {
    const resolved = resolveWorkspaceFiles(projectId, workspaceId);
    if (!resolved.success) return resolved;
    const { env, fileSystem } = resolved.data;

    return await copyLocalFilesToWorkspace(fileSystem, env.path, srcPaths, destDirPath, options);
  },
});
