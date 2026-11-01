import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import { expect, it } from 'vitest';
import { awaitFact } from '../../../support/awaitFact';

async function fixture(body: string) {
  const dir = mkdtempSync(join(tmpdir(), 'codex-v2-receipts-'));
  const bin = join(dir, 'codex.cjs');
  writeFileSync(bin, `#!/usr/bin/env node
const out = message => process.stdout.write(JSON.stringify(message) + '\\n')
const inputs = []
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
 const m = JSON.parse(line)
 if (m.method === 'thread/start') return out({ id: m.id, result: { thread: { id: 'thread', turns: [] }, model: 'model', activePermissionProfile: ':workspace' } })
 if (m.method === 'model/list') return out({ id: m.id, result: { data: [{ id: 'model', model: 'model', displayName: 'Model' }] } })
 if (m.method === 'permissionProfile/list') return out({ id: m.id, result: { data: [{ id: ':workspace', name: 'Workspace', allowed: true }] } })
 ${body}
 if (m.id !== undefined) out({ id: m.id, result: { data: [] } })
})`);
  chmodSync(bin, 0o755);
  const child = spawn(process.execPath, [resolve('apps/desktop/electron/runtime/codex-app-server-acp.mjs')], {
    cwd: dir, env: { ...process.env, GUGU_CODEX_BIN: bin }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const updates: v2.SessionUpdate[] = [];
  const connection = v2.client({ name: 'fixture' }).onNotification(v2.methods.client.session.update, ({ params }) => { updates.push(params.update); }).connect(
    v2.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
  );
  const initialized = await connection.agent.request(v2.methods.agent.initialize, { protocolVersion: 2, info: { name: 'fixture', version: '1' } });
  await connection.agent.request(v2.methods.agent.session.new, { cwd: dir, mcpServers: [] });
  return { child, updates, initialized, agent: connection.agent, close: async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    }
    unlinkSync(bin); rmdirSync(dir);
  } };
}

