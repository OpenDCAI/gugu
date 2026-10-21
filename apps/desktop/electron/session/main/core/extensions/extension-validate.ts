import * as fs from 'node:fs';
import * as path from 'node:path';
import { bundleProblems, type BundleEntry } from '@shared/extensions/bundle-checks';
import { ExtensionManifestError } from '@shared/extensions/manifest';
import { BUNDLE_SKIP_NAMES } from '@shared/extensions/market';
import type { ExtensionsService, InspectedExtension } from './extensions-service';

/**
 * 不安装,只判一个扩展包目录(#6612):包过不过得了安装与市场的那几道确定性检查。打包、解包都先跑它。
 *
 * 只读、不抛:每个问题都进 `problems`,拒不拒由调用方定。❌ 在这里另写一套判据:schema 与入口文件归
 * `inspectDirectory`,条目数 / 体积 / 路径归市场那几个常量。
 */

export interface ExtensionBundleReport {
  ok: boolean;
  problems: string[];
  inspected: InspectedExtension | null;
}

export function validateExtensionBundle(
  service: Pick<ExtensionsService, 'inspectDirectory'>,
  sourceDir: string
): ExtensionBundleReport {
  const root = path.resolve(sourceDir);
  let inspected: InspectedExtension | null = null;
  const problems: string[] = [];
  try {
    inspected = service.inspectDirectory(root);
  } catch (error) {
    problems.push(...(error instanceof ExtensionManifestError ? error.issues : [String(error instanceof Error ? error.message : error)]));
  }
  if (fs.existsSync(root) && fs.statSync(root).isDirectory()) problems.push(...packageProblems(root));
  return { ok: inspected !== null && problems.length === 0, problems, inspected };
}

/**
 * 市场打包那一关按目录判:符号链接不进包(跟随它等于把链接指向的东西打进扩展),路径要过解包那道
 * `bundleEntryRejection`,文件数与总字节不超过解包上限。跳过的名字与打包同一份。判据是共享的
 * `bundleProblems`(手机装包走同一份,L9),这里只按目录走一遍。
 */
function packageProblems(root: string): string[] {
  const entries: BundleEntry[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (BUNDLE_SKIP_NAMES.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isSymbolicLink()) entries.push({ path: relative, kind: 'link', bytes: 0 });
      else if (entry.isDirectory()) {
        entries.push({ path: relative, kind: 'directory', bytes: 0 });
        walk(full);
      } else if (entry.isFile()) entries.push({ path: relative, kind: 'file', bytes: fs.statSync(full).size });
    }
  };
  walk(root);
  return bundleProblems(entries);
}
