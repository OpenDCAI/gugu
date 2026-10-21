// #6264 资源库问的是**哪一台机器**(owner:「整个资源库或者其他的都是分设备的」)。
//
// 默认本机:取数钩子照旧走本机的 `rpc.<格>.*`。资源库左栏顶上选了别的机器时,**每一格**(提示词、智能体、集成、
// MCP、扩展)的钩子都换成这里给的那台机器的同名方法(经设备 RPC 转到那台机器上**同一个控制器**)——界面组件一个都
// 不认它,照旧渲染同一套控件,只是数据与动作来自另一台机器(与新建框的 remote-create-source 同一种做法)。
import { createContext, useContext } from 'react';
import type { AgentInstallProgress } from '@gugu/session-core/workspace-server';
import { events, onMachineEvent, rpc, rpcOn } from '@renderer/lib/ipc';
import { TOO_OLD_CODES } from '@renderer/features/remote-hosts/connection-status';
import type { PromptLibraryPrompt } from '@shared/prompt-library';
import {
  createRemoteExtensionsHost,
  LOCAL_EXTENSIONS_HOST,
  type ExtensionsHost,
} from '@renderer/features/extensions/extensions-host';
import { agentInstallProgressChannel } from '@shared/events/appEvents';
import type {
  AgentInstallationStatus,
  AgentPayload,
  AgentSettings,
  HostDependencySelection,
  Installation,
  InstallMethod,
  InstallSourceVersions,
} from '@shared/core/agents/agent-payload';
import type { ProviderCustomConfig } from '@shared/core/app-settings';

/** 与本机 `rpc.agents.*` 同名同参的那几个(资源库「智能体」一页用到的全部)。 */
export type LibraryAgentsRpc = {
  listManagement(): Promise<AgentPayload[]>;
  getManagement(id: string): Promise<AgentPayload | null>;
  listAgentInstallationStatus(): Promise<AgentInstallationStatus[]>;
  install(id: string, method?: InstallMethod, registry?: string): Promise<unknown>;
  update(id: string, method?: InstallMethod, registry?: string): Promise<unknown>;
  uninstall(id: string, method?: InstallMethod): Promise<unknown>;
  cancelInstall(id: string): Promise<boolean>;
  probeAll(): Promise<unknown>;
  refreshLatestVersion(id: string): Promise<void>;
  getInstallSourceVersions(id: string): Promise<InstallSourceVersions>;
  setUsedInstallation(id: string, selection: HostDependencySelection): Promise<void>;
  probeOverride(id: string, selection: { path?: string; cli?: string }): Promise<Installation | null>;
  getSettings(id: string): Promise<AgentSettings | null>;
  getDefaultSettings(id: string): Promise<ProviderCustomConfig | null>;
  updateSettings(id: string, config: Partial<ProviderCustomConfig>): Promise<void>;
  /** 这台机器上安装的实时读数;返回退订。 */
  onInstallProgress(listener: (progress: AgentInstallProgress) => void): () => void;
};

/** 与本机 `rpc.promptLibrary.*` 同名同参。 */
export type LibraryPromptsRpc = {
  get(): Promise<PromptLibraryPrompt[]>;
  update(prompts: PromptLibraryPrompt[]): Promise<void>;
};

/** 资源库 → MCP:咕咕自己管的那份列表与各家自己的那几台(本机 `rpc.mcpLibrary.*`,别的机器同一个控制器)。 */
export type LibraryMcpRpc = typeof rpc.mcpLibrary;

type IntegrationsApi = typeof rpc.integrations;
type GithubApi = typeof rpc.github;

/** 集成那一页用到的全部。连没连上那两问覆盖注册表里每一家,不只 issue 系统(#7210)。 */
export type LibraryIntegrationsRpc = Pick<
  IntegrationsApi,
  | 'list'
  | 'connect'
  | 'disconnect'
  | 'authorize'
  | 'cancelAuthorization'
  | 'cliLoginStart'
  | 'cliLoginWait'
  | 'cliLoginProgress'
  | 'accounts'
  | 'checkAccounts'
  | 'checkAllConnections'
  | 'checkConfiguredConnections'
