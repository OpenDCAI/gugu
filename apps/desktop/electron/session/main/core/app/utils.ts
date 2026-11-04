import { exec, execFile, spawn } from '@gugu/core/local/childProcess';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { onErrorEvent } from '@gugu/session-shared';
import { buildExternalToolEnv } from '@main/utils/childProcessEnv';
import { log } from '@main/lib/logger';

const UNKNOWN_VERSION = 'unknown';

export const execCommand = (
  command: string,
  opts?: { maxBuffer?: number; timeout?: number }
): Promise<string> =>
  new Promise((resolve, reject) => {
    exec(
      command,
      {
        maxBuffer: opts?.maxBuffer ?? 8 * 1024 * 1024,
        timeout: opts?.timeout ?? 30_000,
        env: buildExternalToolEnv(),
      },
      (error, stdout) => {
        if (error) return reject(error);
        resolve(stdout ?? '');
      }
    );
  });

export const execFileCommand = (
  file: string,
  args: string[],
  opts?: { timeout?: number }
): Promise<void> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        timeout: opts?.timeout ?? 30_000,
        env: buildExternalToolEnv(),
        // 只给「在终端里打开」用:起的就是要人看见的那个终端窗口。
        windowsHide: false,
      },
      (error) => {
        if (error) return reject(error);
        resolve();
      }
    );
  });

export const spawnDetachedCommand = (file: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      detached: true,
      env: buildExternalToolEnv(),
      stdio: 'ignore',
      // 「用 Visual Studio 打开」:起的是要人看见的那个程序。
      windowsHide: false,
    });

    const stopStartupError = onErrorEvent(child, (error) => reject(error));
    child.once('spawn', () => {
      // @@@unhandled-error-event (#4942) — 摘掉握手 handler 是对的(留着它会在已 settle 的 Promise 上
      // 再 reject 一次),但**摘完不能留下零监听者**:Node 对没人接的 'error' 一视同仁地抛成未捕获异常,
      // 而这里跑在 Electron 主进程,那等于整个宿主连同所有会话一起死。这条子进程 detached + stdio:'ignore'
      // + unref,残余面确实窄(主要是 kill 失败一类),但「窄」不等于零,而代价是整个宿主 —— 而且这类失败
      // 是**异步**送达的,spawnDetachedCommand 外面那圈 try/catch 一次也接不住。
      // ❌ 不是吞错:错误照旧落日志报出去;进程已 detach,调用方的契约到 resolve 为止,不再由它承担。
      stopStartupError();
      onErrorEvent(child, (error) => {
        log.warn('[spawnDetachedCommand] detached child emitted an error after spawn', {
          file,
          error: error.message,
        });
      });
      child.unref();
      resolve();
    });
  });

const execFileOutput = (
  file: string,
  args: string[],
  opts?: { maxBuffer?: number; timeout?: number; includeStderr?: boolean }
): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      {
        maxBuffer: opts?.maxBuffer ?? 8 * 1024 * 1024,
        timeout: opts?.timeout ?? 30_000,
        env: buildExternalToolEnv(),
      },
      (error, stdout, stderr) => {
        if (error) return reject(error);
        resolve(`${stdout ?? ''}${opts?.includeStderr ? (stderr ?? '') : ''}`);
      }
    );
  });

// ─── Font discovery ───────────────────────────────────────────────────────────

const dedupeAndSortFonts = (fonts: string[]): string[] => {
  const unique = Array.from(new Set(fonts.map((f) => f.trim()).filter(Boolean)));
  return unique.sort((a, b) => a.localeCompare(b));
};

const listInstalledFontsMac = async (): Promise<string[]> => {
  const script = `
ObjC.import('AppKit')
const families = $.NSFontManager.sharedFontManager.availableFontFamilies
const result = []
for (let i = 0; i < families.count; i++) {
  result.push(ObjC.unwrap(families.objectAtIndex(i)))
}
console.log(result.join('\\n'))
`;
  const output = await execFileOutput('osascript', ['-l', 'JavaScript', '-e', script], {
    includeStderr: true,
    timeout: 5_000,
  });
  return dedupeAndSortFonts(output.split('\n'));
};

const listInstalledFontsLinux = async (): Promise<string[]> => {
  const stdout = await execCommand('fc-list : family', { timeout: 30_000 });
  const fonts = stdout
    .split('\n')
    .flatMap((line) => line.split(','))
    .map((font) => font.trim())
    .filter(Boolean);
  return dedupeAndSortFonts(fonts);
};

