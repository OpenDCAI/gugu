import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { redactAll } from '@gugu/session-shared/logger';
import { createFileTransport, trimToLineBoundary } from '@gugu/session-shared/logger/transport';
import { app } from 'electron';
import type pinoLib from 'pino';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const DIAGNOSTIC_LOG_BYTES = 500 * 1024;
const RETAINED_LOG_FILES = 5;
// 会话页那半边的日志。宿主那半边是 `gugu-main.log`,两份并排放在同一个 logs 目录里,
// 用户翻日志时看得见文件名 —— 所以它也得姓 gugu。
const LOG_FILE_NAME = 'gugu-task.log';
// 改名前的文件名,见 adoptLegacyLogFiles。
const LEGACY_LOG_FILE_NAME = 'emdash.log';
const DIAGNOSTIC_ATTACHMENT_FILENAME = 'gugu-task-diagnostics.log';

let logFilePath: string | undefined;
/** 根日志目录;#4277 按账号分文件时用户目录挂在它下面(GUGU_SESSION_LOG_FILE 显式覆盖时不分)。 */
let logBaseDir: string | undefined;

export function initializeFileLogger() {
  // 旧名 EMDASH_LOG_FILE 照认。
  const override = process.env.GUGU_SESSION_LOG_FILE?.trim() || process.env.EMDASH_LOG_FILE?.trim();
  if (override) {
    logFilePath = resolve(override);
    return;
  }

  const electronApp = app as Electron.App | undefined;
  if (!electronApp?.setAppLogsPath) return;

  electronApp.setAppLogsPath(join(electronApp.getPath('userData'), 'logs'));
  logBaseDir = electronApp.getPath('logs');
  adoptLegacyLogFiles(logBaseDir);
  logFilePath = join(logBaseDir, LOG_FILE_NAME);
}

/**
 * #4277 日志按账号分文件:登录确立后写 `<logs>/users/<ownerUserId>/gugu-task.log`,退出(null)回根文件。
 * 传输层只在第一次写时建目录,所以这里自己先建;建不出来就继续写原文件 —— 返回值仍是原路径,
 * 调用方(宿主)据此响亮报警。这个模块本身就是日志落点,❌ 在这里往控制台打。
 */
export function setLogFileOwner(ownerUserId: string | null): string | undefined {
  if (!logBaseDir) return logFilePath;
  const dir = ownerUserId ? join(logBaseDir, 'users', ownerUserId) : logBaseDir;
  const next = join(dir, LOG_FILE_NAME);
  if (next === logFilePath) return logFilePath;
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    return logFilePath;
  }
  adoptLegacyLogFiles(dir);
  logFilePath = next;
  return logFilePath;
}

/**
 * 改名前会话页日志叫 `emdash.log`(轮转副本 `emdash.log.1`…)。升级后第一次往某个目录落日志之前,
 * 把那一套原地改成新名字 —— 否则 logs 目录里新旧两套名字并排躺着,旧的那套再也不会更新。
 * 新名字的日志已经在就整套不动:❌ 拿旧日志盖掉新日志。改不了名(权限等)也照常往新文件写。
 */
export function adoptLegacyLogFiles(dir: string): void {
  if (!existsSync(join(dir, LEGACY_LOG_FILE_NAME)) || existsSync(join(dir, LOG_FILE_NAME))) return;
  const suffixes = ['', ...Array.from({ length: RETAINED_LOG_FILES }, (_, i) => `.${i + 1}`)];
  for (const suffix of suffixes) {
    const from = join(dir, LEGACY_LOG_FILE_NAME + suffix);
    const to = join(dir, LOG_FILE_NAME + suffix);
    if (!existsSync(from) || existsSync(to)) continue;
    try {
      renameSync(from, to);
    } catch {
      // 这个模块本身就是日志落点,❌ 在这里往控制台打;改不了名就让旧文件留着。
    }
  }
}

function resolveLogPath(): string | undefined {
  if (!logFilePath) initializeFileLogger();
  return logFilePath;
}

/**
 * Singleton file transport behind the pino destination: exactly one serialized write queue. (The session page's
 * renderer logs go to `gugu-main.log` through the host's `log:write`, not here.)
 */
const sharedTransport = createFileTransport({
  path: resolveLogPath,
  maxBytes: MAX_LOG_BYTES,
  retainedFiles: RETAINED_LOG_FILES,
  redact: redactAll,
});

/**
 * Returns a pino-compatible DestinationStream backed by the shared transport.
 * Called once at main-process logger construction.
 */
export function getLogFileDestination(): pinoLib.DestinationStream {
  return sharedTransport.asDestination();
}

export function flushLogWrites(): Promise<void> {
  return sharedTransport.flush();
}

export async function getDiagnosticLogAttachment() {
  const path = resolveLogPath();

  const fallback = {
    filename: DIAGNOSTIC_ATTACHMENT_FILENAME,
    mimeType: 'text/plain' as const,
    content: 'No application logs were available.',
  };

  if (!path) return fallback;

  const raw = await readFile(path, 'utf8').catch(() => '');
  const tail = trimToLineBoundary(raw, DIAGNOSTIC_LOG_BYTES);
  const redacted = redactAll(tail);

  return {
    filename: DIAGNOSTIC_ATTACHMENT_FILENAME,
    mimeType: 'text/plain' as const,
    content: redacted || fallback.content,
  };
}

/** Exported for diagnostic attachment (used in the diagnostics controller). */
export function redactDiagnosticLog(value: string): string {
  return redactAll(value);
}