>;

/** GitHub 账号(集成那一页的 GitHub 卡片、连接弹窗、设备码弹窗)。 */
export type LibraryGithubRpc = Pick<
  GithubApi,
  'listAccounts' | 'importCliAccounts' | 'setDefaultAccount' | 'removeAccount' | 'auth' | 'authCancel'
> & {
  /** 这台机器主进程推的事件(设备码 / 成功 / 失败);别的机器只在 `auth` 进行中转过来。返回退订。 */
  onEvent<T>(event: { name: string; _data?: T }, listener: (data: T) => void): () => void;
};

export type LibraryRemoteDevice = {
  deviceId: string;
  /** 「在哪跑」里这台机器的名字。 */
  deviceLabel: string;
  online: boolean;
  lastSeenAt: string | null;
  /** 咕咕 server(没有窗口)还是另一台咕咕桌面;不知道 = undefined。 */
  hostKind?: 'desktop' | 'server';
};

export type LibraryHost = {
  /** 缓存键里区分机器的那一段:本机 `local`,别的机器 `remote:<deviceId>`。 */
  key: string;
  agents: LibraryAgentsRpc;
  prompts: LibraryPromptsRpc;
  mcpLibrary: LibraryMcpRpc;
  integrations: LibraryIntegrationsRpc;
  github: LibraryGithubRpc;
  /** 扩展(另一台咕咕桌面才有;咕咕 server 没有窗口,那一格不用它)。 */
  extensions: ExtensionsHost;
  /** null = 本机。 */
  remote: LibraryRemoteDevice | null;
};

export const LOCAL_HOST_KEY = 'local';

const localAgents: LibraryAgentsRpc = {
  listManagement: () => rpc.agents.listManagement() as Promise<AgentPayload[]>,
  getManagement: (id) => rpc.agents.getManagement(id) as Promise<AgentPayload | null>,
  listAgentInstallationStatus: () => rpc.agents.listAgentInstallationStatus() as Promise<AgentInstallationStatus[]>,
  install: (id, method, registry) => rpc.agents.install(id as never, method, registry) as Promise<unknown>,
  update: (id, method, registry) => rpc.agents.update(id as never, method, registry) as Promise<unknown>,
  uninstall: (id, method) => rpc.agents.uninstall(id as never, method) as Promise<unknown>,
  cancelInstall: (id) => rpc.agents.cancelInstall(id as never) as Promise<boolean>,
  probeAll: () => rpc.agents.probeAll() as Promise<unknown>,
  refreshLatestVersion: (id) => rpc.agents.refreshLatestVersion(id as never) as Promise<void>,
  getInstallSourceVersions: (id) => rpc.agents.getInstallSourceVersions(id as never) as Promise<InstallSourceVersions>,
  setUsedInstallation: (id, selection) => rpc.agents.setUsedInstallation(id as never, selection as never) as Promise<void>,
  probeOverride: (id, selection) => rpc.agents.probeOverride(id as never, selection) as Promise<Installation | null>,
  getSettings: (id) => rpc.agents.getSettings(id) as Promise<AgentSettings | null>,
  getDefaultSettings: (id) => rpc.agents.getDefaultSettings(id) as Promise<ProviderCustomConfig | null>,
  updateSettings: (id, config) => rpc.agents.updateSettings(id, config) as Promise<void>,
  onInstallProgress: (listener) => events.on(agentInstallProgressChannel, listener),
};

const localPrompts: LibraryPromptsRpc = {
  get: () => rpc.promptLibrary.get(),
  update: (prompts) => rpc.promptLibrary.update(prompts),
};

