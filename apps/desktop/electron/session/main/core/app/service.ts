import { exec } from 'node:child_process';
import { readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, isAbsolute, join, resolve, sep } from 'node:path';
import type { IDisposable, IInitializable } from '@gugu/session-shared';
import { app, clipboard, dialog, shell } from 'electron';
import { getMainWindow } from '@main/app/window';
import { showContentContextMenu } from '../../../../content-context-menu';
import { textContextMenuItems } from '../../../../text-context-menu';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { buildExternalToolEnv } from '@main/utils/childProcessEnv';
import {
  appPasteChannel,
  appRedoChannel,
  appUndoChannel,
  terminalContextMenuActionChannel,
  type TerminalContextMenuAction,
} from '@shared/events/appEvents';
import {
  getAppById,
  getResolvedLabel,
  OPEN_IN_APPS,
  type OpenInAppId,
  type PlatformConfig,
  type PlatformKey,
} from '@shared/openInApps';
import {
  checkCommand,
  checkMacApp,
  checkMacAppByName,
  checkMacMdfindQuery,
  checkWindowsVisualStudio,
  execFileCommand,
  listInstalledFontsAll,
  resolveAppVersion,
  resolveWindowsVsProductPath,
  spawnDetachedCommand,
} from './utils';
import { systemSettingsUrl } from '../../../../../shared/system-settings-urls';

const FONT_CACHE_TTL_MS = 5 * 60 * 1_000;
const MAX_AUDIO_FILE_BYTES = 20 * 1024 * 1024;

const AUDIO_MIME_TYPES: Record<string, string> = {
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

/**
 * @@@electron44-clipboard (#4394) — electron 44 起 clipboard.writeText 返回 Promise。
 * 原生菜单的 click 回调是同步的、返回值没人看,所以这里确实是 fire-and-forget;
 * 但**失败必须留下痕迹** —— 裸调用会让 rejection 变成 unhandled,复制悄悄没发生而没人知道。
 */
function copyTextFireAndForget(text: string): void {
  void clipboard.writeText(text).catch((error: unknown) => {
    log.error('clipboard.writeText failed', { error: String(error) });
  });
}

function expandAbsoluteOrTildePath(rawPath: string): string {
  if (!rawPath || typeof rawPath !== 'string') throw new Error('Invalid path');
  const expanded = rawPath.startsWith('~/') ? join(homedir(), rawPath.slice(2)) : rawPath;
  if (!isAbsolute(expanded)) throw new Error('Path must be absolute or start with ~/');
  return expanded;
}

async function resolveHomeJailedPath(rawPath: string): Promise<string> {
  const expanded = expandAbsoluteOrTildePath(rawPath);
  const realPath = await realpath(expanded);
  const realHome = await realpath(homedir());
  const realHomeWithSep = realHome.endsWith(sep) ? realHome : realHome + sep;
  if (realPath !== realHome && !realPath.startsWith(realHomeWithSep)) {
    throw new Error('Path must be inside the user home directory');
  }
  return realPath;
}

/**
 * 「用系统默认程序打开」能开的:home 里的,或者(给了工作区根目录时)这个工作区里的(#7191)。
 * 工作区是人自己选的目录,常在 home 外(外接盘、/opt、Windows 的 D:\)—— 只认 home 的话,
 * 那里的文件在占位卡和「用 Office 软件打开」上给出的下一步永远打不开。
 */
async function resolveOpenablePath(rawPath: string, workspaceRoot?: string): Promise<string> {
  if (workspaceRoot) {
    const [realPath, realRoot] = await Promise.all([
      realpath(expandAbsoluteOrTildePath(rawPath)),
      realpath(workspaceRoot),
    ]);
    const rootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (realPath === realRoot || realPath.startsWith(rootWithSep)) return realPath;
  }
  return resolveHomeJailedPath(rawPath);
}

type RemoteTerminalLaunchAttempt = {
  file: string;
  args: string[];
};

/** 缩略图能画出来的那几种(#5269)。表在这里而不是复用拖放那份:那一份还管 HEIC 转码。 */
const IMAGE_MIME_BY_EXTENSION: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
};