it('correlates native client IDs, including reverse receipts and an unrelated user echo before idle', async () => {
  const p = await fixture(`
 if (m.method === 'turn/start' || m.method === 'turn/steer') {
  inputs.push(m)
  if (inputs.length < 2) return
  const [a, b] = inputs
  out({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } })
  const user = (request, id, clientId) => out({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { type: 'userMessage', id, clientId, content: request.params.input } } })
  user(a, 'unowned-native', 'another-client')
  user(b, 'second-native', b.params.clientUserMessageId)
  out({ id: b.id, result: { turn: { id: 'turn' } } })
  out({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed' } } })
  out({ id: a.id, result: { turn: { id: 'turn' } } })
  user(a, 'first-native', a.params.clientUserMessageId)
  return
 }`);
  try {
    const completed: string[] = [];
    const first = p.agent.request(v2.methods.agent.session.prompt, { sessionId: 'thread', prompt: [{ type: 'text', text: 'first' }] }).then(receipt => { completed.push('first'); return receipt; });
    const second = p.agent.request(v2.methods.agent.session.prompt, { sessionId: 'thread', prompt: [{ type: 'text', text: 'second' }] }).then(receipt => { completed.push('second'); return receipt; });
    expect(await Promise.all([first, second])).toEqual([{ messageId: 'first-native' }, { messageId: 'second-native' }]);
    expect(completed).toEqual(['second', 'first']);
    expect(p.updates).toContainEqual({ sessionUpdate: 'user_message', messageId: 'unowned-native', content: [{ type: 'text', text: 'first' }] });
    expect(p.updates).toContainEqual({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' });
  } finally { await p.close(); }
});

const awaitingInsertion = `
 if (m.method === 'turn/start') {
  inputs.push(m)
  const id = 'turn-' + inputs.length
  out({ method: 'turn/started', params: { threadId: 'thread', turn: { id } } })
  out({ id: m.id, result: { turn: { id } } })
  if (inputs.length > 1) {
   out({ method: 'item/started', params: { threadId: 'thread', turnId: id, item: { type: 'userMessage', id: 'next-native', clientId: m.params.clientUserMessageId, content: m.params.input } } })
   out({ method: 'turn/completed', params: { threadId: 'thread', turn: { id, status: 'completed' } } })
  }
  return
 }
 if (m.method === 'turn/interrupt') {
  out({ id: m.id, result: {} })
  return out({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: m.params.turnId, status: 'interrupted' } } })
 }`;

it('cancels an uninserted request without inventing acceptance, then admits a new cycle', async () => {
  const p = await fixture(awaitingInsertion);
  try {
    const pending = p.agent.request(v2.methods.agent.session.prompt, { sessionId: 'thread', prompt: [{ type: 'text', text: 'cancel' }] });
    const refused = expect(pending).rejects.toMatchObject({ code: -32800 });
    await awaitFact('native running before cancellation', () => p.updates.some(u => u.sessionUpdate === 'state_update' && u.state === 'running'), { producer: p.child });
    await p.agent.notify(v2.methods.agent.session.cancel, { sessionId: 'thread' });
    await refused;
    await awaitFact('native idle after cancellation', () => p.updates.some(u => u.sessionUpdate === 'state_update' && u.state === 'idle'), { producer: p.child });
    expect(await p.agent.request(v2.methods.agent.session.prompt, { sessionId: 'thread', prompt: [{ type: 'text', text: 'next' }] })).toEqual({ messageId: 'next-native' });
  } finally { await p.close(); }
});

it('connection exit rejects outstanding native receipts', async () => {
  const p = await fixture(awaitingInsertion);
  try {
    const pending = p.agent.request(v2.methods.agent.session.prompt, { sessionId: 'thread', prompt: [{ type: 'text', text: 'pending' }] });
    const refused = expect(pending).rejects.toBeDefined();
    await awaitFact('native running before close', () => p.updates.some(u => u.sessionUpdate === 'state_update' && u.state === 'running'), { producer: p.child });
    p.child.stdin.end();
    await refused;
  } finally { await p.close(); }
});

it('an older native completion cannot report idle for the new foreground cycle', async () => {
  const p = await fixture(`
 if (m.method === 'turn/start') {
  out({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'old' } } })
  out({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'current' } } })
  out({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'old', status: 'completed' } } })
  out({ method: 'item/started', params: { threadId: 'thread', turnId: 'current', item: { type: 'userMessage', id: 'inserted', clientId: m.params.clientUserMessageId, content: m.params.input } } })
  return out({ id: m.id, result: { turn: { id: 'current' } } })
 }`);
  try {
    expect(await p.agent.request(v2.methods.agent.session.prompt, { sessionId: 'thread', prompt: [{ type: 'text', text: 'current' }] })).toEqual({ messageId: 'inserted' });
    expect(p.updates.filter(u => u.sessionUpdate === 'state_update')).toEqual([
      { sessionUpdate: 'state_update', state: 'running' },
      { sessionUpdate: 'state_update', state: 'running' },
    ]);
  } finally { await p.close(); }
});

it('steering admits later inputs without an echo, suppresses its echoes and preserves other clients', async () => {
  const p = await fixture(`
 if (m.method === 'turn/start') {
  out({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } })
  out({ method: 'item/started', params: { item: { type: 'userMessage', id: 'start', clientId: m.params.clientUserMessageId, content: m.params.input } } })
  return out({ id: m.id, result: { turn: { id: 'turn' } } })
 }
 if (m.method === 'turn/steer') {
  inputs.push(m)
  out({ id: m.id, result: { turnId: 'turn' } })
  if (inputs.length === 2) {
   for (const request of inputs) out({ method: 'item/started', params: { item: { type: 'userMessage', id: 'steer-' + request.id, clientId: request.params.clientUserMessageId, content: request.params.input } } })
   out({ method: 'item/started', params: { item: { type: 'userMessage', id: 'other-client', clientId: 'other', content: [{ type: 'text', text: 'external' }] } } })
  }
  return
 }`);
  const prompt = (text: string) => ({ sessionId: 'thread', prompt: [{ type: 'text' as const, text }] });
  try {
    expect(p.initialized._meta).toMatchObject({ steering: { supported: true } });
    expect(await p.agent.request('_session/steering', prompt('idle'))).toEqual({ outcome: 'promptRequired' });
    expect(await p.agent.request(v2.methods.agent.session.prompt, prompt('start'))).toEqual({ messageId: 'start' });
    for (const text of ['first', 'second']) expect(await p.agent.request('_session/steering', prompt(text))).toEqual({ outcome: 'injected' });
    await awaitFact('unsolicited user echo after both suppressed echoes', () => p.updates.some(update => update.sessionUpdate === 'user_message' && update.messageId === 'other-client') ? true : undefined, { producer: p.child });
    expect(p.updates.flatMap(update => update.sessionUpdate === 'user_message' ? [update.messageId] : [])).toEqual(['start', 'other-client']);
  } finally { await p.close(); }
});

it.each(['no active turn to steer', 'expected active turn id `old` but found `new`', 'cannot steer a compact turn', 'input must not be empty'])('a rejected steer returns to the normal prompt path: %s', async reason => {
  const p = await fixture(`
 if (m.method === 'turn/start') {
  inputs.push(m)
  if (inputs.length > 1 && ${JSON.stringify(reason)} === 'input must not be empty') return out({ id: m.id, error: { code: -32600, message: 'input must not be empty' } })
  out({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } })
  out({ method: 'item/started', params: { item: { type: 'userMessage', id: 'start', clientId: m.params.clientUserMessageId, content: m.params.input } } })
  return out({ id: m.id, result: { turn: { id: 'turn' } } })
 }
 if (m.method === 'turn/steer') return out({ id: m.id, error: { code: -32600, message: ${JSON.stringify(reason)} } })`);
  const params = { sessionId: 'thread', prompt: [{ type: 'text' as const, text: 'input' }] };
  try {
    await p.agent.request(v2.methods.agent.session.prompt, params);
    expect(await p.agent.request('_session/steering', params)).toEqual({ outcome: 'promptRequired' });
    expect(p.updates.filter(update => update.sessionUpdate === 'user_message')).toHaveLength(1);
    const prompt = p.agent.request(v2.methods.agent.session.prompt, params);
    if (reason === 'input must not be empty') await expect(prompt).rejects.toMatchObject({ message: reason });
    else expect(await prompt).toEqual({ messageId: 'start' });
  } finally { await p.close(); }
});