const localIntegrations: LibraryIntegrationsRpc = {
  list: (locale) => rpc.integrations.list(locale),
  connect: (id, input, editAccountId) => rpc.integrations.connect(id, input, editAccountId),
  disconnect: (id, accountId) => rpc.integrations.disconnect(id, accountId),
  accounts: (id) => rpc.integrations.accounts(id),
  checkAccounts: (id) => rpc.integrations.checkAccounts(id),
  authorize: (id) => rpc.integrations.authorize(id),
  cancelAuthorization: (id) => rpc.integrations.cancelAuthorization(id),
  cliLoginStart: (id) => rpc.integrations.cliLoginStart(id),
  cliLoginWait: (id) => rpc.integrations.cliLoginWait(id),
  cliLoginProgress: (id) => rpc.integrations.cliLoginProgress(id),
  checkAllConnections: () => rpc.integrations.checkAllConnections(),
  checkConfiguredConnections: () => rpc.integrations.checkConfiguredConnections(),
};

export function isTooOld(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && TOO_OLD_CODES.has(code);
}

const localGithub: LibraryGithubRpc = {
  listAccounts: () => rpc.github.listAccounts(),
  importCliAccounts: () => rpc.github.importCliAccounts(),
  setDefaultAccount: (id) => rpc.github.setDefaultAccount(id),
  removeAccount: (id) => rpc.github.removeAccount(id),
  auth: () => rpc.github.auth(),
  authCancel: () => rpc.github.authCancel(),
  onEvent: (event, listener) => events.on(event as never, listener as never),
};

export const LOCAL_LIBRARY_HOST: LibraryHost = {
  key: LOCAL_HOST_KEY,
  agents: localAgents,
  prompts: localPrompts,
  mcpLibrary: rpc.mcpLibrary,
  integrations: localIntegrations,
  github: localGithub,
  extensions: LOCAL_EXTENSIONS_HOST,
  remote: null,
};

/**
 * 别的机器:同名方法经那台机器的会话页宿主(一套工作台,见 lib/machine-routing.ts)调**同一个控制器**。
 * 推送只收那台机器的(onMachineEvent)。
 */
