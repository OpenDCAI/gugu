import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * skill 注入核查 10-14 坏签探针: a skill whose SKILL.md frontmatter is not YAML reached no session, and app_check said
 * `ok: true` — the agent then took the nearest other skill. A skill no session gets is the App failing, said by the check.
 * The page and its readers are mocked as in extension-check-tools-77.test.ts; the skills are real files.
 */

const bundle = vi.hoisted(() => ({ rootDir: '', skills: 'skills' }));

vi.mock('electron', () => ({
  BrowserWindow: class {
    private destroyed = false;
    readonly webContents = {
      id: 7,
      setWindowOpenHandler: () => undefined,
      on: () => undefined,
      once: () => undefined,
      isDestroyed: () => this.destroyed,
      executeJavaScript: async () => 'Stamps',
    };
    loadURL = async () => undefined;
    isDestroyed = () => this.destroyed;
    destroy = () => {
      this.destroyed = true;
    };
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { warn: () => undefined } }));
vi.mock('./bridge-preload-path', () => ({ resolveExtensionBridgePreload: () => '/preload.js' }));
vi.mock('./extension-check-source', () => ({ sourceLine: () => null, staticHints: () => [] }));
vi.mock('./extension-bridge', () => ({
  bindExtensionSurface: () => undefined,
  recentExtensionErrors: () => [],
  checkReadingsOf: () => ({
    writes: 0, writesPerSecond: 0, presenceSets: 0, presencePerSecond: 0, opens: 0, opensSettled: 0, shown: [],
  }),
  reportBlockedNavigation: () => undefined,
  showAgentPageInTheme: () => undefined,
  shownTabWidth: () => null,
  watchExtensionSurfaceErrors: () => () => undefined,
}));
vi.mock('./extension-programs', () => ({
  extensionPrograms: { installed: () => [], tools: async () => [] },
  programFailureReason: () => '',
  agentToolsOf: () => ({ tools: [], clashes: [] }),
}));
vi.mock('./extension-session', () => ({ configureExtensionSession: () => undefined }));
vi.mock('./extension-look-picture', () => ({
  keepPainting: async () => undefined,
  picturesOf: async () => [],
  endPictures: () => undefined,
  GROUP_PANEL: { width: 520, touch: false, says: '520 wide' },
  PHONE: { width: 412, touch: true, says: '412 wide' },
  PICTURE_MAX_HEIGHT: 900,
  taskPane: () => ({ width: 952, touch: false, says: '952 wide' }),
  pictureOf: async () => null,
  showAtSize: async () => undefined,
}));
vi.mock('./extension-check-steps', () => ({
  ariaSnapshot: () => '- text: "page"',
  byDeadline: <T>(work: Promise<T>) => work,
  readTree: async () => ({ nodes: [] }),
  runSteps: async () => ({ results: [], pictures: [] }),
}));
vi.mock('./extension-webview-security', () => ({ isAllowedExtensionNavigation: () => true }));
vi.mock('./extensions-root', () => ({
  extensionsService: () => ({
    get: () => ({
      rootDir: bundle.rootDir,
      manifest: { id: 'skillx-bad', entry: 'main.html', contributes: { tabs: [{ name: 'main', entry: 'main.html' }], skills: bundle.skills } },
    }),
    grantedHosts: () => [],
  }),
}));

const { checkExtensionSurface } = await import('./extension-check');
const { checkResult } = await import('./extension-agent-actions');

const BAD = '---\nname: bad-stamp\ndescription: Use when someone asks for a red stamp (红签): run its script.\n---\n';
const OK = '---\nname: ok-stamp\ndescription: "Use when someone asks for a green stamp (绿签): run its script."\n---\n';

function skills(files: Record<string, string>): void {
  for (const [folder, text] of Object.entries(files)) {
    mkdirSync(path.join(bundle.rootDir, 'skills', folder), { recursive: true });
    writeFileSync(path.join(bundle.rootDir, 'skills', folder, 'SKILL.md'), text);
  }
}

async function check(): Promise<ReturnType<typeof checkResult>> {
  const running = checkExtensionSurface({ extensionId: 'skillx-bad', tabName: 'main', timeoutMs: 15_000, operator: { kind: 'agent' as const, id: 'user:agent-f' } });
  await vi.advanceTimersByTimeAsync(20_000);
  return checkResult(await running);
}

beforeEach(() => {
  bundle.rootDir = mkdtempSync(path.join(tmpdir(), 'gugu-check-skills-'));
  bundle.skills = 'skills';
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-14T08:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(bundle.rootDir, { recursive: true, force: true });
});

describe('app_check says a skill no session gets (坏签探针)', () => {
  it('fails the check, naming the skill, its SKILL.md and why; the good one is not named', async () => {
    skills({ 'bad-stamp': BAD, 'ok-stamp': OK });
    const result = await check();
    expect(result.ok).toBe(false);
    // Read from the bundle, like a static hint — not something this check's page did (评审 824a8a6abc ④).
    expect(result.errors).toEqual([expect.objectContaining({ kind: 'skill', level: 'error', page: 'the bundle' })]);
    const [error] = result.errors;
    expect(error!.message).toContain(
      `extension skillx-bad: skill bad-stamp left out of the session (${path.join(bundle.rootDir, 'skills', 'bad-stamp', 'SKILL.md')}): Nested mappings are not allowed`,
    );
    expect(error!.message).not.toContain('ok-stamp');
    expect(result.next).toMatch(/^It does not work yet: .*fix what load_error, errors and console say/);
  });

  // 评审 824a8a6abc ①: skills naming a file threw ENOTDIR here, and the whole check came back as an exception.
  it('skills naming a file: the check answers, failing, with the App and the path', async () => {
    writeFileSync(path.join(bundle.rootDir, 'SKILL.md'), OK);
    bundle.skills = 'SKILL.md';
    const result = await check();
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([expect.objectContaining({ kind: 'skill', level: 'error' })]);
    expect(result.errors[0]!.message).toContain(`extension skillx-bad: skills folder cannot be read (${path.join(bundle.rootDir, 'SKILL.md')}): ENOTDIR`);
  });

  it('control: every skill read — the check is ok and says nothing of skills', async () => {
    skills({ 'ok-stamp': OK });
    const result = await check();
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
