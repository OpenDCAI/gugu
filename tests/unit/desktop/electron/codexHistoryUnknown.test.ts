import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, describe, expect, it } from 'vitest';
import { awaitFact } from '../../../support/awaitFact';

const ADAPTER = resolve('apps/desktop/electron/runtime/codex-app-server-acp.mjs');
const FAKE_CODEX = `#!/usr/bin/env node
const out = (m) => process.stdout.write(JSON.stringify(m) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  if (m.method === 'initialize') return out({id:m.id,result:{userAgent:'fixture'}});
  if (m.method === 'thread/resume') return out({id:m.id,result:{thread:{id:'same-thread',historyMode:'paginated',ephemeral:false},model:'gpt-5',reasoningEffort:'medium'}});
  if (m.method === 'thread/turns/list') return out({id:m.id,error:{code:-32603,message:'fixture history unavailable'}});
  if (m.method === 'turn/start') {
    const turn = {id:'resumed-turn',status:'completed'};
    out({method:'item/started',params:{item:{type:'userMessage',id:'user-'+m.id,clientId:m.params.clientUserMessageId,content:m.params.input}}});
    out({id:m.id,result:{turn}});
    return out({method:'turn/completed',params:{threadId:'same-thread',turn}});
  }
  if (m.method === 'model/list') return out({id:m.id,result:{data:[{id:'gpt-5',model:'gpt-5',displayName:'GPT-5',isDefault:true,supportedReasoningEfforts:[]}]}});
  out({id:m.id,result:{data:[]}});
});
`;

let dir = '';
let child: ChildProcessWithoutNullStreams | undefined;
afterEach(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = new Promise((done) => child!.once('exit', done));
    child.kill('SIGTERM');
    await ended;
  }
  child = undefined;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('Codex history uncertainty is an explicit load result', () => {
  it('returns history_unknown rather than success when native history could not be read', async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'gugu-history-unknown-')));
    const fake = join(dir, 'fake-codex.cjs');
    writeFileSync(fake, FAKE_CODEX);
    chmodSync(fake, 0o755);
    const process = spawn(globalThis.process.execPath, [ADAPTER], {
      cwd: dir,
      env: { ...globalThis.process.env, GUGU_CODEX_BIN: fake,
        GUGU_HOME: join(dir, 'gugu-home'), GUGU_USER_DATA_DIR: join(dir, 'gugu-userdata') },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child = process;
    const replies = new Map<number, { result?: unknown; error?: unknown }>();
    const updates: unknown[] = [];
    createInterface({ input: process.stdout }).on('line', (line) => {
      const message = JSON.parse(line);
      if (message.id !== undefined && !message.method) replies.set(message.id, message);
      if (message.method === 'session/update') updates.push(message.params);
    });
    let id = 0;
    const request = async (method: string, params: unknown) => {
      const requestId = ++id;
      process.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) + '\n');
      return awaitFact(method, () => replies.get(requestId), { producer: process });
    };
    // The native shim speaks ACP v2: a saved thread reopens with session/resume.
    await request('initialize', { protocolVersion: 2, capabilities: {} });
    const reply = await request('session/resume', { sessionId: 'same-thread', cwd: dir, mcpServers: [], replayFrom: { type: 'start' } });
    expect(reply).toMatchObject({ error: { data: { kind: 'history_unknown', sessionId: 'same-thread' } } });
    expect(reply).not.toHaveProperty('result');
    expect(updates).toEqual(expect.arrayContaining([expect.objectContaining({
      sessionId: 'same-thread', update: expect.objectContaining({
        sessionUpdate: 'config_option_update', configOptions: expect.arrayContaining([
          expect.objectContaining({ configId: 'model', currentValue: 'gpt-5' }),
        ]),
      }),
    })]));
    expect(await request('session/prompt', { sessionId: 'same-thread', prompt: [{ type: 'text', text: 'after unknown history' }] }))
      // The resumed thread still takes input: v2's receipt names the echoed message.
      .toMatchObject({ result: { messageId: expect.any(String) } });
  });
});
