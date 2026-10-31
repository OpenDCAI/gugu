import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { legacySessionHomeDir, migrateLegacySessionHome, sessionHomeDir } from '@main/core/app/session-home-dir';
import { arch, homedir, release } from 'node:os';
import { promisify } from 'node:util';
import { getDiagnosticLogAttachment } from '@main/lib/file-logger';
import { log } from '@main/lib/logger';
import { createRPCController } from '@shared/lib/ipc/rpc';
import type { OpenInAppId } from '@shared/openInApps';
import { resolveWorkspace } from '../projects/utils';
import { appService } from './service';
import { createRemoteDownloads, type RemoteDownloads } from './remote-downloads';
import { readUserLibrary, readUserLibraryEntry, readUserLibraryVolume, writeUserLibraryEntry } from './user-library';
import { callAssistantApp } from './assistant-app';

let downloads: RemoteDownloads | null = null;
const remoteDownloads = (): RemoteDownloads =>
  (downloads ??= createRemoteDownloads({
    saveFile: (defaultPath) => appService.showDownloadSaveDialog(defaultPath),
    pickDirectory: (defaultPath) => appService.showDownloadDirectoryDialog(defaultPath),
    downloadsDir: () => appService.downloadsDir(),
  }));

function failure(error: unknown) {
  return { success: false as const, error: error instanceof Error ? error.message : String(error) };
}

const execFileAsync = promisify(execFile);

async function getPlatformDisplayName(): Promise<string> {
  const architecture = arch();

  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('sw_vers', ['-productVersion']);
      const macOsVersion = stdout.trim();
      if (macOsVersion) return `macOS ${macOsVersion} (${architecture})`;
    } catch {
      // Fall back to the Darwin kernel version when sw_vers is unavailable.
    }
    return `macOS ${release()} (${architecture})`;
  }

  if (process.platform === 'win32') {
    return `Windows ${release()} (${architecture})`;
  }

  if (process.platform === 'linux') {
    return `Linux ${release()} (${architecture})`;
  }

  return `${process.platform} ${release()} (${architecture})`;
}

