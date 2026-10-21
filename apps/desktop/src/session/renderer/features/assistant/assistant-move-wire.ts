// #7199 助理搬家的真接线:把 assistant-move.ts 的编排接到真机器上 —— 两头的文件读写走 workspace.files.*(与助理 App
// 读写它的家同一组动词)、账号与已安排走 integrations.* / automations.*、接过走管家 /provision 或客户端 saga。
// 界面在 components/assistant/AssistantMoveGroup;这里没有任何 React。
import type { MovableIntegrationAccount } from '@shared/core/integrations/integration-move';
import { WORKSPACE_WRITE_FORCE } from '@gugu/session-core/session-record/contract';
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract';
import { CloudComputerError } from '@gugu/core/cloud/cloudComputer';
import { readDisplayIdentities } from '@/lib/identityReadAdapter';
import { assistantResumeStore } from '@/lib/assistantSetup';
import { ASSISTANT_HOME_CHANNELS, type PrepareLocalHomeResult } from '@/lib/assistantHomeIpc';
import { completedSingleProvisionSession, provisionSingleAgent } from '@/lib/agentProvision';
import { readAgentModelSelection, setAgentModelSelection, platformProtocolForAgentType } from '@/lib/agentModelSelection';
import type { AgentModelSelection } from '@gugu/core/shared/agentModelSelection';
import { cloudMoveModel, moveModelSelection, sameMoveModel } from './assistant-move-model';
import { getCloudComputerState, provisionCloudComputer, refreshCloudComputer, wakeCloudComputer } from '@/lib/cloudComputerStore';
import { contactsService } from '@/lib/contacts';
import { reloadMyAssistant } from '@/lib/myAssistant';
import { desktopIpc } from '@/platform/desktopIpc';
import type { AssistantHomePlace } from '@/lib/assistantHome';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { rpcOn } from '@renderer/lib/ipc';
import { appState } from '@renderer/lib/stores/app-state';
import { isAssistantSession } from './assistant-lineage';
import { AssistantFileError, listDirectory, makeFolder, readText, writeText, type AssistantMachine } from './assistant-machine-core';
import { homeTarget } from './assistant-home-sessions';
import { rendererLogger } from '@/lib/log';
import { openAssistantMachine } from './assistant-machine';
import type { HomeFs } from './assistant-move-copy';
import {
  isUnknownMethod,
  planMove,
  runMove,
  type MoveDeps,
  type MoveDirection,
  type MoveHomeRef,
  type MoveJournal,
  type MoveReport,
  type MoveSchedule,
  type MoveSide,
} from './assistant-move';

export type MoveEnv = {
  ownerUserId: string;
  assistantId: string;
  assistantName: string;
  /** 这台电脑在设备表里的 id(搬回本机的目的地)。 */
  localDeviceId: string;
  /** 它此刻住的地方。 */
  home: AssistantHomePlace;
};

/** 管家在动手之前就拒绝的几个码:接过根本没开始。 */
const REFUSED_BEFORE_START: ReadonlySet<string> = new Set(['plan_required', 'credits_exhausted', 'already_exists', 'already_there', 'agent_type_unsupported']);

const wireLog = rendererLogger('assistant/move-wire');

const POLL_MS = 3_000;
/** 管家开家 + 在上面把它接过来:实测约 2 分钟(开通那一条),留足。 */
const ADOPT_TIMEOUT_MS = 8 * 60_000;
const SESSION_WAIT_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false>): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(POLL_MS);
  }
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function rpcError(error: { type?: string; message?: string }): AssistantFileError {
  return new AssistantFileError(error.type ?? 'fs_error', error.message ?? error.type ?? 'failed');
}

