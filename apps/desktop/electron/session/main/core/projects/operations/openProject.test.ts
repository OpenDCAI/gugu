import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openProject } from './openProject';

const mocks = vi.hoisted(() => ({ get: vi.fn(), valid: vi.fn(), probe: vi.fn(), open: vi.fn(), workspace: vi.fn() }));
vi.mock('./getProjects', () => ({ getProjectById: mocks.get }));
vi.mock('../path-utils', () => ({ checkIsValidDirectory: mocks.valid }));
vi.mock('./probe-path-access', () => ({ probePathAccess: mocks.probe, PATH_ACCESS_PROBE_TIMEOUT_MS: 3000 }));
vi.mock('./ensure-repository-workspace', () => ({ ensureRepositoryWorkspace: mocks.workspace }));
vi.mock('@main/core/projects/project-manager', () => ({ projectManager: { openProject: mocks.open } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const platform = (value: string) => Object.defineProperty(process, 'platform', { configurable: true, value });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.get.mockResolvedValue({ type: 'local', id: 'project', path: '/readable', baseRef: null });
  mocks.valid.mockReturnValue(true);
  mocks.probe.mockResolvedValue({ kind: 'blocked' });
  mocks.open.mockResolvedValue({ success: true, data: { resolveGitless: async () => true } });
  mocks.workspace.mockReturnValue('workspace');
});
afterEach(() => { Object.defineProperty(process, 'platform', originalPlatform); });

describe('platform-specific project access checks', () => {
  it.each(['linux', 'win32'])('does not reject a readable %s project on the macOS prompt budget', async (value) => {
    platform(value);
    await expect(openProject('project')).resolves.toEqual({ success: true, data: { repositoryWorkspaceId: 'workspace', baseRef: null } });
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.open).toHaveBeenCalledOnce();
  });
  it('preserves the macOS blocked-directory result', async () => {
    platform('darwin');
    await expect(openProject('project')).resolves.toEqual({ success: false, error: { type: 'path-access-blocked', path: '/readable' } });
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it('still reports a real provider failure on Linux', async () => {
    platform('linux');
    mocks.open.mockResolvedValue({ success: false, error: { message: 'EACCES: permission denied' } });
    await expect(openProject('project')).resolves.toEqual({ success: false, error: { type: 'error', message: 'EACCES: permission denied' } });
  });
  it('still rejects a missing directory before creating its provider', async () => {
    platform('linux');
    mocks.valid.mockReturnValue(false);
    await expect(openProject('project')).resolves.toEqual({ success: false, error: { type: 'path-not-found', path: '/readable' } });
    expect(mocks.open).not.toHaveBeenCalled();
  });
});
