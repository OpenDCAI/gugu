// #7199 助理搬家(本机 ⇄ 云上)的编排。纯逻辑:两头的读写、开通 / 接过、重启都由调用方交进来(`MoveDeps`),
// 桌面的真接线在 components/assistant/AssistantMoveGroup,单测用内存盘 + 假两头。
//
// 顺序(owner 10-16 定;controller 补:搬家 = 剪切,账号授权只留一份):
//   搬上云:读旧家(只读:数文件、记已安排、导出账号) → 接过(管家在云上落定,库把 users.device_id 切过去、给旧家发 agent.retire)
//           → 拷文件 → 账号写进新家并核对 → 重排已安排 → 重启 → 撤旧家那份账号。
//   搬回本机:读旧家 → 备好本机的家 → 拷文件 → 账号写进新家 → 接过(客户端 saga,blueprint 带 existing_agent_user_id)
//           → 核对 → 重排已安排 → 重启 → 撤旧家那份账号。
// 不变量:
//   · 旧家的文件一个字节都不动(agent.retire 只停运行时),「清除旧家」是以后一个独立、明确的操作;
//   · 账号授权**先写进新家并读回核对,才撤旧家那一份**;核对不上的那一条不撤(宁可两边都有,❌ 搬丢);
//   · 已安排要在「接过」之前读到手(旧家收到 agent.retire 时会把它们撤掉),并存进日志,中断后接着搬还在;
//   · 日志记着「旧家是哪台」:中断后接着搬时旧家以日志为准,❌ 读此刻「它住哪」(接过之后那是新家 —— 会把新家当旧家去撤账号);
//   · 旧家的助理在搬的这段时间里还在写东西:搬上云是接过之后才拷(旧家已停,数两遍),搬回本机是接过之后再补一遍变了的;
//   · 每一步可重来:拷贝同路径覆盖、账号 upsert、重排按「同一条已在」去重、接过先问「已经在新家了吗」。
import type { IntegrationMoveExport, IntegrationMoveImport, MovableIntegrationAccount, MoveSkipped } from '@shared/core/integrations/integration-move';
import {
  assertPlanFits,
  assertTotalFits,
  copyTree,
  copyUserInstructions,
  diffPlan,
  planTree,
  probeReadable,
  type CopyPlan,
  type HomeFs,
} from './assistant-move-copy';

export type MoveDirection = 'to-cloud' | 'to-computer';

export type MoveStep = 'preflight' | 'adopt' | 'files' | 'accounts' | 'schedules' | 'restart' | 'revoke';

export type MoveSchedule = {
  name: string;
  prompt: string;
  triggerConfig: { expr: string; tz?: string; at?: number };
  enabled: boolean;
};

/** 一个家在哪:云上那台 / 某台电脑(设备 id)。日志里记旧家用。 */
export type MoveHomeRef = { kind: 'cloud' | 'computer'; deviceId: string };

export type MoveSide = {
  /** 日志与报错里这一头叫什么(「这台电脑」/「云上」)。 */
  label: string;
  /** 这一头的设备 id(核对「旧家 ≠ 新家」用);单测里不给 = 不核。 */
  deviceId?: string | null;
  fs: HomeFs;
  /** 这一头「它的家」目录之上已经存在的那一级(拷贝时往下逐层建目录用)。 */
  base: string;
  paths: { instructions: string; memoryDir: string; skillsDir: string; resourcesDir: string };
  integrations: {
    exportForMove(): Promise<IntegrationMoveExport>;
    importFromMove(accounts: MovableIntegrationAccount[]): Promise<IntegrationMoveImport>;
    /** 这一家在这一头此刻存着哪些账号 id(核对用)。 */
    accountIds(integrationId: string): Promise<string[]>;
    disconnect(integrationId: string, accountId: string): Promise<void>;
  };
  schedules: {
    /** 助理在这一头排的「已安排」;`null` = 认不出它在这一头的会话(读不到,❌ 当成「一条都没有」)。 */
    list(): Promise<MoveSchedule[] | null>;
    restore(items: MoveSchedule[]): Promise<{ restored: number; skipped: { name: string; reason: string }[] }>;
  };
};