class AppService implements IInitializable, IDisposable {
  private cachedAppVersion: string | null = null;
  private cachedAppVersionPromise: Promise<string> | null = null;
  private cachedInstalledFonts: { fonts: string[]; fetchedAt: number } | null = null;
  private _unsubscribes: Array<() => void> = [];

  initialize(): void {
    void this.getCachedAppVersion();

    this._unsubscribes = [
      events.on(appUndoChannel, () => {
        getMainWindow()?.webContents.undo();
      }),
      events.on(appRedoChannel, () => {
        getMainWindow()?.webContents.redo();
      }),
      events.on(appPasteChannel, () => {
        getMainWindow()?.webContents.paste();
      }),
    ];
  }

  dispose(): void {
    for (const unsub of this._unsubscribes) unsub();
    this._unsubscribes = [];
  }

  getCachedAppVersion(): Promise<string> {
    if (this.cachedAppVersion) return Promise.resolve(this.cachedAppVersion);
    if (!this.cachedAppVersionPromise) {
      this.cachedAppVersionPromise = resolveAppVersion().then((version) => {
        this.cachedAppVersion = version;
        return version;
      });
    }
    return this.cachedAppVersionPromise;
  }

  async listInstalledFonts(
    refresh?: boolean
  ): Promise<{ fonts: string[]; cached: boolean; error?: string }> {
    const now = Date.now();
    if (
      !refresh &&
      this.cachedInstalledFonts &&
      now - this.cachedInstalledFonts.fetchedAt < FONT_CACHE_TTL_MS
    ) {
      return { fonts: this.cachedInstalledFonts.fonts, cached: true };
    }
    try {
      const fonts = await listInstalledFontsAll();
      this.cachedInstalledFonts = { fonts, fetchedAt: now };
      return { fonts, cached: false };
    } catch (error) {
      return {
        fonts: this.cachedInstalledFonts?.fonts ?? [],
        cached: Boolean(this.cachedInstalledFonts),
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async checkInstalledApps(): Promise<Record<string, boolean>> {
    const platform = process.platform as PlatformKey;
    const availability: Record<string, boolean> = {};

    for (const openInApp of Object.values(OPEN_IN_APPS)) {
      const platformConfig = openInApp.platforms[platform];
      if (!platformConfig && !openInApp.alwaysAvailable) {
        availability[openInApp.id] = false;
        continue;
      }
      if (openInApp.alwaysAvailable) {
        availability[openInApp.id] = true;
        continue;
      }
      try {
        let isAvailable = false;
        if (platformConfig?.bundleIds) {
          for (const bundleId of platformConfig.bundleIds) {
            if (await checkMacApp(bundleId)) {
              isAvailable = true;
              break;
            }
          }
        }
        if (!isAvailable && platformConfig?.appNames) {
          for (const appName of platformConfig.appNames) {
            if (await checkMacAppByName(appName)) {
              isAvailable = true;
              break;
            }
          }
        }
        if (!isAvailable && platformConfig?.checkCommands) {
          for (const cmd of platformConfig.checkCommands) {
            if (await checkCommand(cmd)) {
              isAvailable = true;
              break;
            }
          }
        }
        if (!isAvailable && platformConfig?.mdfindQuery && platform === 'darwin') {
          isAvailable = await checkMacMdfindQuery(platformConfig.mdfindQuery);
        }
        if (!isAvailable && platformConfig?.winVswhere && platform === 'win32') {
          isAvailable = await checkWindowsVisualStudio();
        }
        availability[openInApp.id] = isAvailable;
      } catch (error) {
        log.error(`Error checking installed app ${openInApp.id}:`, error);
        availability[openInApp.id] = false;
      }
    }

    return availability;
  }

  async openExternal(url: string): Promise<void> {
    if (!url || typeof url !== 'string') throw new Error('Invalid URL');
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      throw new Error('Invalid URL format');
    }
    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(
        `Protocol "${parsedUrl.protocol}" is not allowed. Only http and https URLs are permitted.`
      );
    }
    await shell.openExternal(url);
  }

  /**
   * 直接打开 macOS「隐私与安全性 → 文件与文件夹」面板。
   *
   * 不走 openExternal:那里只放行 http/https —— 这是对渲染层传来的任意 URL 的正确约束,
   * 别为了这一个入口把它撬开。这里的 URL 是主进程里的常量,不含任何外部输入。
   */
  async openFileAccessSettings(): Promise<void> {
    // 地址取自全仓唯一那份表(apps/desktop/shared/system-settings-urls) —— 桌面壳的「权限」
    // 相关跳转与这里是同一个动作,❌ 不各写一份 URL(product spec)。
    const url = systemSettingsUrl('fileAccess', process.platform === 'darwin' ? 'mac' : 'linux');
    if (!url) {
      throw new Error('File access settings are only available on macOS');
    }
    await shell.openExternal(url);
  }

  async openPath(rawPath: string, workspaceRoot?: string): Promise<void> {
    const realPath = await resolveOpenablePath(rawPath, workspaceRoot);
    const errorMessage = await shell.openPath(realPath);
    if (errorMessage) throw new Error(errorMessage);
  }

  async showItemInFolder(rawPath: string): Promise<void> {
    const realPath = await resolveHomeJailedPath(rawPath);
    shell.showItemInFolder(realPath);
  }

  /**
   * Restricted to the user home directory: terminal output drives these reads,
   * and AI-injected paths must not be a vector for reading e.g. `/etc/passwd`.
   * Symlinks are resolved before the home-jail check so they can't escape.
   */
  async readUserFile(rawPath: string, maxBytes = 1_048_576): Promise<{ content: string }> {
    const realPath = await resolveHomeJailedPath(rawPath);
    const stats = await stat(realPath);
    if (stats.size > maxBytes) {
      throw new Error(`File too large (${stats.size} bytes, max ${maxBytes})`);
    }
    const buffer = await readFile(realPath);
    return { content: buffer.toString('utf8') };
  }

  /**
   * 读一张**图**给渲染层显示(#5269)。与 `readUserFile` 同一道 home jail、同一套符号链接
   * 先解析后判断 —— 这里只是把「读到的字节按 utf8 拼成字符串」换成「按 data URL 拼」:
   * 图片是二进制,utf8 那条路会把它读成一堆替换字符。
   *
   * ⚠️ 只认图片扩展名。它的调用方是消息里的缩略图,给它一个 .env 的路径没有任何意义,
   * 而「能把任意文件读成 base64 递进渲染层」正是这道闸要防的那件事。
   */
  async readUserImageDataUrl(rawPath: string, maxBytes = 8 * 1024 * 1024): Promise<{ dataUrl: string }> {
    const mimeType = IMAGE_MIME_BY_EXTENSION[extname(rawPath).toLowerCase()];
    if (!mimeType) throw new Error(`Not an image path: ${rawPath}`);
    const realPath = await resolveHomeJailedPath(rawPath);
    const stats = await stat(realPath);
    if (stats.size > maxBytes) {
      throw new Error(`Image too large (${stats.size} bytes, max ${maxBytes})`);
    }
    const buffer = await readFile(realPath);
    return { dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}` };
  }

  // @@@electron44-clipboard (#4394) — electron 44 起 clipboard.writeText 返回 Promise。
  // 这个 async 不是装饰:不 await 的话写入失败会变成 unhandled rejection,而调用方(controller)
  // 的 try/catch 抓不到、照样上报 success —— 就是 #1123「复制静默失败」的同一种错法。
  async clipboardWriteText(text: string): Promise<void> {
    if (typeof text !== 'string') throw new Error('Invalid clipboard text');
    await clipboard.writeText(text);
  }

  showTerminalContextMenu(args: {
    requestId: string;
    selectionText?: string | null;
    linkText?: string | null;
    x: number;
    y: number;
  }): void {
    if (!args.requestId || typeof args.requestId !== 'string') {
      throw new Error('Invalid context menu request');
    }
    const selectionText = args.selectionText ?? '';
    const linkText = args.linkText?.trim() ?? '';
    const hasLink = linkText.length > 0;
    const emitAction = (action: TerminalContextMenuAction) => {
      events.emit(terminalContextMenuActionChannel, { requestId: args.requestId, action });
    };
    showContentContextMenu(textContextMenuItems({
      selectionText,
      actions: {
        copy: () => copyTextFireAndForget(selectionText),
        ...(hasLink ? { copyLink: () => copyTextFireAndForget(linkText) } : {}),
        paste: () => emitAction('paste'),
        selectAll: () => emitAction('select-all'),
        clear: () => emitAction('clear'),
      },
    }), {
      window: getMainWindow() ?? undefined,
      x: Math.round(args.x),
      y: Math.round(args.y),
    });
  }

  quit(): void {
    app.quit();
  }

  minimizeWindow(): void {
    getMainWindow()?.minimize();
  }

  toggleMaximizeWindow(): void {
    const win = getMainWindow();
    if (!win) return;
    if (win.isMaximized()) {
      win.unmaximize();
    } else {
      win.maximize();
    }
  }

  closeWindow(): void {
    getMainWindow()?.close();
  }

  isWindowMaximized(): boolean {
    return getMainWindow()?.isMaximized() ?? false;
  }

  async openIn(args: { app: OpenInAppId; path: string }): Promise<void> {
    const { path: target, app: appId } = args;

    if (!target || typeof target !== 'string' || !appId) {
      throw new Error('Invalid arguments');
    }

    const platform = process.platform as PlatformKey;
    const appConfig = getAppById(appId);
    if (!appConfig) throw new Error('Invalid app ID');

    const platformConfig = appConfig.platforms?.[platform];
    const label = getResolvedLabel(appConfig, platform);

    if (!platformConfig && !appConfig.alwaysAvailable) {
      throw new Error(`${label} is not available on this platform.`);
    }

    await this.openInLocal({ appId, label, target, platformConfig });
  }

  private async launchRemoteTerminal(
    label: string,
    attempts: RemoteTerminalLaunchAttempt[]
  ): Promise<void> {
    let lastError: unknown = null;
    for (const attempt of attempts) {
      try {
        await execFileCommand(attempt.file, attempt.args);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError instanceof Error) throw lastError;
    throw new Error(`Unable to launch ${label}`);
  }

  private async openInLocal(args: {
    appId: OpenInAppId;
    label: string;
    target: string;
    platformConfig: PlatformConfig | undefined;
  }): Promise<void> {
    const { appId, label, target, platformConfig } = args;

    if (appId === 'finder') {
      // ⚠️ `shell.openPath(文件)` 是「用系统默认程序打开这个文件」,不是「在文件管理器里显示」。
      // 目录传进去恰好会打开文件管理器,所以这条以前只喂目录时看着是对的;文件面板开始把**文件**
      // 路径传进来之后就暴露了:owner 点「Finder」,macOS 按 .json 的默认程序开了 Cursor。
      // 目录 → 打开它本身;文件 → 在所在目录里选中它(showItemInFolder,三端都有)。
      // ❌ 别退回「一律 openPath」:那等于把这一项变成「用默认程序打开」,而它的标签写的是 Finder。
      const isDirectory = await stat(target)
        .then((info) => info.isDirectory())
        .catch(() => false);
      if (isDirectory) {
        const errorMessage = await shell.openPath(target);
        if (errorMessage) throw new Error(errorMessage);
        return;
      }
      shell.showItemInFolder(target);
      return;
    }

    if (platformConfig?.winVswhere && process.platform === 'win32') {
      const productPath = await resolveWindowsVsProductPath();
      if (productPath) {
        await spawnDetachedCommand(productPath, [target]);
        return;
      }
      // Fall through to the `devenv {{path}}` openCommands fallback (devenv on PATH).
    }

    if (platformConfig?.openUrls) {
      for (const urlTemplate of platformConfig.openUrls) {
        const url = urlTemplate
          .replace('{{path_url}}', encodeURIComponent(target))
          .replace('{{path}}', target);
        try {
          await shell.openExternal(url);
          return;
        } catch {
          // try next URL
        }
      }
      throw new Error(
        `${label} is not installed or its URI scheme is not registered on this platform.`
      );
    }

    const quoted = (p: string) =>
      process.platform !== 'win32' ? `'${p.replace(/'/g, "'\\''")}'` : `"${p.replace(/"/g, '""')}"`;
    const commands: string[] = platformConfig?.openCommands ?? [];
    const command = commands
      .map((cmd) => cmd.replace('{{path}}', quoted(target)).replace('{{path_raw}}', target))
      .join(' || ');

