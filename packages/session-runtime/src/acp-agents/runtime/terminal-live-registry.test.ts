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

  it('hands out the same snapshot objects until a terminal changes (#994)', () => {
    const registry = new TerminalLiveRegistry();
    const chunk = (id: string, text: string) => registry.accept('task', 'scope', { kind: 'terminal_chunk', terminal: { terminalId: id, data: b64(text) } });
    chunk('a', 'A');
    chunk('b', 'B');
    const first = registry.snapshotSession('task');
    expect(registry.snapshotSession('task'), 'nothing changed: the same list').toBe(first);
    chunk('b', '2');
    const second = registry.snapshotSession('task');
    expect(second).not.toBe(first);
    expect(second[0], 'the untouched terminal keeps its object').toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    expect(second[1].output).toBe('B2');

    const host = { terminalId: 'h', owner: 'host' as const, canKill: true, command: 'sleep', args: [], cwd: '/w', output: 'x', truncated: false, exitStatus: null };
    registry.hooks.onTerminalCreated({ sessionId: 'task', scope: 'scope', terminalId: 'h', command: 'sleep', args: [], cwd: '/w', snapshot: host } as Parameters<typeof registry.hooks.onTerminalCreated>[0]);
    const withHost = registry.snapshotSession('task');
    expect(withHost).toHaveLength(3);
    registry.hooks.onTerminalReleased({ sessionId: 'task', scope: 'scope', terminalId: 'h' });
    const released = registry.snapshotSession('task');
    expect(released[2]).not.toBe(withHost[2]);
    expect(released[2].canKill).toBe(false);
    expect(released[0]).toBe(withHost[0]);
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