const listInstalledFontsWindows = async (): Promise<string[]> => {
  const script =
    "$fonts = Get-ItemProperty -Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts';" +
    "$props = $fonts.PSObject.Properties | Where-Object { $_.Name -notlike 'PS*' };" +
    "$props | ForEach-Object { ($_.Name -replace '\\s*\\(.*\\)$','').Trim() }";
  // 直接起 powershell.exe,❌ 经 `exec` 的 cmd.exe 壳:超时 kill 只杀得到壳,powershell 会留成孤儿。
  const stdout = await execFileOutput('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: 30_000,
  });
  return dedupeAndSortFonts(
    stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  );
};

export const listInstalledFontsAll = async (): Promise<string[]> => {
  switch (process.platform) {
    case 'darwin':
      return listInstalledFontsMac();
    case 'linux':
      return listInstalledFontsLinux();
    case 'win32':
      return listInstalledFontsWindows();
    default:
      return [];
  }
};

// ─── App version ─────────────────────────────────────────────────────────────

const readPackageVersion = async (packageJsonPath: string): Promise<string | null> => {
  try {
    const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf-8'));
    if (packageJson.name === '@gugu/desktop' && packageJson.version) {
      return packageJson.version as string;
    }
  } catch {
    // Ignore missing or malformed package.json; try the next path.
  }
  return null;
};

export const resolveAppVersion = async (): Promise<string> => {
  try {
    const version = app.getVersion();
    if (version && version !== '0.0.0') return version;
  } catch {
    // fall through
  }

  const possiblePaths = [
    // @@@4865 本模块所在 chunk 平铺在 apps/desktop/dist-electron/(从前在其 sessionpage/ 子目录,这里曾是 '../../');
    // 上一层即 apps/desktop/package.json。前面 app.getVersion() 在打包形态下总先命中,这里只是 dev 兜底。
    join(__dirname, '../package.json'),
    join(process.cwd(), 'package.json'),
    join(app.getAppPath(), 'package.json'),
  ];

  for (const packageJsonPath of possiblePaths) {
    const version = await readPackageVersion(packageJsonPath);
    if (version) return version;
  }

  try {
    return app.getVersion();
  } catch {
    return UNKNOWN_VERSION;
  }
};

// ─── Installed-app detection ─────────────────────────────────────────────────

export const checkCommand = (cmd: string): Promise<boolean> =>
  new Promise((resolve) => {
    const check =
      process.platform !== 'win32' ? `command -v ${cmd} >/dev/null 2>&1` : `where ${cmd}`;
    exec(check, { env: buildExternalToolEnv() }, (error) => {
      resolve(!error);
    });
  });

/**
 * Resolve the full path to the latest Visual Studio's `devenv.exe` via `vswhere.exe`,
 * the canonical VS locator installed at a fixed path with any VS 2017+ install.
 * `devenv` is rarely on PATH, so this is the reliable way to both detect and launch it.
 * Returns null when Visual Studio is not installed.
 */
export const resolveWindowsVsProductPath = (): Promise<string | null> =>
  new Promise((resolve) => {
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
    execFile(
      vswhere,
      ['-latest', '-property', 'productPath'],
      { timeout: 30_000, env: buildExternalToolEnv() },
      (error, stdout) => {
        if (error) return resolve(null);
        const productPath = stdout.split(/\r?\n/)[0]?.trim();
        resolve(productPath && productPath.length > 0 ? productPath : null);
      }
    );
  });

export const checkWindowsVisualStudio = async (): Promise<boolean> =>
  (await resolveWindowsVsProductPath()) !== null;

export const checkMacApp = (bundleId: string): Promise<boolean> =>
  new Promise((resolve) => {
    exec(
      `mdfind "kMDItemCFBundleIdentifier == '${bundleId}'"`,
      { env: buildExternalToolEnv() },
      (error, stdout) => {
        resolve(!error && stdout.trim().length > 0);
      }
    );
  });

export const checkMacAppByName = (appName: string): Promise<boolean> =>
  new Promise((resolve) => {
    exec(
      `osascript -e 'id of application "${appName}"' 2>/dev/null`,
      { env: buildExternalToolEnv() },
      (error) => {
        resolve(!error);
      }
    );
  });

export const checkMacMdfindQuery = (query: string): Promise<boolean> =>
  new Promise((resolve) => {
    execFile(
      'mdfind',
      [query],
      { timeout: 30_000, env: buildExternalToolEnv() },
      (error, stdout) => {
        resolve(!error && stdout.trim().length > 0);
      }
    );
  });