export const appController = createRPCController({
  assistantAppCall: callAssistantApp,
  openExternal: async (url: string) => {
    try {
      await appService.openExternal(url);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  openFileAccessSettings: async () => {
    try {
      await appService.openFileAccessSettings();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  /** `workspace`:这个文件属于哪个工作区 —— 给了就也放行那个工作区里的路径(它可能在 home 外,#7191)。 */
  openPath: async (path: string, workspace?: { projectId: string; workspaceId: string }) => {
    try {
      const workspaceRoot = workspace
        ? resolveWorkspace(workspace.projectId, workspace.workspaceId)?.path
        : undefined;
      // 说了是哪个工作区却找不到 → 报出来,❌ 悄悄退回只认 home。
      if (workspace && !workspaceRoot) throw new Error(`Workspace is not open: ${workspace.workspaceId}`);
      await appService.openPath(path, workspaceRoot);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  showItemInFolder: async (path: string) => {
    try {
      await appService.showItemInFolder(path);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  readUserFile: async (path: string) => {
    try {
      const result = await appService.readUserFile(path);
      return { success: true as const, ...result };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  /** 消息里那枚缩略图的字节:按绝对路径读一张图,走与 readUserFile 同一道 home jail(#5269)。 */
  readUserImageDataUrl: async (path: string) => {
    try {
      const result = await appService.readUserImageDataUrl(path);
      return { success: true as const, ...result };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  clipboardWriteText: async (text: string) => {
    await appService.clipboardWriteText(text);
    return { success: true };
  },
  showTerminalContextMenu: async (args: {
    requestId: string;
    selectionText?: string | null;
    linkText?: string | null;
    x: number;
    y: number;
  }) => {
    try {
      appService.showTerminalContextMenu(args);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  quit: () => {
    try {
      appService.quit();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  openIn: async (args: { app: OpenInAppId; path: string }) => {
    try {
      await appService.openIn(args);
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  checkInstalledApps: () => appService.checkInstalledApps(),
  listInstalledFonts: async (args?: { refresh?: boolean }) => {
    const { fonts, cached, error } = await appService.listInstalledFonts(args?.refresh);
    return { success: !error, fonts, cached, ...(error ? { error } : {}) };
  },
  openSelectDirectoryDialog: (args: { title: string; message: string; defaultPath?: string }) =>
    appService.openSelectDirectoryDialog(args),
  openSelectAudioFileDialog: (args: { title: string; message: string }) =>
    appService.openSelectAudioFileDialog(args),
  saveTextFile: async (args: { title: string; defaultPath: string; content: string }) => {
    try {
      return { success: true as const, path: await appService.saveTextFile(args) };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  },
  /**
   * #6264 下载别的机器上的文件 / 文件夹:问放哪 → 一段段写 → 收尾(见 remote-downloads.ts)。
   * `target: null` = 人取消了。
   */
  beginRemoteDownload: async (args: { name: string; kind: 'file' | 'folder' }) => {
    try {
      const started = await remoteDownloads().begin(args);
      return { success: true as const, token: started?.token ?? null, target: started?.target ?? null };
    } catch (error) {
      return failure(error);
    }
  },
  writeRemoteDownload: async (args: { token: string; segments: string[]; offset: number; data: string; final: boolean }) => {
    try {
      await remoteDownloads().write(args);
      return { success: true as const };
    } catch (error) {
      return failure(error);
    }
  },
  finishRemoteDownload: async (args: { token: string; ok: boolean }) => {
    try {
      return { success: true as const, target: await remoteDownloads().finish(args) };
    } catch (error) {
      return failure(error);
    }
  },
  readAudioFileDataUrl: async (filePath: string) => {
    try {
      return { success: true, dataUrl: await appService.readAudioFileDataUrl(filePath) };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  },
  minimizeWindow: () => {
    appService.minimizeWindow();
    return { success: true };
  },
  toggleMaximizeWindow: () => {
    appService.toggleMaximizeWindow();
    return { success: true };
  },
  closeWindow: () => {
    appService.closeWindow();
    return { success: true };
  },
  isWindowMaximized: () => appService.isWindowMaximized(),
  getAppVersion: () => appService.getCachedAppVersion(),
  /** 宿主机的家目录(应用内目录浏览器的起点;网页版本机项目用)。 */
  getHomeDirectory: (): string => homedir(),
  getUserLibrary: () => readUserLibrary(),
  getUserLibraryVolume: (kind: import('@shared/user-library').UserLibraryKind) => readUserLibraryVolume(kind),
  readUserLibraryEntry: (kind: import('@shared/user-library').UserLibraryKind, link: string) => readUserLibraryEntry(kind, link),
  writeUserLibraryEntry: (input: import('@shared/user-library').UserLibraryWrite) => writeUserLibraryEntry(input, undefined, 'ui'),
  getElectronVersion: () => process.versions.electron,
  getPlatform: () => process.platform,
  getPlatformDisplayName,
  // The task composer may be used before the user has opened a repository. Keep
  // its internal execution context in app-owned storage rather than mutating the
  // user's home directory or inventing a visible project selection.
  getSessionHomeDir: async () => {
    const path = sessionHomeDir();
    // 旧装法的 task-home 在 `%APPDATA%\咕咕\task-home`(非 ASCII),而那个路径一旦被咕咕
    // 拿去当 cwd 发信任,codex 会把它写进用户全局 config.toml 并在自己的 GBK↔UTF-8 往返里写坏
    // ——详见 session-home-dir.ts。搬一次家就把触发源拿掉;失败不静默:记日志,路径照旧返回新位置,
    // 用户至少看得见「旧文件还在老地方」这条线索。
    try {
      const outcome = migrateLegacySessionHome(legacySessionHomeDir(), path);
      if (outcome === 'moved') {
        log.warn({ from: legacySessionHomeDir(), to: path }, 'task-home moved to an ASCII path');
      }
    } catch (error) {
      log.error(
        { from: legacySessionHomeDir(), to: path, err: (error as Error).message },
        'could not move the legacy non-ASCII task-home; old files remain at the old path',
      );
    }
    await mkdir(path, { recursive: true });
    return path;
  },
  getDiagnosticLogAttachment,
});
