import { describe, expect, it } from 'vitest';
import type { IntegrationCredentials } from '@gugu/session-plugins/integrations';
import type { MovableIntegrationAccount } from '@shared/core/integrations/integration-move';
import { COPY_MAX_FILE_BYTES, type FsEntry, type HomeFs } from './assistant-move-copy';
import { MoveError, planMove, runMove, summarizeAccounts, type MoveDeps, type MoveJournal, type MoveSchedule, type MoveSide } from './assistant-move';

type Node = { kind: 'dir' } | { kind: 'file'; bytes: Uint8Array } | { kind: 'symlink' };

function disk(initial: Record<string, string | 'dir' | 'symlink'> = {}) {
  const nodes = new Map<string, Node>();
  const log: string[] = [];
  const pending = new Map<string, Uint8Array[]>();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  for (const [path, value] of Object.entries(initial)) {
    nodes.set(path, value === 'dir' ? { kind: 'dir' } : value === 'symlink' ? { kind: 'symlink' } : { kind: 'file', bytes: enc.encode(value) });
  }
  const fs: HomeFs = {
    async list(dir) {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`;
      const out: FsEntry[] = [];
      for (const [path, node] of nodes) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (!rest || rest.includes('/')) continue;
        out.push({ name: rest, type: node.kind === 'dir' ? 'directory' : node.kind === 'file' ? 'file' : 'symlink', size: node.kind === 'file' ? node.bytes.length : 0 });
      }
      return out;
    },
    async readChunk(path, offset, length) {
      const node = nodes.get(path);
      if (node?.kind !== 'file') throw new Error(`no file ${path}`);
      return node.bytes.slice(offset, offset + length);
    },
    async writeChunk({ path, uploadId, data, final, total }) {
      log.push(`write ${path}`);
      const chunks = pending.get(uploadId) ?? [];
      chunks.push(data);
      pending.set(uploadId, chunks);
      if (!final) return null;
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      pending.delete(uploadId);
      if (all.length !== total) throw new Error('size mismatch');
      nodes.set(path, { kind: 'file', bytes: all });
      return { size: all.length };
    },
    async makeDir(parent, name) {
      log.push(`mkdir ${parent}/${name}`);
      if (!nodes.has(parent)) throw new Error(`parent missing: ${parent}`);
      if (!nodes.has(`${parent}/${name}`)) nodes.set(`${parent}/${name}`, { kind: 'dir' });
    },
    async readText(path) {
      const node = nodes.get(path);
      return node?.kind === 'file' ? dec.decode(node.bytes) : null;
    },
    async writeText(path, content) {
      log.push(`writeText ${path}`);
      nodes.set(path, { kind: 'file', bytes: enc.encode(content) });
    },
  };
  const text = (path: string) => {
    const node = nodes.get(path);
    return node?.kind === 'file' ? dec.decode(node.bytes) : null;
  };
  return { fs, nodes, log, text };
}

type Account = { integrationId: string; accountId: string; displayName?: string; credentials: IntegrationCredentials };

function side(opts: {
  label: string;
  files: Record<string, string | 'dir' | 'symlink'>;
  accounts?: Account[];
  cli?: string[];
  schedules?: MoveSchedule[];
  events: string[];
  dropOnImport?: string[];
  memoryDir: string;
  skillsDir: string;
  resourcesDir: string;
  instructions: string;
  base: string;
  deviceId?: string;
}): MoveSide & { d: ReturnType<typeof disk>; stored: Account[]; sched: MoveSchedule[] } {
  const d = disk(opts.files);
  const stored = [...(opts.accounts ?? [])];
  const sched = [...(opts.schedules ?? [])];
  return {
    label: opts.label,
    deviceId: opts.deviceId,
    fs: d.fs,
    base: opts.base,
    paths: { instructions: opts.instructions, memoryDir: opts.memoryDir, skillsDir: opts.skillsDir, resourcesDir: opts.resourcesDir },
    integrations: {
      async exportForMove() {
        opts.events.push(`${opts.label}:export`);
        const skipped = (opts.cli ?? []).map((integrationId) => ({ integrationId, reason: 'cli' as const }));
        return {
          accounts: stored
            .filter((a) => !(opts.cli ?? []).includes(a.integrationId))
            .map((a): MovableIntegrationAccount => ({ ...a, isDefault: true })),
          skipped,
        };
      },
      async importFromMove(accounts) {
        opts.events.push(`${opts.label}:import`);
        for (const a of accounts) {
          // dropOnImport:模拟「写进去了但读不回来」(对面悄悄没落库)。
          if (opts.dropOnImport?.includes(a.accountId)) continue;
          stored.push({ integrationId: a.integrationId, accountId: a.accountId, displayName: a.displayName, credentials: a.credentials });
        }
        return { imported: accounts.length, skipped: [] };
      },
      async accountIds(integrationId) {
        return stored.filter((a) => a.integrationId === integrationId).map((a) => a.accountId);
      },
      async disconnect(integrationId, accountId) {
        opts.events.push(`${opts.label}:disconnect ${integrationId}/${accountId}`);
        const i = stored.findIndex((a) => a.integrationId === integrationId && a.accountId === accountId);
        if (i >= 0) stored.splice(i, 1);
      },
    },
    schedules: {
      async list() {
        opts.events.push(`${opts.label}:schedules.list`);
        return [...sched];
      },
      async restore(items) {
        opts.events.push(`${opts.label}:schedules.restore ${items.length}`);
        sched.push(...items);
        return { restored: items.length, skipped: [] };
      },
    },
    d,
    stored,
    sched,
  };
}

function localSide(events: string[], extra: Partial<Parameters<typeof side>[0]> = {}) {
  return side({
    label: '这台电脑',
    deviceId: 'dev-local',
    events,
    base: '/gh/assistant',
    memoryDir: '/gh/assistant/.claude/memory',
    skillsDir: '/gh/assistant/.claude/skills',
    resourcesDir: '/gh/assistant/给助理的资料',
    instructions: '/gh/assistant/CLAUDE.md',
    files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' },
    ...extra,
  });
}

function cloudSide(events: string[], extra: Partial<Parameters<typeof side>[0]> = {}) {
  return side({
    label: '云上',
    deviceId: 'dev-cloud',
    events,
    base: '/home/u',
    memoryDir: '/home/u/.claude/projects/-home-u-助理/memory',
    skillsDir: '/home/u/.claude/skills',
    resourcesDir: '/home/u/给助理的资料',
    instructions: '/home/u/.claude/CLAUDE.md',
    files: { '/home/u': 'dir' },
    ...extra,
  });
}

const MANAGED = '<!-- 咕咕管家维护这一段,改了会被覆盖;写在这段外面的会保留 -->\n管家段\n<!-- /咕咕管家 -->';
const SCHEDULE: MoveSchedule = { name: '早报', prompt: '读今天的日程发给主人', triggerConfig: { expr: '0 8 * * *', tz: 'Asia/Shanghai' }, enabled: true };

function journalStore(initial: MoveJournal | null = null) {
  let current = initial;
  return {
    load: () => current,
    save: (j: MoveJournal) => {
      current = structuredClone(j);
    },
    clear: () => {
      current = null;
    },
    get current() {
      return current;
    },
  };
}

const LOCAL_HOME = { kind: 'computer', deviceId: 'dev-local' } as const;
const CLOUD_HOME = { kind: 'cloud', deviceId: 'dev-cloud' } as const;

function baseDeps(over: Partial<MoveDeps> & Pick<MoveDeps, 'direction' | 'source' | 'openTarget'>, events: string[]): MoveDeps {
  return {
    assistantId: 'agent-1',
    sourceHome: over.direction === 'to-cloud' ? LOCAL_HOME : CLOUD_HOME,
    adopt: async () => {
      events.push('adopt');
    },
    isAdopted: async () => false,
    restart: async () => {
      events.push('restart');
    },
    journal: journalStore(),
    ...over,
  };
}

describe('助理搬家编排 (#7199)', () => {
  it('verifies the model even when adoption already happened, and never turns that failure into move success', async () => {
    const events: string[] = [];
    const deps = baseDeps({ direction: 'to-cloud', source: localSide(events), openTarget: async () => cloudSide(events),
      isAdopted: async () => true, configure: async () => { events.push('model'); throw new Error('model not applied'); } }, events);
    await expect(runMove(deps)).rejects.toMatchObject({ step: 'adopt', sourceIntact: false });
    expect(events).toContain('model');
    expect(events).not.toContain('restart');
    expect(deps.journal.load()?.done).not.toContain('adopt');
  });
  it('本机→云上:先接过再拷;新家账号读回核对后才撤旧家那份;已安排用接过之前读到的', async () => {
    const events: string[] = [];
    const local = localSide(events, {
      files: {
        '/gh/assistant': 'dir',
        '/gh/assistant/.claude': 'dir',
        '/gh/assistant/.claude/memory': 'dir',
        '/gh/assistant/.claude/memory/owner-profile.md': '主人叫阿满',
        '/gh/assistant/CLAUDE.md': `${MANAGED}\n\n说话简短。\n`,
      },
      accounts: [{ integrationId: 'notion', accountId: 'default', displayName: '阿满的 Notion', credentials: { accessToken: 't' } }],
      schedules: [SCHEDULE],
    });
    const cloud = cloudSide(events, { files: { '/home/u': 'dir', '/home/u/.claude': 'dir', '/home/u/.claude/CLAUDE.md': `${MANAGED.replace('管家段', '云上管家段')}\n` } });
    const sourceBefore = [...local.d.nodes.keys()].sort();
    const deps = baseDeps(
      {
        direction: 'to-cloud',
        source: local,
        // 接过 = 旧家那条会话与已安排被 agent.retire 撤掉(只剩文件)
        adopt: async () => {
          events.push('adopt');
          local.sched.length = 0;
        },
        openTarget: async () => {
          events.push('openTarget');
          return cloud;
        },
      },
      events
    );

    const report = await runMove(deps);

    expect(events.indexOf('adopt')).toBeGreaterThan(events.indexOf('这台电脑:schedules.list'));
    expect(events.indexOf('云上:import')).toBeGreaterThan(events.indexOf('adopt'));
    expect(events.indexOf('这台电脑:disconnect notion/default')).toBeGreaterThan(events.indexOf('云上:import'));
    expect(events.indexOf('这台电脑:disconnect notion/default')).toBeGreaterThan(events.indexOf('restart'));
    expect(cloud.stored.map((a) => a.accountId)).toEqual(['default']);
    expect(local.stored).toEqual([]);
    expect(cloud.sched).toEqual([SCHEDULE]);
    expect(report.accounts.moved).toEqual([{ integrationId: 'notion', accountId: 'default', displayName: '阿满的 Notion' }]);
    expect(report.schedules.restored).toBe(1);
    expect(cloud.d.text('/home/u/.claude/projects/-home-u-助理/memory/owner-profile.md')).toBe('主人叫阿满');
    const instructions = cloud.d.text('/home/u/.claude/CLAUDE.md') ?? '';
    expect(instructions).toContain('云上管家段');
    expect(instructions).toContain('说话简短。');
    // 旧家文件一个字节都没动
    expect([...local.d.nodes.keys()].sort()).toEqual(sourceBefore);
    expect(local.d.log).toEqual([]);
  });

  it('云上→本机:先拷、最后才接过;接过失败时旧家(云上)原样,账号一份没撤', async () => {
    const events: string[] = [];
    const cloud = cloudSide(events, {
      files: { '/home/u': 'dir', '/home/u/.claude': 'dir', '/home/u/.claude/projects': 'dir', '/home/u/.claude/projects/-home-u-助理': 'dir', '/home/u/.claude/projects/-home-u-助理/memory': 'dir', '/home/u/.claude/projects/-home-u-助理/memory/a.md': '记一笔' },
      accounts: [{ integrationId: 'feishu', accountId: 'f1', credentials: { t: 1 } }],
    });
    const local = localSide(events, { files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' } });
    const deps = baseDeps(
      {
        direction: 'to-computer',
        source: cloud,
        openTarget: async () => local,
        adopt: async () => {
          events.push('adopt');
          throw new Error('device offline');
        },
      },
      events
    );

    const failure = await runMove(deps).catch((e) => e);

    expect(failure).toBeInstanceOf(MoveError);
    expect((failure as MoveError).step).toBe('adopt');
    // 掉线 / 超时这类不知道对面落没落定:保守说「动过」(可接着搬),❌ 说「什么都没变」
    expect((failure as MoveError).sourceIntact).toBe(false);
    expect(events.indexOf('adopt')).toBeGreaterThan(events.indexOf('这台电脑:import'));
    expect(cloud.stored.map((a) => a.accountId)).toEqual(['f1']);
    expect(events.some((e) => e.includes('disconnect'))).toBe(false);
    expect(cloud.d.log).toEqual([]);
    expect(local.d.text('/gh/assistant/.claude/memory/a.md')).toBe('记一笔');
  });

  it('核对:写进新家却读不回来的账号不撤旧家那份,并记在 kept', async () => {
    const events: string[] = [];
    const local = localSide(events, {
      files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' },
      accounts: [
        { integrationId: 'notion', accountId: 'n1', credentials: { t: 1 } },
        { integrationId: 'feishu', accountId: 'f1', credentials: { t: 2 } },
      ],
    });
    const cloud = cloudSide(events, { dropOnImport: ['f1'] });
    const report = await runMove(baseDeps({ direction: 'to-cloud', source: local, openTarget: async () => cloud }, events));

    expect(report.accounts.moved.map((a) => a.accountId)).toEqual(['n1']);
    expect(report.accounts.kept).toEqual([{ integrationId: 'feishu', accountId: 'f1' }]);
    expect(local.stored.map((a) => a.accountId)).toEqual(['f1']);
  });

  it('命令行那几家不带走也不撤,列进 skipped(搬完在新家重新连)', async () => {
    const events: string[] = [];
    const local = localSide(events, {
      files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' },
      accounts: [{ integrationId: 'dingtalk', accountId: 'default', credentials: { tool: 'dws' } }],
      cli: ['dingtalk'],
    });
    const report = await runMove(baseDeps({ direction: 'to-cloud', source: local, openTarget: async () => cloudSide(events) }, events));
    expect(report.accounts.skipped).toEqual([{ integrationId: 'dingtalk', reason: 'cli' }]);
    expect(local.stored).toHaveLength(1);
  });

  it('中断后接着搬:日志里的已安排还在、已经接过就不再接', async () => {
    const events: string[] = [];
    const local = localSide(events, { files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' }, schedules: [] });
    const cloud = cloudSide(events);
    const journal = journalStore({ direction: 'to-cloud', assistantId: 'agent-1', startedAt: 1, done: ['preflight', 'adopt'], schedules: [SCHEDULE], source: LOCAL_HOME });
    const report = await runMove(
      baseDeps({ direction: 'to-cloud', source: local, openTarget: async () => cloud, isAdopted: async () => true, journal }, events)
    );
    expect(events).not.toContain('adopt');
    expect(cloud.sched).toEqual([SCHEDULE]);
    expect(report.schedules.restored).toBe(1);
    expect(journal.current).toBeNull();
  });

  it('搬之前就拦:资料里有放不进新家的大文件 → preflight 失败,没接过、没动任何一头', async () => {
    const events: string[] = [];
    const local = localSide(events, { files: { '/gh/assistant': 'dir', '/gh/assistant/给助理的资料': 'dir', '/gh/assistant/给助理的资料/big.bin': 'x' } });
    // 把那一条的登记大小改成越界(磁盘里放不下真 100MB)
    const realList = local.fs.list;
    local.fs.list = async (dir) => (await realList(dir)).map((e) => (e.name === 'big.bin' ? { ...e, size: COPY_MAX_FILE_BYTES + 1 } : e));
    const failure = await runMove(baseDeps({ direction: 'to-cloud', source: local, openTarget: async () => cloudSide(events) }, events)).catch((e) => e);
    expect(failure).toBeInstanceOf(MoveError);
    expect((failure as MoveError).step).toBe('preflight');
    expect((failure as MoveError).sourceIntact).toBe(true);
    expect(events).not.toContain('adopt');
  });

  it('重启没成不算搬家失败,记一笔 warning;之后账号照常剪切', async () => {
    const events: string[] = [];
    const local = localSide(events, {
      files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' },
      accounts: [{ integrationId: 'notion', accountId: 'default', credentials: { t: 1 } }],
    });
    const report = await runMove(
      baseDeps(
        {
          direction: 'to-cloud',
          source: local,
          openTarget: async () => cloudSide(events),
          restart: async () => {
            throw new Error('device busy');
          },
        },
        events
      )
    );
    expect(report.warnings).toEqual(['restart: device busy']);
    expect(local.stored).toEqual([]);
  });

  it('云上那版咕咕还不认搬账号 / 重排:不当失败、不撤任何账号,如实回报(已安排逐条列出)', async () => {
    const events: string[] = [];
    const local = localSide(events, {
      files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' },
      accounts: [{ integrationId: 'notion', accountId: 'default', credentials: { t: 1 } }],
      schedules: [SCHEDULE],
    });
    const cloud = cloudSide(events);
    const tooOld = Object.assign(new Error('unknown method'), { code: 'unknown_method' });
    cloud.integrations.importFromMove = async () => {
      throw tooOld;
    };
    cloud.schedules.restore = async () => {
      throw tooOld;
    };
    const report = await runMove(baseDeps({ direction: 'to-cloud', source: local, openTarget: async () => cloud }, events));

    expect(report.accounts.unsupported).toBe(true);
    expect(report.accounts.moved).toEqual([]);
    expect(local.stored).toHaveLength(1);
    expect(report.schedules.unsupported).toEqual([SCHEDULE]);
    expect(events).toContain('restart');
  });

  it('别的错照常当失败抛(不被 unknown_method 的兜底吞掉)', async () => {
    const events: string[] = [];
    const local = localSide(events, {
      files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' },
      accounts: [{ integrationId: 'notion', accountId: 'default', credentials: { t: 1 } }],
    });
    const cloud = cloudSide(events);
    cloud.integrations.importFromMove = async () => {
      throw new Error('disk full');
    };
    const failure = await runMove(baseDeps({ direction: 'to-cloud', source: local, openTarget: async () => cloud }, events)).catch((e) => e);
    expect(failure).toBeInstanceOf(MoveError);
    expect((failure as MoveError).step).toBe('accounts');
    expect(local.stored).toHaveLength(1);
  });

  it('接过被对面明确拒绝(没会员 / 没积分):旧家原样,界面可以说「什么都没变」', async () => {
    const events: string[] = [];
    const local = localSide(events, { files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' } });
    const refusal = Object.assign(new Error('plan_required'), { notStarted: true });
    const failure = await runMove(
      baseDeps(
        {
          direction: 'to-cloud',
          source: local,
          openTarget: async () => cloudSide(events),
          adopt: async () => {
            throw refusal;
          },
        },
        events
      )
    ).catch((e) => e);
    expect((failure as MoveError).step).toBe('adopt');
    expect((failure as MoveError).sourceIntact).toBe(true);
    expect((failure as MoveError).cause).toBe(refusal);
  });

  it('接着搬以日志里记的旧家为准:此刻读到的「旧家」与日志不一致 → 在碰任何东西之前就拦', async () => {
    const events: string[] = [];
    const local = localSide(events, { files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' } });
    const journal = journalStore({ direction: 'to-cloud', assistantId: 'agent-1', startedAt: 1, done: ['preflight'], schedules: [], source: CLOUD_HOME });
    const failure = await runMove(
      baseDeps({ direction: 'to-cloud', source: local, sourceHome: LOCAL_HOME, openTarget: async () => cloudSide(events), journal }, events)
    ).catch((e) => e);
    expect(failure).toBeInstanceOf(MoveError);
    expect((failure as MoveError).step).toBe('preflight');
    expect(events).toEqual([]);
  });

  it('旧家与新家是同一处(接过之后把新家当旧家读了):拦下,不撤任何账号', async () => {
    const events: string[] = [];
    const cloud = cloudSide(events, { accounts: [{ integrationId: 'notion', accountId: 'default', credentials: { t: 1 } }] });
    const failure = await runMove(
      baseDeps({ direction: 'to-cloud', source: cloud, sourceHome: CLOUD_HOME, openTarget: async () => cloudSide(events) }, events)
    ).catch((e) => e);
    expect(failure).toBeInstanceOf(MoveError);
    expect(events.some((e) => e.includes('disconnect'))).toBe(false);
    expect(cloud.stored).toHaveLength(1);
  });

  it('日志没记旧家(老版本留下的):不接着用,从头来,已安排以旧家此刻为准', async () => {
    const events: string[] = [];
    const local = localSide(events, { files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' }, schedules: [SCHEDULE] });
    const cloud = cloudSide(events);
    const legacy = { direction: 'to-cloud', assistantId: 'agent-1', startedAt: 1, done: ['preflight', 'adopt'], schedules: [], source: null } as MoveJournal;
    const report = await runMove(baseDeps({ direction: 'to-cloud', source: local, openTarget: async () => cloud, journal: journalStore(legacy) }, events));
    expect(events).toContain('adopt');
    expect(report.schedules.restored).toBe(1);
  });

  it('还没接过时,已安排以旧家此刻的为准(上一次读到之后人可能改过);接过之后才信日志', async () => {
    const events: string[] = [];
    const stale: MoveSchedule = { ...SCHEDULE, name: '旧的' };
    const fresh: MoveSchedule = { ...SCHEDULE, name: '新的' };
    const local = localSide(events, { files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' }, schedules: [fresh] });
    const cloud = cloudSide(events);
    const journal = journalStore({ direction: 'to-cloud', assistantId: 'agent-1', startedAt: 1, done: ['preflight'], schedules: [stale], source: LOCAL_HOME });
    await runMove(baseDeps({ direction: 'to-cloud', source: local, openTarget: async () => cloud, journal }, events));
    expect(cloud.sched.map((s) => s.name)).toEqual(['新的']);
  });

  it('搬上云:接过之后才数一遍再拷 —— 接过之前数过之后旧家里新写的文件也带上', async () => {
    const events: string[] = [];
    const local = localSide(events, {
      files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir', '/gh/assistant/.claude/memory': 'dir', '/gh/assistant/.claude/memory/a.md': '一' },
    });
    const cloud = cloudSide(events);
    const report = await runMove(
      baseDeps(
        {
          direction: 'to-cloud',
          source: local,
          openTarget: async () => cloud,
          // 预检数过之后、接过的这段时间里,助理又记了一条
          adopt: async () => {
            events.push('adopt');
            local.d.nodes.set('/gh/assistant/.claude/memory/b.md', { kind: 'file', bytes: new TextEncoder().encode('二') });
          },
        },
        events
      )
    );
    expect(cloud.d.text('/home/u/.claude/projects/-home-u-助理/memory/a.md')).toBe('一');
    expect(cloud.d.text('/home/u/.claude/projects/-home-u-助理/memory/b.md')).toBe('二');
    expect(report.files).toBe(2);
  });

  it('搬回本机:接过之后补一遍 —— 拷的这段时间里云上助理写的 / 改的,新家也要有', async () => {
    const events: string[] = [];
    const cloud = cloudSide(events, {
      files: {
        '/home/u': 'dir',
        '/home/u/.claude': 'dir',
        '/home/u/.claude/projects': 'dir',
        '/home/u/.claude/projects/-home-u-助理': 'dir',
        '/home/u/.claude/projects/-home-u-助理/memory': 'dir',
        '/home/u/.claude/projects/-home-u-助理/memory/a.md': '一',
      },
    });
    const local = localSide(events, { files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' } });
    const mem = '/home/u/.claude/projects/-home-u-助理/memory';
    const report = await runMove(
      baseDeps(
        {
          direction: 'to-computer',
          source: cloud,
          openTarget: async () => local,
          adopt: async () => {
            events.push('adopt');
            // 第一遍拷完之后、接过(云上助理被停)之前,它又改了 a.md(变长)、新记了 c.md
            cloud.d.nodes.set(`${mem}/a.md`, { kind: 'file', bytes: new TextEncoder().encode('一加一点') });
            cloud.d.nodes.set(`${mem}/c.md`, { kind: 'file', bytes: new TextEncoder().encode('三') });
          },
        },
        events
      )
    );
    expect(local.d.text('/gh/assistant/.claude/memory/a.md')).toBe('一加一点');
    expect(local.d.text('/gh/assistant/.claude/memory/c.md')).toBe('三');
    // 数文件个数:a 第一遍已算,补的只多出 c
    expect(report.files).toBe(2);
  });

  it('总量按几棵树加起来算:单棵不超、合起来超了也在搬之前拦', async () => {
    const events: string[] = [];
    const local = localSide(events, { files: { '/gh/assistant': 'dir' } });
    // 记忆、资料各 5 个 60MB = 每棵 300MB(单棵不到 512MB),合起来 600MB
    const big = (dir: string): FsEntry[] =>
      dir.endsWith('/.claude/memory') || dir.endsWith('/给助理的资料')
        ? Array.from({ length: 5 }, (_, i) => ({ name: `${i}.bin`, type: 'file' as const, size: 60 * 1024 * 1024 }))
        : [];
    local.fs.list = async (dir) => big(dir);
    local.fs.readChunk = async () => new Uint8Array(1);
    await expect(planMove(local)).rejects.toMatchObject({ code: 'too_large' });
  });

  it('搬之前逐个试读:读不了的文件(指向别处的软链接)在接过之前就拦', async () => {
    const events: string[] = [];
    const local = localSide(events, {
      files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir', '/gh/assistant/.claude/memory': 'dir', '/gh/assistant/.claude/memory/link.md': 'x' },
    });
    const realRead = local.fs.readChunk;
    local.fs.readChunk = async (path, offset, length) => {
      if (path.endsWith('link.md')) throw new Error('path escapes the workspace');
      return realRead(path, offset, length);
    };
    const failure = await runMove(baseDeps({ direction: 'to-cloud', source: local, openTarget: async () => cloudSide(events) }, events)).catch((e) => e);
    expect(failure).toBeInstanceOf(MoveError);
    expect((failure as MoveError).step).toBe('preflight');
    expect((failure as MoveError).sourceIntact).toBe(true);
    expect(((failure as MoveError).cause as { code?: string }).code).toBe('unreadable');
    expect(events).not.toContain('adopt');
  });

  it('认不出旧家那一头它的会话时:不当成「一条都没有」—— 用日志里的那份;日志也没有就如实标 unreadable', async () => {
    const events: string[] = [];
    const local = localSide(events, { files: { '/gh/assistant': 'dir', '/gh/assistant/.claude': 'dir' } });
    local.schedules.list = async () => null;
    const withSaved = journalStore({ direction: 'to-cloud', assistantId: 'agent-1', startedAt: 1, done: ['preflight'], schedules: [SCHEDULE], source: LOCAL_HOME });
    const cloud1 = cloudSide(events);
    const r1 = await runMove(baseDeps({ direction: 'to-cloud', source: local, openTarget: async () => cloud1, journal: withSaved }, events));
    expect(cloud1.sched).toEqual([SCHEDULE]);
    expect(r1.schedules.unreadable).toBe(false);

    const cloud2 = cloudSide(events);
    const r2 = await runMove(baseDeps({ direction: 'to-cloud', source: local, openTarget: async () => cloud2 }, events));
    expect(cloud2.sched).toEqual([]);
    expect(r2.schedules.unreadable).toBe(true);
  });

  it('确认框清单:只含名字,不含任何凭据字段', () => {
    const summary = summarizeAccounts({
      accounts: [{ integrationId: 'notion', accountId: 'default', displayName: '阿满的 Notion', isDefault: true, credentials: { accessToken: 'SECRET' } }],
      skipped: [{ integrationId: 'dingtalk', reason: 'cli' }],
    });
    expect(JSON.stringify(summary)).not.toContain('SECRET');
    expect(summary.moving).toEqual([{ integrationId: 'notion', accountId: 'default', displayName: '阿满的 Notion' }]);
    expect(summary.reconnect).toEqual([{ integrationId: 'dingtalk', reason: 'cli' }]);
  });
});
