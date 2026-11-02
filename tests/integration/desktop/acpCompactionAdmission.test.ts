// @@@vitest-environment node
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { noopLogger } from '@gugu/session-shared/logger';
import { connectStdioAcpV2 } from '../../../packages/session-plugins/src/agents/helpers/acp-v2';
import { SessionCell } from '../../../packages/session-runtime/src/acp-agents/session/cell';

const fixture = fileURLToPath(new URL('../../fixtures/acp-admission/agent.mjs', import.meta.url));
let child: ChildProcessWithoutNullStreams | undefined;
let cell: SessionCell | undefined;
afterEach(async () => {
  const current = child;
  child = undefined;
  if (current && current.exitCode === null && current.signalCode === null) {
    const exited = once(current, 'exit');
    current.stdin.end();
    await exited;
  }
  cell = undefined;
});

async function start(scenario: string) {
  child = spawn(process.execPath, [fixture, scenario], { stdio: ['pipe', 'pipe', 'pipe'] });
  const records: Array<Record<string, unknown>> = [];
  createInterface({ input: child.stderr }).on('line', line => {
    const record = JSON.parse(line) as Record<string, unknown>;
    records.push(record);
    console.info(JSON.stringify(record));
  });
  const api = connectStdioAcpV2(child, () => ({
    sessionEvent: notification => cell!.push(notification.event),
    requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
  }));
  await api.initialize({ protocolVersion: 1, clientCapabilities: {} });
  const native = await api.newSession({ cwd: process.cwd(), mcpServers: [] });
  cell = new SessionCell({ sessionId: 'host', projectId: 'project', providerId: 'stdio-fixture',
    acpSessionId: native.sessionId, agent: api, logger: noopLogger,
    resolveAttachment: async () => ({ data: '', mimeType: 'image/png' }) });
  child.once('exit', (exitCode, signal) => cell?.processClosed({ exitCode, signal, stderrTail: '' }));
  cell.applySessionReady();
  return { sent: cell.promptDetached({ text: 'body', origin: 'communication' }), records };
}

describe('native compaction admission over a child process stdio', () => {
  it('waits for a durable receipt after 90 seconds of native compaction', async () => {
    const { sent, records } = await start('compaction');
    expect(await sent.admission).toMatchObject({ success: true });
    expect(await sent.completion).toMatchObject({ success: true });
    expect(records.filter(record => record.event === 'cancel')).toEqual([]);
    expect(cell!.history().committed[0].items).toContainEqual(expect.objectContaining({ kind: 'message', messageId: 'persisted-user' }));
  }, 130_000);

  it('still cancels a genuinely silent unaccepted prompt with the existing 60-second deadline', async () => {
    const { sent } = await start('silence');
    expect(await sent.admission).toMatchObject({ success: false, error: { cause: { code: 'prompt_admission_timeout' } } });
    expect(await sent.completion).toMatchObject({ success: false });
  }, 80_000);

  it.each(['idle', 'exit'])('fails unaccepted input when compaction ends through %s without completed', async scenario => {
    const { sent } = await start(scenario);
    expect(await sent.admission).toMatchObject({ success: false });
    expect(await sent.completion).toMatchObject({ success: false });
  });
});
