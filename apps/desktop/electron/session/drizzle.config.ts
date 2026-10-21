import { resolve } from 'node:path';
import { defineConfig } from 'drizzle-kit';
import { defaultDbFilePath, resolveDefaultUserDataPath } from './main/db/default-path';

function resolveDbUrl(): string {
  const explicit = process.env.GUGU_SESSION_DB_FILE?.trim();
  if (explicit) {
    return resolve(explicit);
  }
  return defaultDbFilePath(resolveDefaultUserDataPath());
}

export default defineConfig({
  // 融合(#2804)把这棵树的 `src/` 一层拿掉了,这里的路径没跟着改,于是
  // `drizzle-kit generate` 整棵树都跑不起来("No schema files found")。
  // 后果不是少个文件:生成不了 → 迁移只能手写 → 手写的迁移没有 meta 快照 →
  // 下一次真跑 generate 时它按上一份快照做 diff,会把已有的列再发一遍。
  schema: './main/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: resolveDbUrl(),
  },
  strict: true,
  verbose: true,
});
