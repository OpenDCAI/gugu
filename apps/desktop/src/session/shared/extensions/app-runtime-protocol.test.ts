import { readFileSync } from 'node:fs';
import * as encoding from 'lib0/encoding';
import { describe, expect, it } from 'vitest';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import {
  APP_RUNTIME_ENTRY,
  APP_RUNTIME_VERSION,
  FRAME_TYPE,
  encodeAuthFrame,
  encodeCloseFrame,
  encodeSyncUpdateFrame,
  fileRefOf,
  injectAppRuntime,
  isBareFrame,
  placeKey,
  placeOf,
  readAuthAnswer,
  readCloseFrame,
  readFrameHead,
  readSyncStatus,
  splitRoutingKey,
  workspaceSession,
  workspaceTarget,
} from './app-runtime-protocol';

const TAG = `<script src="${APP_RUNTIME_ENTRY}"></script>`;

/** A frame the way the Hocuspocus provider writes one: key, type, then the payload. */
function frame(key: string, type: number, write: (e: encoding.Encoder) => void = () => {}): Uint8Array {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, key);
  encoding.writeVarUint(e, type);
  write(e);
  return encoding.toUint8Array(e);
}

describe('injectAppRuntime', () => {
  it('writes the same tag the phone build puts into preinstalled Apps (vite.config.mts injectAppRuntimeTag)', () => {
    // That config cannot import this module, so it builds the tag itself: pin both to one form.
    expect(TAG).toBe(`<script src="/_gugu/${APP_RUNTIME_VERSION}/gugu.js"></script>`);
    const config = readFileSync(new URL('../../../../../../vite.config.mts', import.meta.url), 'utf8');
    expect(config).toContain('const tag = `<script src="/_gugu/${appRuntimeVersion()}/gugu.js"></script>`');
  });

  it('puts the runtime right after the doctype, so the page stays in standards mode', () => {
    const out = injectAppRuntime('<!doctype html><html><head><script src="app.js"></script></head></html>');
    expect(out.startsWith(`<!doctype html>${TAG}<html>`)).toBe(true);
    expect(out.indexOf(TAG)).toBeLessThan(out.indexOf('app.js'));
  });

  it('keeps a BOM and whitespace before the doctype where they were', () => {
    const out = injectAppRuntime('\uFEFF\n  <!DOCTYPE HTML>\n<body></body>');
    expect(out).toBe(`\uFEFF\n  <!DOCTYPE HTML>${TAG}\n<body></body>`);
  });

  it('prepends when there is no doctype', () => {
    expect(injectAppRuntime('<p>hi</p>')).toBe(`${TAG}<p>hi</p>`);
  });

  it('is idempotent', () => {
    const once = injectAppRuntime('<!doctype html><p></p>');
    expect(injectAppRuntime(once)).toBe(once);
  });
});


describe('frame heads', () => {
  const key = 'd0c0ffee-0000-4000-8000-000000000001@3\u0000abc123';

  it('reads the routing key and splits the document name from the session', () => {
    const head = readFrameHead(frame(key, FRAME_TYPE.Awareness, (e) => encoding.writeVarUint8Array(e, new Uint8Array([0]))));
    expect(head).toEqual({ key, type: FRAME_TYPE.Awareness, carriesUpdate: false });
    expect(splitRoutingKey(key)).toEqual({ docName: 'd0c0ffee-0000-4000-8000-000000000001@3', hocuspocusSessionId: 'abc123' });
    expect(splitRoutingKey('plain@1')).toEqual({ docName: 'plain@1', hocuspocusSessionId: null });
  });

  it('tells a Sync frame that changes the document from one that does not', () => {
    const doc = new Y.Doc();
    const empty = new Y.Doc();
    doc.getText('content').insert(0, 'hello');

    const step1 = frame(key, FRAME_TYPE.Sync, (e) => syncProtocol.writeSyncStep1(e, doc));
    const update = frame(key, FRAME_TYPE.Sync, (e) => syncProtocol.writeUpdate(e, Y.encodeStateAsUpdate(doc)));
    const fullStep2 = frame(key, FRAME_TYPE.Sync, (e) => syncProtocol.writeSyncStep2(e, doc, Y.encodeStateVector(empty)));
    // What a read-only page answers the server's Step 1 with: nothing it has that the server lacks.
    const emptyStep2 = frame(key, FRAME_TYPE.Sync, (e) => syncProtocol.writeSyncStep2(e, doc, Y.encodeStateVector(doc)));

    expect(readFrameHead(step1)?.carriesUpdate).toBe(false);
    expect(readFrameHead(update)?.carriesUpdate).toBe(true);
    expect(readFrameHead(fullStep2)?.carriesUpdate).toBe(true);
    expect(readFrameHead(emptyStep2)?.carriesUpdate).toBe(false);
  });

  it('returns null for bytes that are not a keyed frame', () => {
    expect(readFrameHead(new Uint8Array([0x80]))).toBeNull();
    expect(readFrameHead(Uint8Array.of(FRAME_TYPE.Ping))).toBeNull();
    expect(isBareFrame(Uint8Array.of(FRAME_TYPE.Ping), FRAME_TYPE.Ping)).toBe(true);
    expect(isBareFrame(Uint8Array.of(FRAME_TYPE.Ping, 0), FRAME_TYPE.Ping)).toBe(false);
  });
});

