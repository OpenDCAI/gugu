import { describe, expect, it } from 'vitest';
import { decodeSessionUpdate, terminalEntityId, type NormalizedEvent } from '@gugu/session-core/acp';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { AgentTerminalManager } from '../agent-ports/terminal-manager';
import { TerminalPort } from '../agent-ports/terminal-port';
import { FakeAcpProcessHost, FakeAcpTerminalProcess } from '../acp-test-support';
import { TerminalLiveRegistry } from './terminal-live-registry';

const b64 = (text: string) => Buffer.from(text).toString('base64');
const event = (update: object) => decodeSessionUpdate(update as SessionUpdate);

describe('terminal entities', () => {
  it('joins every UTF-8 byte split without emitting replacement characters', () => {
    const bytes = Buffer.from('a🙂中\r\nb');
    for (let split = 1; split < bytes.length; split++) {
      const registry = new TerminalLiveRegistry();
      const chunk = (data: Buffer) => registry.accept('task', 'scope', { kind: 'terminal_chunk', terminal: { terminalId: 't', data: data.toString('base64') } });
      chunk(bytes.subarray(0, split));
      expect(registry.snapshotSession('task')[0].output).not.toContain('�');
      chunk(bytes.subarray(split));
      expect(registry.snapshotSession('task')[0].output).toBe(bytes.toString());
    }
  });

  it('retains unreferenced output through exit and a late tool reference, with session-local identities', () => {
    const registry = new TerminalLiveRegistry();
    for (const [provider, output] of [['a', 'FIRST'], ['b', 'SECOND']]) {
      registry.route('task', 'connection', provider, event({ sessionUpdate: 'terminal_update', terminalId: 't', output: { data: b64(output) }, exitStatus: {} }));
    }
    const ref = (provider: string) => registry.route('task', 'connection', provider, event({ sessionUpdate: 'tool_call_update', toolCallId: provider, content: [{ type: 'terminal', terminalId: 't' }] })) as Extract<NormalizedEvent, { kind: 'tool_update' }>;
    expect(ref('a').terminalId).not.toBe(ref('b').terminalId);
    const snapshot = registry.snapshotSession('task');
    expect(snapshot.find(t => t.terminalId === ref('a').terminalId)).toMatchObject({ output: 'FIRST', owner: 'agent', canKill: false, exitStatus: { exitCode: null, signal: null } });
    expect(snapshot.find(t => t.terminalId === ref('b').terminalId)?.output).toBe('SECOND');
    // A new subscriber gets the same final entity without replaying a tool or byte stream.
    expect(JSON.parse(JSON.stringify(registry.snapshotSession('task')))).toEqual(snapshot);
    registry.disposeSession('task');
    expect(registry.snapshotSession('task')).toEqual([]);
  });

  it('replaces output, appends bytes, and distinguishes omitted and null fields', () => {
    const registry = new TerminalLiveRegistry();
    const push = (fields: object) => registry.accept('task', 'scope', event({ sessionUpdate: 'terminal_update', terminalId: 't', ...fields }) as Extract<NormalizedEvent, { kind: 'terminal_update' }>);
    push({ command: 'old', cwd: '/w', output: { data: b64('long output') }, _meta: { a: 1, b: 2 }, exitStatus: { exitCode: 1 } });
    push({ output: { data: b64('x') }, _meta: { a: null }, exitStatus: null });
    registry.accept('task', 'scope', { kind: 'terminal_chunk', terminal: { terminalId: 't', data: b64('y') } });
    expect(registry.snapshotSession('task')[0]).toMatchObject({ command: 'old', cwd: '/w', output: 'xy', _meta: { b: 2 }, exitStatus: null });
    push({ command: null, cwd: null, output: null, _meta: null });
    expect(registry.snapshotSession('task')[0]).toMatchObject({ command: '', cwd: '', output: '', exitStatus: null });
    expect(registry.snapshotSession('task')[0]._meta).toBeUndefined();
  });

  it('shares host snapshots, retains release output, and rejects control from another session or a display entity', async () => {
    const host = new FakeAcpProcessHost();
    const proc = new FakeAcpTerminalProcess();
    host.nextTerminal = proc;
    const registry = new TerminalLiveRegistry();
    const manager = new AgentTerminalManager(host, registry.hooks);
    const port = new TerminalPort(manager);
    const { terminalId } = await port.createTerminal('task', '/w', { sessionId: 'provider', command: 'echo' }, 'connection');
    proc.pushOutput('kept');
    const entityId = terminalEntityId(JSON.stringify(['connection', 'provider']), terminalId);
    expect(registry.snapshotSession('task')[0]).toMatchObject({ terminalId: entityId, output: 'kept', owner: 'host', canKill: true });
    await expect(port.killTerminal({ sessionId: 'stranger', terminalId }, 'connection')).rejects.toThrow('not found');
    registry.accept('task', 'other', { kind: 'terminal_chunk', terminal: { terminalId: 'display', data: b64('readonly') } });
    await expect(port.killTerminal({ sessionId: 'provider', terminalId: 'display' }, 'connection')).rejects.toThrow('not found');
    proc.triggerExit({ exitCode: 0, signal: null });
    port.releaseTerminal({ sessionId: 'provider', terminalId }, 'connection');
    expect(registry.snapshotSession('task')[0]).toMatchObject({ output: 'kept', canKill: false, exitStatus: { exitCode: 0, signal: null } });
    expect(manager.get(terminalId)).toBeUndefined();
  });
});
