import { describe, expect, it } from 'vitest';
import { EXTENSION_API_VERSION, EXTENSION_API_VERSION_MIN_SUPPORTED, safeParseExtensionManifest } from './manifest';

/**
 * apiVersion 3 (10-06, 125): where a page is only fills its context, every call names its target, the capability words
 * widened are renamed — not what an App written for 2 calls (Beta already ran 2, and agents wrote Apps on it). An App on
 * 1 or 2 is refused wherever its manifest is read — the installed list, an install from a chat, `app_install` /
 * `app_check`, the phone — in one sentence that says what to do: an agent rewrites it as app_create writes Apps. No
 * table of what changed since 1 or 2 (owner 10-06: Apps are young, no legacy care).
 */

const app = (apiVersion: number) => ({
  id: 'notes',
  name: 'Notes',
  version: '1.0.0',
  apiVersion,
  entry: 'main.html',
  contributes: { tabs: [{ name: 'main', title: 'Notes' }] },
});

function issues(raw: unknown): string {
  const result = safeParseExtensionManifest(raw);
  return result.ok ? '' : result.issues.join(' ');
}

describe('an App written for apiVersion 1 or 2', () => {
  it.each([1, 2])('%i: refused in one sentence that says what to do — and nothing about what changed', (version) => {
    expect(issues(app(version))).toBe(
      `apiVersion: apiVersion ${version} is an older App interface; ask an agent to rewrite the App for apiVersion 11 as app_create writes Apps.`,
    );
  });

  it('control: the same App on the current version parses', () => {
    expect(EXTENSION_API_VERSION).toBe(11);
    expect(issues(app(EXTENSION_API_VERSION))).toBe('');
  });

  // 4 (10-15, App 引用 pill) took `about` out of compose / send: an App on 3 still installs and runs — only a call
  // passing `about` is refused, when it is made — and the market hands a client that knows only 3 an App's 3.
  it('3 to 8 still parse; the market uses 5 for host pages, 6 for chat:read, 7 for places in task links, 8 for subtitle, 9 for the forum, 10 for a compose naming no place, and refuses a future interface', () => {
    expect(EXTENSION_API_VERSION_MIN_SUPPORTED).toBe(3);
    expect(issues(app(3))).toBe('');
    expect(issues(app(4))).toBe('');
    expect(issues(app(5))).toBe('');
    expect(issues(app(6))).toBe('');
    expect(issues(app(7))).toBe('');
    expect(issues(app(8))).toBe('');
    expect(issues(app(9))).toBe('');
    expect(issues(app(10))).toBe('');
    expect(issues(app(11))).toBe('');
    expect(issues(app(12))).toBe('apiVersion: apiVersion 12 needs a newer gugu (this build supports up to 11)');
  });
});

describe('opensFiles names a chat\'s files `chat` (主人 10-05: a private chat has a workspace too)', () => {
  const claiming = (opensFiles: unknown) => ({ ...app(EXTENSION_API_VERSION), contributes: { tabs: [{ name: 'main', title: 'Notes', opensFiles }] } });
  // 125 10-06: no table from an old key to a new one — `group` is an unknown key like any other.
  it('`chat` is read; `group` is refused like any unknown key, naming the keys there are', () => {
    expect(issues(claiming({ chat: ['.notes.json'] }))).toBe('');
    const said = issues(claiming({ group: ['.notes.json'] }));
    expect(said).not.toContain('is now');
    expect(said).toContain('{"session":[…]} or {"chat":[…]}');
  });
});