/** 中断后接着搬要的东西(不含任何凭据):到哪一步、接过之前读到的已安排。 */
export type MoveJournal = {
  direction: MoveDirection;
  assistantId: string;
  startedAt: number;
  /** 已完成的步骤。 */
  done: MoveStep[];
  schedules: MoveSchedule[] | null;
  /** 旧家是哪台(开搬那一刻记下)。没有这一项的日志是老版本留下的,不接着用。 */
  source: MoveHomeRef | null;
};

export type MoveProgress = {
  step: MoveStep;
  /** 拷文件那一步的字节进度。 */
  bytes?: { done: number; total: number };
};

export type MoveReport = {
  files: number;
  /** 没拷的(软链接),逐条回报。 */
  skippedFiles: { rel: string; reason: string }[];
  accounts: {
    moved: { integrationId: string; accountId: string; displayName?: string }[];
    skipped: MoveSkipped[];
    kept: { integrationId: string; accountId: string }[];
    /** 那一头的咕咕比这个功能老(`unknown_method`):账号一个都没动,还在原处。 */
    unsupported: boolean;
  };
  schedules: {
    restored: number;
    skipped: { name: string; reason: string }[];
    /** 新家那一头的咕咕还不认「重排已安排」:这些没排上,逐条给出名字让人告诉它再排。 */
    unsupported: MoveSchedule[];
    /** 旧家那头认不出它的会话,有没有定时任务不知道(没带任何一条):让人去看一眼、需要就告诉它重排。 */
    unreadable: boolean;
  };
  warnings: string[];
};

export interface MoveDeps {
  direction: MoveDirection;
  assistantId: string;
  source: MoveSide;
  /** 旧家是哪台:新开一次搬时记进日志;接着搬时必须与日志里那一份一致。 */
  sourceHome: MoveHomeRef;
  /** 搬回本机时目标那一头在「接过」之前就要备好;搬上云时目标要等管家接过之后才有。 */
  openTarget(): Promise<MoveSide>;
  /** 把助理接到目标上,等到库里落定(users.device_id 已是新家)。 */
  adopt(): Promise<void>;
  /** Apply and verify the original model on the new home, including adoption retries. Failure must not report a completed move. */
  configure?(): Promise<void>;
  /** 已经在新家了吗(中断后接着搬时先问,❌ 再接一次)。 */
  isAdopted(): Promise<boolean>;
  /** 让新家上的助理从头读一遍新拷来的文件(停掉运行时,下条消息再起)。 */
  restart(): Promise<void>;
  journal: { load(): MoveJournal | null; save(journal: MoveJournal): void; clear(): void };
  onProgress?: (progress: MoveProgress) => void;
  now?: () => number;
}

/** 接过被对面明确拒绝(没开始):`adopt()` 抛的错上带 `notStarted: true`,旧家就还是原样。其余失败一律当「可能已经落定」。 */
function isNotStarted(cause: unknown): boolean {
  return (cause as { notStarted?: unknown } | null)?.notStarted === true;
}

/** 那一头的咕咕没有这个动词:远程老 server 回 `unknown_method`,同进程的老接线报「No handler registered for …」。 */
export function isUnknownMethod(error: unknown): boolean {
  if ((error as { code?: unknown } | null)?.code === 'unknown_method') return true;
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /No handler registered for|unknown[ _]method/i.test(message);
}

