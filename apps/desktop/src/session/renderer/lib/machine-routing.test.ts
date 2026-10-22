import { describe, expect, it } from 'vitest';
import {
  MachineRegistry,
  MachineRoutingConflictError,
  aliasFixedId,
  collectEntityIds,
  machineIdCodec,
  machineOfChannel,
} from './machine-routing';

const P = '11111111-aaaa-4bbb-8ccc-000000000001';
const C = '33333333-aaaa-4bbb-8ccc-000000000003';
const LOCAL_P = '99999999-aaaa-4bbb-8ccc-000000000009';

function registry() {
  const r = new MachineRegistry();
  r.register('dev-a', [P]);
  return r;
}

describe('machine routing (one workbench seam)', () => {
  it('routes by a registered project id in any argument position', () => {
    const r = registry();
    expect(r.route('sessions.getSessions', [P])).toBe('dev-a');
    expect(r.route('sessionCreate.createSession', [{ projectId: P, name: 'x' }])).toBe('dev-a');
    expect(r.route('workspace.files.readFile', [P, 'ws', 'src/a.ts'])).toBe('dev-a');
  });

  it('routes pty session ids by their project prefix', () => {
    const r = registry();
    expect(r.route('pty.sendInput', [`${P}:${C}:${C}`, 'ls\r'])).toBe('dev-a');
  });

  it('routes pty session ids of the hidden task workspace (aliased fixed id, the longest ids we route)', () => {
    const r = new MachineRegistry([LOCAL_P]);
    const device = '421d53a0-ebda-40e0-859c-0d6ef8a0c05e';
    const sid = `${aliasFixedId(LOCAL_P, device)}:${C}:${C}`;
    expect(sid.length).toBeGreaterThan(128);
    expect(r.route('pty.subscribe', [sid])).toBe(device);
    expect(machineIdCodec(device, [LOCAL_P]).outbound([sid])).toEqual([`${LOCAL_P}:${C}:${C}`]);
  });

  it('stays local for unknown ids and for local-only namespaces', () => {
    const r = registry();
    expect(r.route('sessions.getSessions', [LOCAL_P])).toBeNull();
    expect(r.route('projects.getProjects', [])).toBeNull();
    expect(r.route('viewState.save', [`session:${P}`, { projectId: P }])).toBeNull();
    expect(r.route('app.openExternal', [P])).toBeNull();
    expect(r.route('browser.setActiveBrowser', [P])).toBeNull();
  });

  it('keeps the gugu-preview:// registrations on this computer even with a machine project id', () => {
    const r = registry();
    // 登记表在看界面的这台电脑的主进程里;字节另经 readChunk 去那台机器取(那一条照常路由)。
    expect(r.route('workspace.files.createDocumentPreview', [P])).toBeNull();
    expect(r.route('workspace.files.createRemotePreview', [{ projectId: P, workspaceId: 'ws', root: '/srv/a' }])).toBeNull();
    expect(r.route('workspace.files.setPreviewDocument', [P, 'ws', 'index.html'])).toBeNull();
    expect(r.route('workspace.files.releasePreview', [P, 'ws'])).toBeNull();
    expect(r.route('workspace.files.readChunk', [P, 'ws', { path: 'a', offset: 0, length: 1 }])).toBe('dev-a');
  });

  it('keeps the on-screen report on this computer, whichever machines the sessions on screen are on', () => {
    const r = registry();
    r.register('dev-b', [C]);
    // 屏上同时摆着两台机器上的会话:报给的是这台电脑自己的闲置回收,❌ 发去那台机器、❌ 当成「指向几台机器」报错。
    expect(r.route('sessions.reportSessionsOnScreen', [[P, C, LOCAL_P]])).toBeNull();
  });

  it('learns session ids from what the machine returns', () => {
    const r = registry();
    r.absorb('dev-a', [{ id: C, projectId: P, title: 'c' }]);
    expect(r.machineOf(C)).toBe('dev-a');
    expect(r.route('sessions.setSessionPinned', [C, true])).toBe('dev-a');
    expect(r.route('sessions.markSessionSeen', [C])).toBe('dev-a');
  });

  it('does not take ids of objects that are not session-page entities', () => {
    const ids: string[] = [];
    collectEntityIds(
      { id: 'agent-user-0000001', guguUserId: 'user-00000001', nested: { userId: 'x-00000001' } },
      ids
    );
    expect(ids).toEqual([]);
  });

  it('refuses a call whose arguments point at two machines', () => {
    const r = registry();
    r.register('dev-b', [LOCAL_P]);
    expect(() => r.route('tasks.x', [P, LOCAL_P])).toThrow(MachineRoutingConflictError);
  });

  it('forgets a removed machine', () => {
    const r = registry();
    r.forgetMachine('dev-a');
    expect(r.route('sessions.getSessions', [P])).toBeNull();
  });

  it('renames the fixed task-home id at the machine boundary, both ways', () => {
    const FIXED = '00000000-0000-4000-8000-000000000001';
    const codec = machineIdCodec('dev-a', [FIXED]);
    const alias = aliasFixedId(FIXED, 'dev-a');
    const incoming = codec.inbound([{ id: FIXED, name: 'home' }, { projectId: FIXED, sessionId: C }, `${FIXED}:${C}:${C}`]);
    expect(incoming).toEqual([{ id: alias, name: 'home' }, { projectId: alias, sessionId: C }, `${alias}:${C}:${C}`]);
    expect(codec.outbound(incoming)).toEqual([{ id: FIXED, name: 'home' }, { projectId: FIXED, sessionId: C }, `${FIXED}:${C}:${C}`]);
    expect(codec.outboundChannel(`pty:data.${alias}:${C}:${C}`)).toBe(`pty:data.${FIXED}:${C}:${C}`);
    const untouched = { a: 'b' };
    expect(codec.inbound(untouched)).toBe(untouched);

    const r = new MachineRegistry([FIXED]);
    r.register('dev-a', [FIXED]);
    expect(r.route('tasks.getTasks', [FIXED])).toBeNull();
    expect(r.route('tasks.getTasks', [alias])).toBe('dev-a');
    expect(r.route('pty.resize', [`${alias}:${C}:${C}`, 80, 24])).toBe('dev-a');
  });

  it('finds the machine of an event subscription from the joined channel (the bus never passes the topic alone)', () => {
    const FIXED = '00000000-0000-4000-8000-000000000001';
    const r = new MachineRegistry([FIXED]);
    r.register('dev-a', [P]);
    const alias = aliasFixedId(FIXED, 'dev-b');
    expect(machineOfChannel(r, `pty:data.${P}:${C}:${C}`)).toBe('dev-a');
    // 隐藏任务工作区:只认得出别名 —— 订到那台机器上时频道要换回固定 id(codec.outboundChannel)。
    expect(machineOfChannel(r, `pty:data.${alias}:${C}:${C}`)).toBe('dev-b');
    expect(machineOfChannel(r, `pty:data.${FIXED}:${C}:${C}`)).toBeNull();
    expect(machineOfChannel(r, 'pty:data')).toBeNull();
    expect(machineOfChannel(r, 'taskhost.pane.open')).toBeNull();
  });
});
