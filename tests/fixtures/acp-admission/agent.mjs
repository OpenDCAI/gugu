// A real stdio peer. No model, network, receipt mocks, or host clock overrides.
import { createInterface } from 'node:readline';
const scenario = process.argv[2];
const sessionId = 'compaction-admission-fixture';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const record = event => process.stderr.write(JSON.stringify({ at: Date.now(), pid: process.pid, ...event }) + '\n');
const update = value => { record({ event: 'update', sessionId, update: value.sessionUpdate, status: value.status });
  send({ method: 'session/update', params: { sessionId, update: value } }); };
const timers = new Set();
const later = (ms, action) => { const timer = setTimeout(() => { timers.delete(timer); action(); }, ms); timers.add(timer); };
let promptId;
const input = createInterface({ input: process.stdin });
input.on('close', () => { for (const timer of timers) clearTimeout(timer); process.exit(0); });
input.on('line', line => {
  const message = JSON.parse(line);
  record({ event: 'received', method: message.method, sessionId: message.params?.sessionId });
  if (message.method === 'initialize') send({ id: message.id, result: { protocolVersion: 2,
    info: { name: 'compaction-admission-fixture', version: '1' }, capabilities: {}, authMethods: [] } });
  if (message.method === 'session/new') send({ id: message.id, result: { sessionId } });
  if (message.method === 'session/prompt') {
    promptId = message.id;
    update({ sessionUpdate: 'state_update', state: 'running' });
    if (scenario === 'silence') return;
    update({ sessionUpdate: 'compaction_update', compactionId: 'compact', status: 'in_progress' });
    if (scenario === 'idle') {
      later(10, () => update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }));
    } else if (scenario === 'exit') {
      later(10, () => process.exit(1));
    } else if (scenario === 'compaction') {
      // Only the native start and end are needed: compaction itself may be silent for >60 seconds.
      later(90_000, () => {
        update({ sessionUpdate: 'compaction_update', compactionId: 'compact', status: 'completed' });
        update({ sessionUpdate: 'user_message', messageId: 'persisted-user', content: [{ type: 'text', text: 'body' }] });
        record({ event: 'receipt', sessionId });
        send({ id: promptId, result: { messageId: 'persisted-user' } });
        setImmediate(() => update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'end_turn' }));
      });
    } else throw new Error(`Unknown scenario: ${scenario}`);
  }
  if (message.method === 'session/cancel') {
    record({ event: 'cancel', sessionId });
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
    send({ id: promptId, error: { code: -32800, message: 'Request cancelled before insertion' } });
    update({ sessionUpdate: 'state_update', state: 'idle', stopReason: 'cancelled' });
  }
});
