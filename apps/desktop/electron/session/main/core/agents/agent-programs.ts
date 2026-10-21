import type { AgentProgramPart } from '@gugu/session-core/deps/runtime';
import type {
  AgentInstallationStatus,
  AgentProgramStatus,
  DependencyStatus,
  InstallationReading,
} from '@shared/core/agents/agent-payload';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';

/**
 * 一家由几个程序组成时(#6335),把逐个程序的读数折成**这一家**的一份。
 *
 * 判据:这一家「装好了」= 每条腿的程序都装好了。任何一条腿的程序没装,顶层就不说「已安装」——
 * 否则用户在资源库里看见「已安装」,点编程视角却起不来(终端腿的 `agy` 根本不在)。
 * 逐条腿的读数另放在 `legReadings`:选择器建哪条腿的会话就问哪条腿,只装了聊天面板那个程序的
 * 机器上,通用视角照样能选。
 *
 * 顶层的 `installations` / `used` / `version` / `command` 仍是主程序的 —— 「用哪一份」那张来源
 * 列表说的是主程序;伴随程序的「用哪一份」按它自己那一行的选择走(`resolveAgentExecutable` 的
 * `dependencyId`),界面上只报它装没装、什么版本。
 */

/**
 * 合并时谁压谁 —— 排在前面的更「该让用户动手」:
 * 一份都没有(去装)> 在但跑不起来(去修)> 选中那份没了(重新选)> 装好了。
 */
const READING_SEVERITY: readonly InstallationReading[] = [
  'not-detected',
  'detected-but-broken',
  'missing',
  'installed',
];
const STATUS_SEVERITY: readonly DependencyStatus[] = ['missing', 'error', 'available'];

function worst<T>(order: readonly T[], values: T[]): T {
  return values.reduce((a, b) => (order.indexOf(b) < order.indexOf(a) ? b : a));
}

/** 读不到状态(还没探过)的那一行按「一份都没有」算 —— ❌ 不把「还没看过」报成「装好了」。 */
function programStatus(
  part: AgentProgramPart,
  status: AgentInstallationStatus | undefined,
): AgentProgramStatus {
  const managed = status?.installations.find(
    (installation) => installation.provenance.ours === true,
  );
  return {
    dependencyId: part.dependencyId,
    name: part.name,
    binaryName: part.binaryName,
    legs: part.legs as SessionpageLeg[],
    reading: status?.reading ?? 'not-detected',
    status: status?.status ?? 'missing',
    version: status?.version ?? null,
    managed: managed !== undefined,
    managedVersion: managed?.version ?? null,
    managedUpdateAvailable: managed?.updateAvailable === true,
  };
}

/**
 * `parts` 来自 `agentProgramsOf`(主程序在前);`statusOf` 给每一行自己的那份 DTO。
 * 只有一个程序时原样返回主程序那份 —— 绝大多数家走这条,❌ 不给它们多挂两格。
 */
export function foldAgentPrograms(
  parts: AgentProgramPart[],
  statusOf: (dependencyId: string) => AgentInstallationStatus | undefined,
): AgentInstallationStatus | undefined {
  const [main, ...companions] = parts;
  if (!main) return undefined;
  const mainStatus = statusOf(main.dependencyId);
  if (companions.length === 0 || !mainStatus) return mainStatus;

  const programs = parts.map((part) => programStatus(part, statusOf(part.dependencyId)));
  const legReadings: Partial<Record<SessionpageLeg, InstallationReading>> = {};
  for (const program of programs) {
    for (const leg of program.legs) legReadings[leg] = program.reading;
  }
  return {
    ...mainStatus,
    reading: worst(READING_SEVERITY, programs.map((program) => program.reading)),
    status: worst(STATUS_SEVERITY, programs.map((program) => program.status)),
    updateAvailable:
      mainStatus.updateAvailable ||
      programs.slice(1).some((program) => program.managedUpdateAvailable),
    programs,
    legReadings,
  };
}

/**
 * 一次「安装」要装哪几个程序。
 *
 * 一个程序的家:就是它自己(照旧 —— 已装也重装,那是「装一份最新的并切过去」)。
 * 几个程序的家:只装**咕咕还没有自己那一份**的那几个 —— 聊天面板那个 400 MB 的程序已经装好时,
 * 补装终端腿的 `agy` ❌ 不该把它再下一遍。全都有了才全装(与单程序同一个语义)。
 */
export function partsToInstall<T extends { dependencyId: string }>(
  parts: T[],
  hasManagedCopy: (dependencyId: string) => boolean,
): T[] {
  if (parts.length < 2) return parts;
  const missing = parts.filter((part) => !hasManagedCopy(part.dependencyId));
  return missing.length > 0 ? missing : parts;
}

/**
 * 一次「更新」要动哪几个程序:咕咕那一份有新版本的那几个。一个都没标出来(版本还没查到)时
 * 退回主程序 —— 与单程序的家从前的行为一致。
 */
export function partsToUpdate<T extends { dependencyId: string }>(
  parts: T[],
  programs: Pick<AgentProgramStatus, 'dependencyId' | 'managedUpdateAvailable'>[] | undefined,
): T[] {
  if (parts.length < 2) return parts;
  const flagged = new Set(
    (programs ?? []).filter((program) => program.managedUpdateAvailable).map((program) => program.dependencyId),
  );
  const picked = parts.filter((part) => flagged.has(part.dependencyId));
  return picked.length > 0 ? picked : parts.slice(0, 1);
}
