import fs from 'node:fs';
import path from 'node:path';

/** Locates the browser used to run any App's background HTML, without browser-control tools or a visible page. */
export const CHROME_CANDIDATES = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome'];

export type ChromeFs = Pick<typeof fs, 'statSync'>;

function isExecutable(file: string, fsImpl: ChromeFs): boolean {
  try {
    return fsImpl.statSync(file).isFile();
  } catch {
    return false;
  }
}

/** 机器上的 Chrome:`GUGU_APP_BROWSER_CHROME` 指定的(给错了就是错,❌ 再去 PATH 里找),否则按 PATH 找。 */
export function findAppBrowser(env: NodeJS.ProcessEnv, fsImpl: ChromeFs = fs): string | null {
  const pinned = env.GUGU_APP_BROWSER_CHROME?.trim();
  if (pinned) return isExecutable(pinned, fsImpl) ? pinned : null;
  return onPath(CHROME_CANDIDATES, env, fsImpl);
}

function onPath(names: readonly string[], env: NodeJS.ProcessEnv, fsImpl: ChromeFs): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (isExecutable(file, fsImpl)) return file;
    }
  }
  return null;
}

