import * as fs from 'node:fs';
import * as path from 'node:path';
import { firstRunRecordSchema, type FirstRunRecord } from '@shared/extensions/first-run';
import { log } from '@main/lib/logger';
import { EXTENSIONS_DIR_NAME } from './extensions-root';

/**
 * 首启默认组在这台电脑上的那份记录(@shared/extensions/first-run.ts 说了每种状态是什么):userData 里的一个小文件。
 * 装是 first-run-apps.ts 的事,这里只管「是不是新 profile」和读写。
 */
export const FIRST_RUN_RECORD_FILE = 'first-run-apps.json';

const fileOf = (userData: string) => path.join(userData, FIRST_RUN_RECORD_FILE);

/**
 * 启动最先调一次(embedded-boot.ts,早于任何东西建出 `task-extensions/`):还没有记录时,有 App 的记录目录 = 这个 profile
 * 早就用着(老 profile 升级上来,`existing`,永远不跑);没有 = 新 profile 的第一次启动(`pending`)。有记录就不动它。
 */
export function noteFirstRunProfile(userData: string): FirstRunRecord {
  const file = fileOf(userData);
  if (fs.existsSync(file)) return readFirstRunRecord(userData);
  const record: FirstRunRecord = fs.existsSync(path.join(userData, EXTENSIONS_DIR_NAME)) ? { state: 'existing' } : { state: 'pending' };
  writeFirstRunRecord(userData, record);
  log.info('first-run: this profile', { state: record.state });
  return record;
}

/** The record as kept. None (a profile this start did not note) reads as `existing`: nothing put in that it did not see. */
export function readFirstRunRecord(userData: string): FirstRunRecord {
  const file = fileOf(userData);
  if (!fs.existsSync(file)) return { state: 'existing' };
  const parsed = firstRunRecordSchema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')) as unknown);
  // Written by this file only: a wrong shape is a bug or a hand edit, said as it is — ❌ read as a new profile.
  if (!parsed.success) throw new Error(`${FIRST_RUN_RECORD_FILE} is malformed: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
  return parsed.data;
}

export function writeFirstRunRecord(userData: string, record: unknown): void {
  const checked = firstRunRecordSchema.parse(record);
  fs.mkdirSync(userData, { recursive: true });
  // Whole or not at all: a half-written record must not read as some other answer next start.
  const temp = `${fileOf(userData)}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(checked));
  fs.renameSync(temp, fileOf(userData));
}