    if (!command) throw new Error('Unsupported platform or app');

    await new Promise<void>((resolve, reject) => {
      exec(command, { cwd: target, env: buildExternalToolEnv() }, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async openSelectDirectoryDialog(args: {
    title: string;
    message: string;
    defaultPath?: string;
  }): Promise<string | undefined> {
    // TEST-ONLY, env-gated (GUGU_SESSION_TEST_HOOKS=1): the folder a test names.
    if (process.env.GUGU_SESSION_TEST_HOOKS === '1' && process.env.GUGU_SELECT_DIRECTORY_PATH) {
      return process.env.GUGU_SELECT_DIRECTORY_PATH;
    }
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      title: args.title,
      properties: ['openDirectory'],
      message: args.message,
      defaultPath: args.defaultPath,
    });
    if (result.canceled) return undefined;
    return result.filePaths[0];
  }

  async openSelectAudioFileDialog(args: {
    title: string;
    message: string;
  }): Promise<string | undefined> {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      title: args.title,
      properties: ['openFile'],
      message: args.message,
      filters: [
        {
          name: 'Audio',
          extensions: ['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'webm'],
        },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return undefined;
    return result.filePaths[0];
  }

  async saveTextFile(args: {
    title: string;
    defaultPath: string;
    content: string | AsyncIterable<string>;
  }): Promise<string | undefined> {
    const result = await dialog.showSaveDialog(getMainWindow()!, {
      title: args.title,
      defaultPath: args.defaultPath,
      filters: [
        { name: 'JSON', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return undefined;
    await writeFile(result.filePath, args.content, 'utf8');
    return result.filePath;
  }

  /** 下载别的机器上的文件 / 文件夹时的两个对话框(见 remote-downloads.ts)。 */
  async showDownloadSaveDialog(defaultPath: string): Promise<string | undefined> {
    const result = await dialog.showSaveDialog(getMainWindow()!, { defaultPath });
    return result.canceled || !result.filePath ? undefined : result.filePath;
  }

  async showDownloadDirectoryDialog(defaultPath: string): Promise<string | undefined> {
    const result = await dialog.showOpenDialog(getMainWindow()!, {
      defaultPath,
      properties: ['openDirectory', 'createDirectory'],
    });
    return result.canceled ? undefined : result.filePaths[0];
  }

  downloadsDir(): string {
    return app.getPath('downloads');
  }

  async readAudioFileDataUrl(filePath: string): Promise<string> {
    if (!filePath || typeof filePath !== 'string') throw new Error('Invalid audio path');

    const resolvedPath = await realpath(resolve(filePath));
    const resolvedHome = resolve(homedir());
    const homePrefix = resolvedHome.endsWith(sep) ? resolvedHome : `${resolvedHome}${sep}`;
    if (!resolvedPath.startsWith(homePrefix) && resolvedPath !== resolvedHome) {
      throw new Error('Audio file must be located within the user home directory');
    }

    const extension = extname(filePath).toLowerCase();
    const mimeType = AUDIO_MIME_TYPES[extension];
    if (!mimeType) throw new Error('Unsupported audio file type');

    const fileStat = await stat(resolvedPath);
    if (!fileStat.isFile()) throw new Error('Audio path is not a file');
    if (fileStat.size > MAX_AUDIO_FILE_BYTES) throw new Error('Audio file is larger than 20 MB');

    const file = await readFile(resolvedPath);
    return `data:${mimeType};base64,${file.toString('base64')}`;
  }
}

export const appService = new AppService();