export function createRemoteLibraryHost(
  device: LibraryRemoteDevice,
  /** 「从文件夹安装扩展」时在那台机器上挑文件夹(与新建框的「浏览」同一个)。 */
  pickFolder: (deviceId: string, initialPath: string) => Promise<string | null> = async () => null
): LibraryHost {
  const { deviceId } = device;
  const there = rpcOn(deviceId);
  const agents: LibraryAgentsRpc = {
    listManagement: () => there.agents.listManagement() as Promise<AgentPayload[]>,
    getManagement: (id) => there.agents.getManagement(id) as Promise<AgentPayload | null>,
    listAgentInstallationStatus: () => there.agents.listAgentInstallationStatus() as Promise<AgentInstallationStatus[]>,
    install: (id, method, registry) => there.agents.install(id as never, method, registry) as Promise<unknown>,
    update: (id, method, registry) => there.agents.update(id as never, method, registry) as Promise<unknown>,
    uninstall: (id, method) => there.agents.uninstall(id as never, method) as Promise<unknown>,
    cancelInstall: (id) => there.agents.cancelInstall(id as never) as Promise<boolean>,
    probeAll: () => there.agents.probeAll() as Promise<unknown>,
    refreshLatestVersion: (id) => there.agents.refreshLatestVersion(id as never) as Promise<void>,
    getInstallSourceVersions: (id) => there.agents.getInstallSourceVersions(id as never) as Promise<InstallSourceVersions>,
    setUsedInstallation: (id, selection) => there.agents.setUsedInstallation(id as never, selection as never) as Promise<void>,
    probeOverride: (id, selection) => there.agents.probeOverride(id as never, selection) as Promise<Installation | null>,
    getSettings: (id) => there.agents.getSettings(id) as Promise<AgentSettings | null>,
    getDefaultSettings: (id) => there.agents.getDefaultSettings(id) as Promise<ProviderCustomConfig | null>,
    updateSettings: (id, config) => there.agents.updateSettings(id, config) as Promise<void>,
    onInstallProgress: (listener) => onMachineEvent(deviceId, agentInstallProgressChannel, listener),
  };
  const integrations: LibraryIntegrationsRpc = {
    list: (locale) => there.integrations.list(locale),
    connect: (id, input, editAccountId) => there.integrations.connect(id, input, editAccountId),
    disconnect: (id, accountId) => there.integrations.disconnect(id, accountId),
    accounts: (id) => there.integrations.accounts(id),
    checkAccounts: (id) => there.integrations.checkAccounts(id),
    /**
     * 浏览器授权的回调只能落在**这台电脑**的 127.0.0.1 上(那台机器没有浏览器、也收不到回调):
     * 在这里授权拿到凭据,交给那台机器的 `connect` —— 它照本机那一步验证、存进它自己的库。
     */
    authorize: async (id) => {
      const acquired = await rpc.integrations.acquireAuthorization(id);
      if (!acquired.success) return acquired;
      return there.integrations.connect(id, acquired.credentials);
    },
    /**
     * 浏览器授权的那一跳之外还要撤掉那台机器上的命令行登录(它在那台机器上跑)。本机这一跳照旧:
     * 浏览器授权的监听在这台电脑上。
     */
    cancelAuthorization: async (id) => {
      await rpc.integrations.cancelAuthorization(id);
      await there.integrations.cancelAuthorization(id);
    },
    /** 官方命令行在**那台**机器上装、在那台机器上登:登录态要落在用它的那台机器上。 */
    cliLoginStart: (id) => there.integrations.cliLoginStart(id),
    cliLoginWait: (id) => there.integrations.cliLoginWait(id),
    cliLoginProgress: (id) => there.integrations.cliLoginProgress(id),
    checkAllConnections: () => there.integrations.checkAllConnections(),
    checkConfiguredConnections: () => there.integrations.checkConfiguredConnections(),
  };
  return {
    key: `remote:${deviceId}`,
    agents,
    prompts: { get: () => there.promptLibrary.get(), update: (prompts) => there.promptLibrary.update(prompts) },
    mcpLibrary: there.mcpLibrary,
    integrations,
    github: {
      listAccounts: () => there.github.listAccounts(),
      importCliAccounts: () => there.github.importCliAccounts(),
      setDefaultAccount: (id) => there.github.setDefaultAccount(id),
      removeAccount: (id) => there.github.removeAccount(id),
      auth: () => there.github.auth(),
      authCancel: () => there.github.authCancel(),
      onEvent: (event, listener) => onMachineEvent(deviceId, event, listener),
    },
    extensions: createRemoteExtensionsHost(deviceId, pickFolder),
    remote: device,
  };
}

const machineHosts = new Map<string, LibraryHost>();

/**
 * #6264 一台机器的那份宿主(按机器缓存):会话页、新建框里「这台机器上有哪些 agent、能用哪些模型」问它。
 * null = 本机。
 */
export function machineLibraryHost(device: LibraryRemoteDevice | null): LibraryHost {
  if (!device) return LOCAL_LIBRARY_HOST;
  // 名字 / 在线变了就换一份(取数钩子按 `remote.online` 决定问不问),同一份读数时认同一个对象。
  const key = `${device.deviceId}|${device.deviceLabel}|${device.online}|${device.lastSeenAt ?? ''}|${device.hostKind ?? ''}`;
  let host = machineHosts.get(key);
  if (!host) {
    for (const [existing, value] of machineHosts) if (value.remote?.deviceId === device.deviceId) machineHosts.delete(existing);
    machineHosts.set(key, (host = createRemoteLibraryHost(device)));
  }
  return host;
}

const LibraryHostContext = createContext<LibraryHost>(LOCAL_LIBRARY_HOST);

export const LibraryHostProvider = LibraryHostContext.Provider;

/** 资源库里选了别的机器 = 那台;其余任何地方(composer、会话页、本机资源库、应用根上那份集成)= 本机。 */
export function useLibraryHost(): LibraryHost {
  return useContext(LibraryHostContext);
}
