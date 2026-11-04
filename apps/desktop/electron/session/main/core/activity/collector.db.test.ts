import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { AgentStatusWriterHooks } from '../agent-status/agent-status-writer';
const mocks = vi.hoisted(() => ({ sqlite: undefined as Database.Database | undefined,
  status: undefined as AgentStatusWriterHooks['agent:status'] | undefined }));
vi.mock('@main/db/client', () => ({ get sqlite() { return mocks.sqlite; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: {
  on: (_: string, callback: AgentStatusWriterHooks['agent:status']) => {
    mocks.status = callback;
    return () => { mocks.status = undefined; };
  },
} }));
import { installActivityCollector, activityJournal } from './collector';
import { sessionEvents } from '../sessions/session-events';
import { rememberAgentQuestion, settleAgentQuestionRecord } from '../sessions/agent-question-store';
import type { PendingRequest } from '@gugu/session-core/session-record';
import { createDesktopGuguMcpHost } from '../../../../acp-engine-utils';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { runActivityAction, type ActivityAction } from './actions';
import { projectEvents } from '../projects/project-events';
import { scaffoldExtension } from '../extensions/extension-authoring';
import { ExtensionsService } from '../extensions/extensions-service';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';

let fixture: Awaited<ReturnType<typeof openFixture>>;
let stop: () => void;
let home: string;
beforeEach(async () => {
  fixture = await openFixture('empty'); mocks.sqlite = fixture.sqlite;
  home = mkdtempSync(join(tmpdir(), 'gugu-activity-collector-')); vi.stubEnv('GUGU_HOME', home);
  stop = installActivityCollector();
});
afterEach(() => { stop?.(); fixture?.close(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const query = () => activityJournal().list({ since: '2020-01-01T00:00:00Z', until: '2100-01-01T00:00:00Z' });

describe('boot-installed collector and real committed producers', () => {
  it('records project identities without copying their name or directory', async () => {
    projectEvents._emit('project:created', { type: 'local', id: 'p1', name: 'PRIVATE PROJECT', path: '/PRIVATE/DIRECTORY',
      createdAt: '2026-10-21 00:00:00', updatedAt: '2026-10-21 00:00:00', baseRef: null, repositoryWorkspaceId: null });
    projectEvents._emit('project:deleted', 'p1');
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(query().events.map(e => e.kind)).toEqual(['project.created', 'project.deleted']);
    expect(query().events.every(e => e.project_id === 'p1')).toBe(true);
    expect(JSON.stringify(query())).not.toContain('PRIVATE');
  });
  it('separates completed App source writes from successful install/replacement, with no save watcher or failed-install fact', () => {
    const targetDir = join(home, 'source');
    const manifest = { id: 'activity-demo', name: 'PRIVATE APP NAME', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
      platforms: ['desktop'],
      entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'PRIVATE TAB' }] } };
    const make = (version: string, update = false) => scaffoldExtension({ targetDir, manifest: { ...manifest, version },
      files: { 'index.html': '<p>PRIVATE APP SOURCE</p>' }, update });
    const service = new ExtensionsService(join(home, 'installed'));
    make('1.0.0');
    const first = service.inspectDirectory(targetDir);
    expect(() => service.installFromDirectory(targetDir, 'wrong-digest', 'folder')).toThrow();
    service.installFromDirectory(targetDir, first.manifestDigest, 'folder');
    make('2.0.0', true);
    service.installFromDirectory(targetDir, service.inspectDirectory(targetDir).manifestDigest, 'folder');
    // Same version can be reinstalled; replacement is not a claim that its version increased.
    service.installFromDirectory(targetDir, service.inspectDirectory(targetDir).manifestDigest, 'folder');
    writeFileSync(join(targetDir, 'index.html'), 'PRIVATE UNSAVED-INSTALL EDIT');
    expect(() => make('3.0.0')).toThrow();
    const internal = new ExtensionsService(join(home, 'internal'));
    internal.installFromDirectory(targetDir, internal.inspectDirectory(targetDir).manifestDigest, 'preinstalled');
    expect(query().events.map(e => e.kind)).toEqual([
      'app.source_created', 'app.installed', 'app.source_updated', 'app.replaced', 'app.replaced',
    ]);
    expect(query().events.map(e => e.app_version)).toEqual(['1.0.0', '1.0.0', '2.0.0', '2.0.0', '2.0.0']);
    expect(JSON.stringify(query())).not.toContain('PRIVATE');
  });
  it('does not treat PTY enter notifications as verified user submissions', async () => {
    for (let i = 0; i < 200; i++) sessionEvents._emit('session:input-submitted', {
      projectId: 'p1', sessionId: 's1', providerId: 'codex',
    });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(query().events).toEqual([]);
    expect(query().coverage.untracked).toContain('terminal_input_submission');
  });
  it('collects lifecycle and durable question settlements, never their title/options/answer', async () => {
    sessionEvents._emit('session:renamed', 's1', 'p1', 'SECRET SESSION TITLE');
    await new Promise<void>(resolve => setImmediate(resolve));
    const request = { itemId: 'agent-question:q1', kind: 'question', title: 'SECRET QUESTION',
      options: [{ optionId: 'yes', name: 'SECRET OPTION' }],
      questions: [{ question: 'SECRET QUESTION', multiSelect: false, options: [{ optionId: 'yes', name: 'SECRET OPTION' }] }],
      origin: { source: 'agent-question', payload: { deliveryVersion: 1,
        answerMessageId: '22222222-2222-4222-8222-222222222222', sourceLink: null } },
    } as PendingRequest;
    rememberAgentQuestion('s1', request);
    settleAgentQuestionRecord('s1', request.itemId, { state: 'resolved', optionId: 'SECRET ANSWER', by: 'owner' });
    expect(query().events.map(e => e.kind)).toEqual(['session.renamed', 'question.pending', 'question.resolved']);
    expect(JSON.stringify(query())).not.toContain('SECRET');
  });
  it('uses the canonical event time and ignores a read/unread-only publication', async () => {
    const change = { sessionId: 's1', projectId: 'p1', unseen: true, reviewGate: null, providerBlocker: null, statusSourceFault: null,
      reading: { status: 'idle' as const, detail: 'done' as const, running: false, background: null } };
    await mocks.status?.(change);
    expect(query().events).toEqual([]);
    const at = Date.parse('2026-10-20T05:00:00Z');
    await mocks.status?.({ ...change, activityAt: at });
    expect(query().events).toMatchObject([{ kind: 'agent.status', occurred_at: at, status: 'idle', detail: 'done' }]);
  });
  it('reads a committed activity through the real HTTP grant and catalog tool, without a preview call', async () => {
    sessionEvents._emit('session:renamed', 's1', 'p1', 'SECRET RENAMED TITLE');
    await new Promise<void>(resolve => setImmediate(resolve));
    const host = createDesktopGuguMcpHost();
    const client = new Client({ name: 'activity-product-path', version: '1' });
    try {
      await host.start();
      const grant = await host.grant('activity-test', { kind: 'session-only', expectedOwnerUserId: 'owner', subjectId: 's1',
        runSessionAction: action => runActivityAction(action as ActivityAction) });
      await client.connect(new StreamableHTTPClientTransport(new URL(grant.url), {
        requestInit: { headers: { Authorization: `Bearer ${grant.capability}` } },
      }));
      const result = await client.callTool({ name: 'catalog_call', arguments: { tool: 'activity_list',
        args: { since: '2020-01-01T00:00:00Z', until: '2100-01-01T00:00:00Z', session_id: 'session:s1' } } });
      expect(result.isError).not.toBe(true);
      expect(result.content).toMatchObject([{ type: 'text', text: expect.stringContaining('session.renamed') }]);
      expect(JSON.stringify(result)).not.toContain('SECRET');
    } finally { await client.close(); await host.dispose(); }
  });
});