export class MoveError extends Error {
  constructor(
    readonly step: MoveStep,
    readonly cause: unknown,
    /** 出错时旧家是不是原样的(没接过、没撤任何东西)—— 界面据此说「什么都没变」还是「搬到一半,可以接着搬」。 */
    readonly sourceIntact: boolean
  ) {
    super(`move failed at ${step}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'MoveError';
  }
}

type MovePlan = { trees: { name: 'memory' | 'skills' | 'resources'; from: string; plan: CopyPlan }[]; totalBytes: number };

/** 数一遍旧家有什么(只读),并逐个试读 —— 放不进新家的、读不了的,在接过之前就说。 */
export async function planMove(source: MoveSide): Promise<MovePlan> {
  const trees: { name: 'memory' | 'skills' | 'resources'; from: string; plan: CopyPlan }[] = [];
  const specs: [('memory' | 'skills' | 'resources'), string, string][] = [
    ['memory', source.paths.memoryDir, '记忆'],
    ['skills', source.paths.skillsDir, '技能'],
    ['resources', source.paths.resourcesDir, '给助理的资料'],
  ];
  for (const [name, dir, label] of specs) {
    const plan = await planTree(source.fs, dir);
    assertPlanFits(plan, `${source.label}的${label}`);
    await probeReadable(source.fs, dir, plan);
    trees.push({ name, from: dir, plan });
  }
  const totalBytes = trees.reduce((n, tree) => n + tree.plan.totalBytes, 0);
  assertTotalFits(totalBytes);
  return { trees, totalBytes };
}

export async function runMove(deps: MoveDeps): Promise<MoveReport> {
  const now = deps.now ?? Date.now;
  const report: MoveReport = {
    files: 0,
    skippedFiles: [],
    accounts: { moved: [], skipped: [], kept: [], unsupported: false },
    schedules: { restored: 0, skipped: [], unsupported: [], unreadable: false },
    warnings: [],
  };
  const saved = deps.journal.load();
  // 日志没记旧家是哪台(老版本留下的)= 不接着用:从头来一遍是安全的(拷贝覆盖、账号 upsert、重排去重)。
  const resumed = saved && saved.direction === deps.direction && saved.assistantId === deps.assistantId && saved.source ? saved : null;
  if (resumed?.source && (resumed.source.deviceId !== deps.sourceHome.deviceId || resumed.source.kind !== deps.sourceHome.kind)) {
    throw new MoveError('preflight', new Error('the journal was written for a different source home'), false);
  }
  const journal: MoveJournal = resumed ?? {
    direction: deps.direction,
    assistantId: deps.assistantId,
    startedAt: now(),
    done: [],
    schedules: null,
    source: deps.sourceHome,
  };
  const progress = (step: MoveStep, bytes?: MoveProgress['bytes']) => deps.onProgress?.({ step, bytes });
  const finish = (step: MoveStep) => {
    if (!journal.done.includes(step)) journal.done.push(step);
    deps.journal.save(journal);
  };
  // 「碰过接过」:一旦发出接过(不论后来成没成)旧家就不能再说「原样」—— 超时 / 掉线时那边可能已经落定。
  let adoptTouched = journal.done.includes('adopt');
  const guard = async <T>(step: MoveStep, run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (cause) {
      if (cause instanceof MoveError) throw cause;
      // 旧家只在「接过」那一刻起才算动过(拷文件 / 写新家的账号都只读旧家);撤旧家的账号是最后一步且不会抛。
      throw new MoveError(step, cause, !adoptTouched);
    }
  };
  const ensureAdopted = async () => {
    progress('adopt');
    const before = adoptTouched;
    if (await guard('adopt', () => deps.isAdopted())) {
      adoptTouched = true;
    } else {
      adoptTouched = true;
      try {
        await deps.adopt();
      } catch (cause) {
        // 被明确拒绝(没会员 / 没积分 / 已有一个……)= 什么都没发生;超时 / 掉线这类不知道落没落定,保守当动过。
        if (isNotStarted(cause)) adoptTouched = before;
        throw new MoveError('adopt', cause, !adoptTouched);
      }
    }
    if (deps.configure) await guard('adopt', deps.configure);
    finish('adopt');
  };

  // 1. 读旧家(只读)。已安排要在接过之前读到手;中断后接着搬时旧家的已安排可能已被撤,用日志里存的。
  progress('preflight');
  let plan = await guard('preflight', () => planMove(deps.source));
  // 已经接过之后,旧家的已安排已被撤掉,只能信日志;还没接过就以旧家此刻的为准(上一次读到之后人可能改过)。
  if (journal.schedules === null || !journal.done.includes('adopt')) {
    const listed = await guard('preflight', () => deps.source.schedules.list());
    if (listed !== null) {
      journal.schedules = listed;
    } else if (journal.schedules === null) {
      // 旧家读不出它的会话、日志里也没有:不知道有没有 —— 记一笔,搬完让人知道「已安排没确认」。
      journal.schedules = [];
      report.schedules.unreadable = true;
    }
    deps.journal.save(journal);
  }
  finish('preflight');

  let target: MoveSide | null = null;
  const copyAll = async (to: MoveSide, from: MovePlan, countNew: (tree: string, rel: string) => boolean = () => true) => {
    progress('files', { done: 0, total: from.totalBytes });
    let done = 0;
    const onBytes = (n: number) => {
      done += n;
      progress('files', { done, total: from.totalBytes });
    };
    for (const tree of from.trees) {
      const toRoot = tree.name === 'memory' ? to.paths.memoryDir : tree.name === 'skills' ? to.paths.skillsDir : to.paths.resourcesDir;
      await copyTree({
        from: deps.source.fs,
        fromRoot: tree.from,
        to: to.fs,
        toBase: to.base,
        toRoot,
        plan: tree.plan,
        onBytes,
      });
      report.files += tree.plan.files.filter((file) => countNew(tree.name, file.rel)).length;
    }
    await copyUserInstructions({ from: deps.source.fs, fromPath: deps.source.paths.instructions, to: to.fs, toPath: to.paths.instructions });
  };
  const noteSkipped = (from: MovePlan) => {
    report.skippedFiles = from.trees.flatMap((tree) => tree.plan.skipped.map((s) => ({ rel: `${tree.name}/${s.rel}`, reason: s.reason })));
  };
  /** 新家与旧家不是同一处(日志写错 / 此刻的「住哪」读成了新家的话,下面会把新家的账号当旧家撤掉)。 */
  const assertDistinct = (to: MoveSide) => {
    if (to.deviceId && deps.source.deviceId && to.deviceId === deps.source.deviceId) {
      throw new MoveError('preflight', new Error('the source and the target are the same home'), !adoptTouched);
    }
  };

  // 2. 账号:读旧家的、写进新家、读回核对。撤旧家那一份放在最后(接过 + 重排之后)。
  const verified: MovableIntegrationAccount[] = [];
  const copyAccounts = async (to: MoveSide) => {
    progress('accounts');
    let exported: IntegrationMoveExport;
    let imported: IntegrationMoveImport;
    try {
      exported = await deps.source.integrations.exportForMove();
      report.accounts.skipped.push(...exported.skipped);
      if (exported.accounts.length === 0) return;
      imported = await to.integrations.importFromMove(exported.accounts);
    } catch (cause) {
      // 哪一头的咕咕比这个功能老:账号原样留在原处(还没撤任何一份),如实说,❌ 当成搬家失败回滚整件事。
      if (isUnknownMethod(cause)) {
        report.accounts.unsupported = true;
        return;
      }
      throw cause;
    }
    report.accounts.skipped.push(...imported.skipped);
    const refused = new Set(imported.skipped.map((s) => `${s.integrationId}/${s.accountId ?? ''}`));
    const byIntegration = new Map<string, Set<string>>();
    for (const account of exported.accounts) {
      if (refused.has(`${account.integrationId}/${account.accountId}`)) continue;
      let ids = byIntegration.get(account.integrationId);
      if (!ids) {
        ids = new Set(await to.integrations.accountIds(account.integrationId));
        byIntegration.set(account.integrationId, ids);
      }
      // 写进去了、读得回来才算数:读不回来的这一条不撤旧家那份。
      if (ids.has(account.accountId)) verified.push(account);
      else report.accounts.kept.push({ integrationId: account.integrationId, accountId: account.accountId });
    }
  };

  if (deps.direction === 'to-cloud') {
    // 搬上云:先接过(管家开家、落定;旧家从这一刻起不再有人写),再数一遍、拷 —— 接过之前数的那份只用来在搬之前拦住拷不过去的。
    await ensureAdopted();
    target = await guard('adopt', () => deps.openTarget());
    assertDistinct(target);
    plan = await guard('files', () => planMove(deps.source));
    noteSkipped(plan);
    await guard('files', () => copyAll(target!, plan));
    finish('files');
    await guard('accounts', () => copyAccounts(target!));
    finish('accounts');
  } else {
    // 搬回本机:本机的家先备好、先拷,最后才接过 —— 拷失败时助理还好好地住在云上。
    target = await guard('files', () => deps.openTarget());
    assertDistinct(target);
    noteSkipped(plan);
    await guard('files', () => copyAll(target!, plan));
    finish('files');
    await guard('accounts', () => copyAccounts(target!));
    finish('accounts');
    await ensureAdopted();
    // 接过 = 云上那边停了、不会再写:先前拷的这段时间里它写的 / 改的,补一遍(只补变了的)。
    const after = await guard('files', () => planMove(deps.source));
    const firstRels = new Set(plan.trees.flatMap((tree) => tree.plan.files.map((file) => `${tree.name}/${file.rel}`)));
    const delta: MovePlan = {
      trees: after.trees.map((tree, index) => ({ ...tree, plan: diffPlan(plan.trees[index].plan, tree.plan) })),
      totalBytes: 0,
    };
    delta.totalBytes = delta.trees.reduce((n, tree) => n + tree.plan.totalBytes, 0);
    noteSkipped(after);
    await guard('files', () => copyAll(target!, delta, (name, rel) => !firstRels.has(`${name}/${rel}`)));
  }

  // 3. 重排已安排(接过之后新家才有助理那条会话)。
  progress('schedules');
  if (journal.schedules && journal.schedules.length > 0) {
    try {
      const result = await guard('schedules', () => target!.schedules.restore(journal.schedules!));
      report.schedules = { ...result, unsupported: [], unreadable: report.schedules.unreadable };
    } catch (cause) {
      const original = cause instanceof MoveError ? cause.cause : cause;
      if (!isUnknownMethod(original)) throw cause;
      report.schedules.unsupported = journal.schedules;
    }
  }
  finish('schedules');

  // 4. 重启:让新家上的助理从头读一遍刚拷来的记忆与说明。失败不算搬家失败(下次醒来也会读到),如实记一笔。
  progress('restart');
  try {
    await deps.restart();
    finish('restart');
  } catch (cause) {
    report.warnings.push(`restart: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  // 5. 剪切:新家核对过的账号,把旧家那一份撤掉(owner:有账号的服务只存一份)。撤不掉的如实记下,不当成搬家失败。
  progress('revoke');
  for (const account of verified) {
    try {
      await deps.source.integrations.disconnect(account.integrationId, account.accountId);
      report.accounts.moved.push({ integrationId: account.integrationId, accountId: account.accountId, displayName: account.displayName });
    } catch (cause) {
      report.accounts.kept.push({ integrationId: account.integrationId, accountId: account.accountId });
      report.warnings.push(`revoke ${account.integrationId}/${account.accountId}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }
  finish('revoke');
  deps.journal.clear();
  return report;
}

/** 确认框里列「这次会带走哪些账号」:名字、不含任何密钥;命令行那几家与读不出密钥的另列「要重新连」。 */
export function summarizeAccounts(exported: IntegrationMoveExport): {
  moving: { integrationId: string; accountId: string; displayName?: string }[];
  reconnect: MoveSkipped[];
} {
  return {
    moving: exported.accounts.map(({ integrationId, accountId, displayName }) => ({ integrationId, accountId, displayName })),
    reconnect: exported.skipped,
  };
}
