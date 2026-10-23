// @@@vitest-environment node
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { chmodSync, mkdtempSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import * as v2 from '@agentclientprotocol/sdk/experimental/v2';
import { expect, it } from 'vitest';
import { awaitFact } from '../../../support/awaitFact';

const patch = '@@ -1 +1 @@\r\n-before\r\n+after\r\n';
const source = `#!/usr/bin/env node
const out = m => process.stdout.write(JSON.stringify(m) + '\\n')
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line)
  if (m.method === 'thread/start' || m.method === 'thread/resume') return out({ id: m.id, result: { thread: { id: 'thread', historyMode: 'paginated', turns: [] }, model: 'model', reasoningEffort: 'medium', activePermissionProfile: ':workspace' } })
  if (m.method === 'model/list') return out({ id: m.id, result: { data: [{ id: 'model', model: 'model', displayName: 'Model', supportedReasoningEfforts: [{ reasoningEffort: 'medium' }] }] } })
  if (m.method === 'permissionProfile/list') return out({ id: m.id, result: { data: [{ id: ':workspace', name: 'Workspace', allowed: true }] } })
  if (m.method === 'turn/start') {
    out({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } })
    out({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { type: 'userMessage', id: 'native-user', content: m.params.input } } })
    out({ method: 'item/started', params: { threadId: 'thread', turnId: 'turn', item: { type: 'fileChange', id: 'edit', status: 'inProgress', changes: [{ path: 'C:\\\\work\\\\before.ts', kind: { type: 'update', move_path: 'C:\\\\work\\\\after.ts' }, diff: ${JSON.stringify(patch)} }] } } })
    return out({ id: m.id, result: { turn: { id: 'turn' } } })
  }
  if (m.method === 'turn/interrupt') {
    out({ id: m.id, result: {} })
    return out({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'interrupted' } } })
  }
  if (m.id !== undefined) out({ id: m.id, result: { data: [] } })
})
`;

it('speaks SDK-validated v2: setup, native insertion receipt before idle, patch bytes, cancel and resume snapshot', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-v2-'));
  const fake = join(dir, 'codex.cjs');
  writeFileSync(fake, source); chmodSync(fake, 0o755);
  const child = spawn(process.execPath, [resolve('apps/desktop/electron/runtime/codex-app-server-acp.mjs')], {
    cwd: dir, env: { ...process.env, GUGU_CODEX_BIN: fake }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const updates: v2.SessionUpdate[] = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const connection = v2.client({ name: 'test' }).onNotification(v2.methods.client.session.update, ({ params }) => { updates.push(params.update); }).connect(
    v2.ndJsonStream(Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>),
  );
  try {
    const init = await connection.agent.request(v2.methods.agent.initialize, { protocolVersion: 2, info: { name: 'test', version: '1' } });
    expect(init.protocolVersion).toBe(2);
    expect(init.capabilities?.session?.prompt?.image).toEqual({});
    const created = await connection.agent.request(v2.methods.agent.session.new, { cwd: dir, mcpServers: [] });
    expect(created.sessionId).toBe('thread');
    expect(created.configOptions?.every(option => typeof option.configId === 'string')).toBe(true);
    const receipt = await connection.agent.request(v2.methods.agent.session.prompt, { sessionId: 'thread', prompt: [{ type: 'text', text: 'Edit' }] });
    expect(receipt).toEqual({ messageId: 'native-user' });
    expect(updates).toContainEqual({ sessionUpdate: 'user_message', messageId: 'native-user', content: [{ type: 'text', text: 'Edit' }] });
    expect(updates.some(update => update.sessionUpdate === 'state_update' && update.state === 'idle')).toBe(false);
    const edit = updates.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === 'edit') as v2.ToolCallUpdate;
    expect(edit.content).toMatchObject([{ type: 'diff', changes: [{ operation: 'move', oldPath: 'C:\\work\\before.ts', path: 'C:\\work\\after.ts' }], patch: { format: 'git_patch', text: expect.stringContaining(patch) } }]);
    await connection.agent.notify(v2.methods.agent.session.cancel, { sessionId: 'thread' });
    await awaitFact('native idle after cancel', () => updates.find(update => update.sessionUpdate === 'state_update' && update.state === 'idle'), { producer: child });
    expect(updates.at(-1)).toMatchObject({ state: 'idle', stopReason: 'cancelled' });
    const before = updates.length;
    await connection.agent.request(v2.methods.agent.session.resume, { sessionId: 'thread', cwd: dir, mcpServers: [], replayFrom: { type: 'start' } });
    expect(updates.slice(before)).toContainEqual({ sessionUpdate: 'state_update', state: 'idle' });
    expect(stderr).not.toMatch(/non-JSON|failed|unmatched/);
  } finally {
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    unlinkSync(fake); rmdirSync(dir);
  }
});
