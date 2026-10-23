import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { AgentStatusWriterHooks } from '../agent-status/agent-status-writer';
const mocks = vi.hoisted(() => ({ sqlite: undefined as Database.Database | undefined,
  status: undefined as AgentStatusWriterHooks['agent:status'] | undefined }));
vi.mock('@main/db/client', () => ({ get sqlite() { return mocks.sqlite; } }));
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
  it('collects lifecycle and durable question settlements, never their title/options/answer', async () => {
    sessionEvents._emit('session:renamed', 's1', 'p1', 'SECRET SESSION TITLE');
    await new Promise<void>(resolve => setImmediate(resolve));
    const request = { itemId: 'agent-question:q1', kind: 'question', title: 'SECRET QUESTION',
      options: [{ optionId: 'yes', name: 'SECRET OPTION' }],
      questions: [{ question: 'SECRET QUESTION', multiSelect: false, options: [{ optionId: 'yes', name: 'SECRET OPTION' }] }],
      host: { kind: 'agent-question', payload: { deliveryVersion: 1,
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
