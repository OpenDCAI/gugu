import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const guide = 'Use the existing decision and outlets documented in notificationModels.shouldNotify; do not add an independent alert path.';
const outlets: Record<string, string> = {
  'apps/desktop/electron/session/main/core/agent-hooks/notification.ts': 'Agent waits, decided by shouldNotify; banner owns sound.',
  'apps/desktop/electron/session/main/core/extensions/extension-notifications.ts': 'Explicit App/device banners obey grants, preferences and the shared limiter.',
  'apps/desktop/electron/main.ts': 'Platform banner/badge implementation; documented auth-expiry and first close-to-tray hints.',
  'apps/desktop/src/store/chatListProjection.ts': 'Chat banners decided by shouldNotify.',
  'apps/desktop/src/store/chat.tsx': 'Badge counts chatAttention().askingYou.',
  'apps/desktop/src/mobile/agent-watch/useAgentWatchAlerts.ts': 'Phone agent waits, decided by the sibling agent-watch-alerts model.',
  'apps/desktop/src/components/assistant/MeetingReminder.tsx': 'Exception: time-bound calendar reminder.',
  'apps/desktop/src/lib/notificationDiagnostics.ts': 'Exception: person pressed the test-notification button.',
  'apps/desktop/src/lib/notificationSettings.ts': 'Documents the existing chat-banner sound setting; no output of its own.',
  'apps/desktop/src/platform/electron.ts': 'Platform bridge implementation.',
  'apps/desktop/src/platform/capacitor.ts': 'Platform implementation, including quiet notification channel.',
  'apps/desktop/src/mobile/assistant/phoneVoiceRecorder.ts': 'Audio input capture, not a notification sound.',
  'apps/desktop/src/session/renderer/features/assistant/voice-notes/voice-recorder.ts': 'Audio input capture, not a notification sound.',
};
const outlet = /\bnew (electron\.)?Notification\(|\.showNotification\(|LocalNotifications\.schedule\(|\bsetBadgeCount\(|\.setBadge\(|setOverlayIcon\(|flashFrame\(|requestUserAttention\(|dock\.bounce\(|\bnew Audio\(|new AudioContext\(/;

function sources(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (['node_modules', 'tests', 'test', '__tests__'].includes(entry.name)) return [];
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.[cm]?[jt]sx?$/.test(entry.name) && !/\.d\.ts$|\.(test|spec)\./.test(entry.name) ? [path] : [];
  });
}

describe('notification outlets', () => {
  it('has exactly the reviewed outlets, with no new or stale allowlist entry', () => {
    const roots = ['apps/desktop/src', 'apps/desktop/electron', ...readdirSync(join(root, 'packages')).map((name) => `packages/${name}/src`)];
    const actual = roots.flatMap((directory) => sources(join(root, directory)))
      .filter((file) => readFileSync(file, 'utf8').split('\n').some((line) => outlet.test(line)))
      .map((file) => relative(root, file).replaceAll('\\', '/')).sort();
    expect(actual, guide).toEqual(Object.keys(outlets).sort());
    for (const reason of Object.values(outlets)) expect(reason.trim()).not.toBe('');
  });

  it('keeps every automatic decision site on the shared notification model', () => {
    for (const path of [
      'apps/desktop/electron/session/main/core/agent-hooks/notification.ts',
      'apps/desktop/src/store/chatListProjection.ts',
      'apps/desktop/src/mobile/agent-watch/agent-watch-alerts.ts',
      'apps/desktop/src/store/chat.tsx',
    ]) {
      expect(readFileSync(join(root, path), 'utf8'), `${path}: ${guide}`)
        .toMatch(/import\s*{[^}]*\bshouldNotify\b[^}]*}\s*from\s*['"][^'"]*notificationModels['"]|import\s*{[^}]*\bchatAttention\b[^}]*}\s*from\s*['"][^'"]*chatModels['"]/s);
    }
  });
});