describe('frames main writes and reads for a will', () => {
  const key = 'docName@1\u0000will-1';

  it('writes Auth, Update and Close the way the provider does', () => {
    expect(encodeAuthFrame(key, '')).toEqual(frame(key, FRAME_TYPE.Auth, (e) => {
      encoding.writeVarUint(e, 0);
      encoding.writeVarString(e, '');
    }));
    const update = Y.encodeStateAsUpdate(new Y.Doc());
    expect(encodeSyncUpdateFrame(key, update)).toEqual(frame(key, FRAME_TYPE.Sync, (e) => syncProtocol.writeUpdate(e, update)));
    expect(encodeCloseFrame(key)).toEqual(frame(key, FRAME_TYPE.Close));
  });

  it('reads the service answers', () => {
    expect(readAuthAnswer(frame(key, FRAME_TYPE.Auth, (e) => encoding.writeVarUint(e, 2)))).toEqual({ key, ok: true });
    expect(
      readAuthAnswer(frame(key, FRAME_TYPE.Auth, (e) => {
        encoding.writeVarUint(e, 1);
        encoding.writeVarString(e, 'stale-epoch:4');
      })),
    ).toEqual({ key, ok: false, reason: 'stale-epoch:4' });
    expect(readSyncStatus(frame(key, FRAME_TYPE.SyncStatus, (e) => encoding.writeVarUint(e, 1)))).toEqual({ key, saved: true });
    expect(readCloseFrame(frame(key, FRAME_TYPE.Close, (e) => encoding.writeVarString(e, 'removed-from-group')))).toEqual({
      key,
      reason: 'removed-from-group',
    });
    // Control: a frame of another type is not mistaken for either.
    expect(readSyncStatus(frame(key, FRAME_TYPE.Close))).toBeNull();
    expect(readAuthAnswer(frame(key, FRAME_TYPE.SyncStatus, (e) => encoding.writeVarUint(e, 1)))).toBeNull();
  });
});

// 真源原则 13: every call names its place or file; where the page is never fills one in.
describe('places and file refs, as a call names them', () => {
  const C1 = '6f1c2b84-3d1e-4c3a-9f0e-0a1b2c3d4e5f';
  it('a place is exactly one of a conversation and a working copy; anything else is invalid, said how', () => {
    expect(placeOf({ chat: C1 })).toEqual({ chat: C1 });
    expect(placeOf({ workspace: 'session:s-1' })).toEqual({ workspace: 'session:s-1' });
    expect(placeOf({ workspace: 'project:p-1' })).toEqual({ workspace: 'project:p-1' });
    // API 25: a session and a project are one root now — the old keys are not places.
    for (const bad of [undefined, {}, { chat: '' }, { chat: C1, workspace: 'session:s-1' }, { session: 's-1' }, { project: 'p-1' }, { workspace: 's-1' }, { workspace: '' }, { chat: 7 }]) {
      expect(() => placeOf(bad)).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
    expect(workspaceTarget({ workspace: 'session:s-1' })).toEqual({ session: 's-1' });
    expect(workspaceTarget({ workspace: 'project:p-1' })).toEqual({ project: 'p-1' });
    expect([workspaceSession({ workspace: 'session:s-1' }), workspaceSession({ workspace: 'project:p-1' }), workspaceSession(null)]).toEqual(['s-1', null, null]);
  });

  it('a file: an entry or ctx.file, a chat file by its id alone, or a name with its place', () => {
    expect(fileRefOf({ chat: C1, id: 'i-1', name: 'a.json', type: 'json' })).toEqual({ chat: C1, id: 'i-1' });
    expect(fileRefOf({ workspace: 'session:s-1', id: 'docs/TODO.md' })).toEqual({ workspace: 'session:s-1', id: 'docs/TODO.md' });
    expect(fileRefOf({ id: 'i-1' })).toEqual({ id: 'i-1' });
    expect(fileRefOf({ chat: C1, name: 'a.json' })).toEqual({ chat: C1, name: 'a.json' });
    // L1 A project's file is its folder's, never a chat file by its id: the place it names stays on it.
    expect(fileRefOf({ workspace: 'project:p-1', id: 'docs/plan.md', name: 'plan.md' })).toEqual({ workspace: 'project:p-1', id: 'docs/plan.md' });
    expect(fileRefOf({ workspace: 'project:p-1', name: 'docs/plan.md' })).toEqual({ workspace: 'project:p-1', name: 'docs/plan.md' });
    expect(placeKey({ workspace: 'project:p-1' })).not.toBe(placeKey({ workspace: 'session:p-1' }));
    // A name says nothing of where; a session file's path says nothing of whose.
    for (const bad of ['a.json', { name: 'a.json' }, { workspace: '', id: 'x' }, { chat: '', id: 'x' }, {}]) {
      expect(() => fileRefOf(bad)).toThrow(expect.objectContaining({ code: 'invalid' }));
    }
  });

  // 编号 18 (10-12 片场试演): a program passed on the number people see (咕咕号) as the chat; it reached the chat's rows and
  // came back as the row policy's own words. Every chat-addressed call is refused here, before any row, saying what to pass.
  it('a chat is named by its id: its number, a name or a link is refused before any call, saying what to pass', () => {
    for (const chat of ['211380', 'chat-board', '片场试演', `gugu-chat://${C1}`, ` ${C1}`]) {
      for (const call of [() => placeOf({ chat }), () => fileRefOf({ chat, name: 'a.md' }), () => fileRefOf({ chat, id: 'i-1' })]) {
        expect(call).toThrow(expect.objectContaining({ code: 'invalid', message: expect.stringContaining('format: "gugu-chat"') }));
      }
    }
    // One spelling: an id in capitals is that chat, as the gateway and the folder write it (lower case).
    expect(placeOf({ chat: C1.toUpperCase() })).toEqual({ chat: C1 });
    expect(fileRefOf({ chat: C1.toUpperCase(), name: 'a.md' })).toEqual({ chat: C1, name: 'a.md' });
    expect(fileRefOf({ chat: C1.toUpperCase(), id: 'i-1' })).toEqual({ chat: C1, id: 'i-1' });
  });
});
