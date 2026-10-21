import type { CLIAgentPluginProvider } from '../agents/plugins';
import { harnessSelfUpdateLaunch } from '../agents/plugins/capabilities/session-bundle';
import { HOST_DEPENDENCY_LEGS, type HostDependencyDescriptor, type HostDependencyLeg } from './capability';
import type { DependencyDescriptor } from './runtime';

/**
 * 一个插件在依赖管理器里是**几行**:主程序一行,每个伴随程序各一行(#6335)。
 *
 * 伴随程序那一行是一份普通的 agent 依赖 —— 自己探、自己装、自己的「用哪一份」—— 只多一个
 * `ownerId`。探测环境(`probeEnv`,关自更新那一格)与属主同一份:它跑起来就是属主那一家的某条腿。
 */
export function buildDescriptorsFromProvider(provider: CLIAgentPluginProvider): DependencyDescriptor[] {
  const { metadata, capabilities } = provider;
  const hostDep = capabilities.hostDependency;
  const probeEnv = harnessSelfUpdateLaunch(capabilities.sessionBundle).env;
  const main = toDescriptor(metadata.id, metadata.name, hostDep, probeEnv, metadata.websiteUrl);
  const companions = (hostDep.companions ?? []).map((companion) => ({
    ...toDescriptor(companion.id, companion.name, companion.dependency, probeEnv, metadata.websiteUrl),
    ownerId: metadata.id,
  }));
  return [main, ...companions];
}

/** 只要主程序那一行。 */
export function buildDescriptorFromProvider(provider: CLIAgentPluginProvider): DependencyDescriptor {
  return buildDescriptorsFromProvider(provider)[0]!;
}

function toDescriptor(
  id: string,
  name: string,
  hostDep: Omit<HostDependencyDescriptor, 'companions'>,
  probeEnv: Readonly<Record<string, string>>,
  docUrl: string,
): DependencyDescriptor {
  return {
    id,
    name,
    category: 'agent',
    commands: hostDep.binaryNames,
    ...(hostDep.knownPaths ? { knownPaths: hostDep.knownPaths } : {}),
    skipVersionProbe: hostDep.skipVersionProbe,
    versionArgs: hostDep.versionArgs,
    probeEnv,
    docUrl,
    updates: hostDep.updates,
    installCommands: hostDep.installCommands,
    uninstall: hostDep.uninstall,
  };
}

/**
 * 跑哪个程序 —— 按**角色**问,不按插件问(#6335)。
 *
 * · `tui` / `acp`:那条腿。被某个伴随程序认领就是它,否则是主程序。
 * · `primary`:主程序,与腿无关 —— 给「这一家」层面的动作用(登录、登录状态、凭据判断:
 *   今天它们都针对主程序;第二个程序的登录由它自己的入口另问)。
 *
 * ❌ 别在调用点再写 `hostDependency.binaryNames[0]`:那一格只说主程序,终端腿拿它就会去跑
 * `agy_acp_server`。
 */
export type AgentProgramRole = HostDependencyLeg | 'primary';

export type AgentProgram = {
  /** 依赖管理器里那一行的 id —— 选择、探测缓存、安装记录都按它存。 */
  dependencyId: string;
  /** 自动解析时在 PATH 上找的名字(厂商真正的二进制名,第一个)。 */
  binaryName: string;
};

export function agentProgramFor(
  provider: Pick<CLIAgentPluginProvider, 'metadata' | 'capabilities'>,
  role: AgentProgramRole,
): AgentProgram {
  const hostDep = provider.capabilities.hostDependency;
  const companion =
    role === 'primary' ? undefined : hostDep.companions?.find((entry) => entry.legs.includes(role));
  if (companion) {
    return { dependencyId: companion.id, binaryName: companion.dependency.binaryNames[0] ?? companion.id };
  }
  return { dependencyId: provider.metadata.id, binaryName: hostDep.binaryNames[0] ?? provider.metadata.id };
}

/**
 * 这一家由哪几个程序组成、各管哪几条腿 —— 主程序在前(#6335)。
 *
 * 主程序管的是**没被伴随程序认领的**那几条腿;没有伴随程序的家就是一个程序、两条腿全管。
 * 界面按腿合并读数(「这一家能不能起终端腿」)、安装按程序逐个装,都从这张表出发。
 */
export type AgentProgramPart = AgentProgram & { name: string; legs: HostDependencyLeg[] };

export function agentProgramsOf(
  provider: Pick<CLIAgentPluginProvider, 'metadata' | 'capabilities'>,
): AgentProgramPart[] {
  const hostDep = provider.capabilities.hostDependency;
  const companions = hostDep.companions ?? [];
  const claimed = new Set(companions.flatMap((companion) => companion.legs));
  return [
    {
      dependencyId: provider.metadata.id,
      binaryName: hostDep.binaryNames[0] ?? provider.metadata.id,
      name: provider.metadata.name,
      legs: HOST_DEPENDENCY_LEGS.filter((leg) => !claimed.has(leg)),
    },
    ...companions.map((companion) => ({
      dependencyId: companion.id,
      binaryName: companion.dependency.binaryNames[0] ?? companion.id,
      name: companion.name,
      legs: [...companion.legs],
    })),
  ];
}

/**
 * 「登 / 问哪个程序」→ 解析可执行文件时该按哪个角色问(#6335)。
 *
 * 缺席 = 主程序(`primary`,今天每一家的登录都长在它上)。给了伴随程序的依赖 id ⇒ 它认领的第一条腿:
 * 按那条腿解析,拿到的正是那个伴随程序的可执行文件(`agentProgramFor` 按腿找认领者),与那条腿的
 * 会话跑的是同一份。认不出的 id 回 `primary` —— 宿主的登录面(`resolveProgramAuth`)随后会因为
 * 「这一家没有这个程序」响亮拒绝,❌ 不在这里悄悄换成主程序去登。
 */
export function authProgramRole(
  provider: Pick<CLIAgentPluginProvider, 'capabilities'>,
  program: string | undefined,
): AgentProgramRole {
  if (program === undefined) return 'primary';
  const companion = provider.capabilities.hostDependency.companions?.find((entry) => entry.id === program);
  return companion?.legs[0] ?? 'primary';
}