/** 一台机器上它的家(工作区)→ 拷贝引擎要的读写面。 */
/** 目录项的修改时刻(毫秒;Date / ISO 串 / 数都可能,读不到 = null)。 */
function mtimeOf(entry: { modifiedAt?: unknown }): number | null {
  const value = entry.modifiedAt;
  const ms = value instanceof Date ? value.getTime() : typeof value === 'string' ? Date.parse(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(ms) ? ms : null;
}

export function machineFs(machine: AssistantMachine): HomeFs {
  const files = machine.rpc.workspace.files;
  return {
    async list(dir) {
      return (await listDirectory(machine, dir)).map((entry) => ({ name: entry.name, type: entry.type, size: entry.size, mtime: mtimeOf(entry) }));
    },
    async readChunk(path, offset, length) {
      if (length === 0) return new Uint8Array(0);
      const result = await files.readChunk(machine.projectId, machine.workspaceId, { path, offset, length });
      if (!result.success) throw rpcError(result.error as { type?: string; message?: string });
      return fromBase64(result.data.data);
    },
    async writeChunk({ path, uploadId, offset, data, total, final }) {
      const result = await files.writeChunk(machine.projectId, machine.workspaceId, {
        path,
        uploadId,
        offset,
        data: toBase64(data),
        total,
        final,
        expectedEtag: WORKSPACE_WRITE_FORCE,
      });
      if (!result.success) throw rpcError(result.error as { type?: string; message?: string });
      return result.data.committed ? { size: result.data.committed.size } : null;
    },
    async makeDir(parent, name) {
      await makeFolder(machine, parent, name);
    },
    readText: (path) => readText(machine, path),
    writeText: (path, content) => writeText(machine, path, content),
  };
}

async function sessionsOn(target: string | null): Promise<readonly SessionpageSessionSummary[]> {
  const result = await rpcOn(target).sessionTimeline.sessionsList();
  return result.sessions;
}

/** 助理在那台机器上的会话(新家刚接过来时要等它出现)。 */
async function assistantSessionOn(target: string | null, assistantId: string, waitMs: number): Promise<SessionpageSessionSummary> {
  return until('the assistant session on the new home', waitMs, async () =>
    (await sessionsOn(target)).find((session) => isAssistantSession(session, assistantId))
  );
}

/**
 * `base` = 这一头「它的家」目录之上已经存在的那一级,拷贝往下逐层建目录:云上是主目录(整台都是它的家,工作区就是主目录项目),
 * 本机是它的工作目录(它的一切都在这一个目录里;工作区只圈这一个目录,往上建会被拦)。
 */
function sideOf(machine: AssistantMachine, label: string, assistantId: string, base: string, deviceId: string): MoveSide {
  const target = machine.target === undefined ? machine.deviceId : machine.target;
  return {
    label,
    deviceId,
    fs: machineFs(machine),
    base,
    paths: {
      instructions: machine.paths.instructions,
      memoryDir: machine.paths.memoryDir,
      skillsDir: machine.paths.skillsDir,
      resourcesDir: machine.paths.resourcesDir,
    },
    integrations: {
      exportForMove: () => rpcOn(target).integrations.exportForMove(),
      importFromMove: (accounts: MovableIntegrationAccount[]) => rpcOn(target).integrations.importFromMove(accounts),
      accountIds: async (integrationId) => (await rpcOn(target).integrations.accounts(integrationId)).map((account) => account.accountId),
      disconnect: async (integrationId, accountId) => {
        // 断开失败是 `{ success:false }`(不抛):不查就会把「没撤掉」报成「撤掉了」,旧家那份还在、界面却说只剩一份。
        const result = await rpcOn(target).integrations.disconnect(integrationId, accountId);
        if (!result?.success) throw new Error(result?.error ?? 'disconnect failed');
      },
    },
    schedules: {
      async list() {
        const sessions = await sessionsOn(target);
        const own = sessions.find((session) => isAssistantSession(session, assistantId));
        if (!own) {
          // 认不出它在这一头的会话(没起过 / 已经被拆):❌ 当成「没有已安排」—— 返回 null,由编排用日志里的那份。
          wireLog.warn({ label, target: target ?? 'local', sessions: sessions.length }, 'assistant session not found; schedules unreadable');
          return null;
        }
        const all = await rpcOn(target).automations.listAutomations();
        wireLog.info({ label, own: own.conversationId, automations: all.length }, 'schedules listed for move');
        return all
          .filter((automation) => automation.agentSessionId === own.conversationId && automation.triggerConfig && automation.agentConfig)
          .map(
            (automation): MoveSchedule => ({
              name: automation.name,
              prompt: automation.agentConfig!.prompt,
              triggerConfig: automation.triggerConfig!,
              enabled: automation.enabled,
            })
          );
      },
      async restore(items) {
        const own = await assistantSessionOn(target, assistantId, SESSION_WAIT_MS);
        return rpcOn(target).automations.restoreAgentSchedules(
          { sessionId: own.conversationId, projectId: own.projectId, provider: own.harness },
          items
        );
      },
    },
  };
}

/** `dryRun` = 只问它的家在哪个目录,不建不写(预览 / 当旧家读时用,❌ 在人还没点确认前往家里写东西)。 */
async function prepareLocalHome(dryRun = false): Promise<PrepareLocalHomeResult> {
  const ipc = desktopIpc();
  if (!ipc) throw new Error('only the desktop app can host the assistant');
  return (await ipc.invoke(ASSISTANT_HOME_CHANNELS.prepare, dryRun ? { dryRun: true } : {})) as PrepareLocalHomeResult;
}

/** 它在云上那条会话跑在哪个目录(项目路径);项目表还没同步过来就等一会儿。 */
async function cloudWorkdir(deviceId: string, assistantId: string): Promise<string> {
  const own = await assistantSessionOn(deviceId, assistantId, SESSION_WAIT_MS);
  return until('the assistant project on the cloud home', SESSION_WAIT_MS, async () => appState.projects.projects.get(own.projectId)?.data?.path ?? null);
}

async function cloudDeviceReady(deviceId: string): Promise<void> {
  await until('the cloud home to connect', ADOPT_TIMEOUT_MS, async () => remoteHostsStore.connectionState(deviceId) === 'connected');
}

// ── 日志(中断后接着搬) ───────────────────────────────────────────────

const journalKey = (ownerUserId: string) => `gugu:assistant-move:${ownerUserId}`;

export function moveJournalStore(ownerUserId: string): MoveDeps['journal'] {
  return {
    load() {
      try {
        const raw = localStorage.getItem(journalKey(ownerUserId));
        return raw ? (JSON.parse(raw) as MoveJournal) : null;
      } catch {
        return null;
      }
    },
    save(journal) {
      // 日志丢了只意味着「不能接着搬」(要从头再来),不该让搬家本身失败:写不进去就不写。
      try {
        localStorage.setItem(journalKey(ownerUserId), JSON.stringify(journal));
      } catch {
        // ignore
      }
    },
    clear() {
      try {
        localStorage.removeItem(journalKey(ownerUserId));
      } catch {
        // ignore
      }
    },
  };
}

/**
 * 上次没搬完的那一次(没有 = null)。日志没记旧家是哪台(老版本留下的)、或不是这位助理的 = 不当成可接着搬,
 * ❌ 拿它去猜旧家(此刻「它住哪」在接过之后已经是新家)。
 */
export function pendingMove(ownerUserId: string, assistantId?: string): MoveJournal | null {
  const journal = moveJournalStore(ownerUserId).load();
  if (!journal || !journal.source) return null;
  if (assistantId && journal.assistantId !== assistantId) return null;
  return journal;
}

/** 这一次搬的旧家:接着搬以日志为准;新开一次搬 = 此刻它住的地方。 */
function sourceHomeFor(env: MoveEnv, direction: MoveDirection): MoveHomeRef {
  const saved = pendingMove(env.ownerUserId, env.assistantId);
  if (saved && saved.direction === direction && saved.source) return saved.source;
  return { kind: env.home.kind, deviceId: env.home.deviceId };
}

// ── 真接线 ────────────────────────────────────────────────────────────

async function homeDeviceOf(assistantId: string): Promise<string | null> {
  return (await readDisplayIdentities([assistantId]))[0]?.device_id ?? null;
}

/** 旧家那一头(只读)。`sourceHome` 来自日志或此刻它住的地方,❌ 在这里再读一次「它住哪」。 */
export async function openSource(env: MoveEnv, direction: MoveDirection, sourceHome: MoveHomeRef = sourceHomeFor(env, direction)): Promise<MoveSide> {
  if (direction === 'to-cloud') {
    if (sourceHome.kind !== 'computer' || sourceHome.deviceId !== env.localDeviceId) throw new Error('the source home is not this computer');
    // 本机上的家:工作目录就是它在这台电脑上的那个(只问不写:人还没确认,旧家一个字节都不动)。
    const prepared = await prepareLocalHome(true);
    const home: AssistantHomePlace = { kind: 'computer', deviceId: env.localDeviceId, thisDevice: true, label: null, online: true, known: true };
    const machine = await openAssistantMachine(home, prepared.workdir);
    return sideOf(machine, '这台电脑', env.assistantId, prepared.workdir, env.localDeviceId);
  }
  // 搬回本机:云上的家要先醒着(管家有家就放行,会员到期也行、不计费)。
  const deviceId = sourceHome.deviceId;
  await wakeCloudComputer({ purpose: 'move_out' });
  await cloudDeviceReady(deviceId);
  const workdir = await cloudWorkdir(deviceId, env.assistantId);
  const machine = await openAssistantMachine({ kind: 'cloud', deviceId }, workdir);
  return sideOf(machine, '云上', env.assistantId, machine.home, deviceId);
}

export function buildMoveDeps(
  env: MoveEnv,
  direction: MoveDirection,
  source: MoveSide,
  sourceHome: MoveHomeRef,
  onProgress?: MoveDeps['onProgress'],
  model?: AgentModelSelection
): MoveDeps {
  const journal = moveJournalStore(env.ownerUserId);
  if (direction === 'to-cloud') {
    return {
      direction,
      assistantId: env.assistantId,
      source,
      sourceHome,
      journal,
      onProgress,
      async isAdopted() {
        const cloud = getCloudComputerState().snapshot?.deviceId ?? (await refreshCloudComputer().catch(() => null))?.deviceId ?? null;
        return !!cloud && (await homeDeviceOf(env.assistantId)) === cloud;
      },
      async adopt() {
        try {
          await provisionCloudComputer({ assistant: { existingAgentUserId: env.assistantId } });
        } catch (error) {
          if (error instanceof CloudComputerError && error.code === 'busy') {
            // 已经在开了(上一次搬到一半):接着等。
          } else {
            // 管家当场拒绝的(没会员 / 没积分 / 已有一个 / 这一版接不了)= 什么都没开始,旧家原样;别的(网络、超时)不知道。
            if (error instanceof CloudComputerError && REFUSED_BEFORE_START.has(error.code)) (error as { notStarted?: boolean }).notStarted = true;
            throw error;
          }
        }
        const deviceId = await until('the cloud home to take the assistant', ADOPT_TIMEOUT_MS, async () => {
          const snapshot = await refreshCloudComputer().catch(() => null);
          if (snapshot?.state === 'error') throw new Error(snapshot.error ?? 'cloud computer reported an error');
          if (!snapshot?.deviceId || snapshot.state !== 'awake' || snapshot.adopting) return null;
          return (await homeDeviceOf(env.assistantId)) === snapshot.deviceId ? snapshot.deviceId : null;
        });
        await cloudDeviceReady(deviceId);
        reloadMyAssistant(env.ownerUserId);
      },
      async openTarget() {
        // 接着搬时 isAdopted 直接为真、不会走 adopt 里的叫醒:云上那台可能已经睡了,先醒着、连上再往里拷。
        const deviceId = getCloudComputerState().snapshot?.deviceId ?? (await refreshCloudComputer().catch(() => null))?.deviceId ?? null;
        if (!deviceId) throw new Error('the cloud home has no device yet');
        await wakeCloudComputer();
        await cloudDeviceReady(deviceId);
        const workdir = await cloudWorkdir(deviceId, env.assistantId);
        const machine = await openAssistantMachine({ kind: 'cloud', deviceId }, workdir);
        return sideOf(machine, '云上', env.assistantId, machine.home, deviceId);
      },
      restart: () => restartAssistant(env.assistantId),
    };
  }
  let localWorkdir: string | null = null;
  return {
    direction,
    assistantId: env.assistantId,
    source,
    sourceHome,
    journal,
    onProgress,
    async isAdopted() {
      return (await homeDeviceOf(env.assistantId)) === env.localDeviceId;
    },
    async openTarget() {
      const prepared = await prepareLocalHome();
      localWorkdir = prepared.workdir;
      const home: AssistantHomePlace = { kind: 'computer', deviceId: env.localDeviceId, thisDevice: true, label: null, online: true, known: true };
      return sideOf(await openAssistantMachine(home, prepared.workdir), '这台电脑', env.assistantId, prepared.workdir, env.localDeviceId);
    },
    async adopt() {
      const workdir = localWorkdir ?? (await prepareLocalHome()).workdir;
      const result = await provisionSingleAgent(
        env.localDeviceId,
        {
          memberKey: 'assistant',
          displayName: env.assistantName,
          agentType: 'claude-code',
          projectPath: workdir,
          inheritMemory: false,
          historyImportRequired: false,
          existingAgentUserId: env.assistantId,
        },
        { resumeStore: assistantResumeStore, ...(model && model.source !== 'default' ? { model: model.source === 'platform' ? `platform:${model.modelId}` : model.modelId } : {}) }
      );
      const phase = result.outcome.member.phase;
      if (phase === 'awaiting_terminal') throw new Error('the assistant is still starting on this computer');
      if (phase === 'failed') throw new Error(result.outcome.member.error ?? 'adopt failed');
      completedSingleProvisionSession(result);
      reloadMyAssistant(env.ownerUserId);
    },
    restart: () => restartAssistant(env.assistantId),
  };
}

/** 让新家上的助理从头读一遍刚拷来的说明与记忆:停掉运行时,再标回在线,下一条消息会重新起它。 */
async function restartAssistant(assistantId: string): Promise<void> {
  await contactsService.setAgentDesiredStatus(assistantId, 'offline');
  await contactsService.setAgentDesiredStatus(assistantId, 'online');
}

/** 确认框要的:会拷多少、会带走哪些账号(只有名字)、哪些要在新家重新连。只读,不动任何东西。 */
export async function previewMove(env: MoveEnv, direction: MoveDirection) {
  const source = await openSource(env, direction);
  const plan = await planMove(source);
  // 账号清单读的是旧家那一头(此刻它住的那台):本机 = null,别的机器 = 它的 id。
  // 旧家那头的咕咕比这个功能老:文件照搬,账号留在原处(确认框里如实说),❌ 因此整个搬不了。
  const accounts = await rpcOn(homeTarget(env.home))
    .integrations.moveSummary()
    .then((summary) => ({ ...summary, unsupported: false }))
    .catch((error: unknown) => {
      if (!isUnknownMethod(error)) throw error;
      return { moving: [], reconnect: [], unsupported: true };
    });
  return {
    bytes: plan.totalBytes,
    files: plan.trees.reduce((n, tree) => n + tree.plan.files.length, 0),
    skippedFiles: plan.trees.flatMap((tree) => tree.plan.skipped.map((s) => ({ rel: `${tree.name}/${s.rel}`, reason: s.reason }))),
    accounts,
  };
}

export async function runAssistantMove(env: MoveEnv, direction: MoveDirection, onProgress?: MoveDeps['onProgress']): Promise<MoveReport> {
  const sourceHome = sourceHomeFor(env, direction);
  const source = await openSource(env, direction, sourceHome);
  const saved = await readAgentModelSelection(env.assistantId);
  const target = direction === 'to-cloud' ? null : sourceHome.deviceId;
  const own = direction !== 'to-cloud' && saved.desired.source === 'default' ? await assistantSessionOn(target, env.assistantId, SESSION_WAIT_MS) : null;
  const options = own ? await rpcOn(target).sessionTimeline.sessionOptions({ conversationId: own.conversationId }) : null;
  if (options && !options.ok) throw new Error(options.error.message);
  const protocol = platformProtocolForAgentType('claude-code');
  if (!protocol) throw new Error('The assistant harness has no model protocol');
  const model = direction === 'to-cloud' ? cloudMoveModel(saved.desired, protocol)
    : moveModelSelection(saved.desired, options?.ok ? options.value : {}, protocol);
  const deps = buildMoveDeps(env, direction, source, sourceHome, onProgress, model);
  deps.configure = async () => {
    const outcome = await setAgentModelSelection(env.assistantId, model);
    if (!outcome.ok) throw new Error(outcome.error);
    const actual = await readAgentModelSelection(env.assistantId);
    if (actual.applyError || !sameMoveModel(model, actual.applied)) throw new Error(actual.applyError ?? 'The target has not applied the original model');
  };
  return runMove(deps);
}
