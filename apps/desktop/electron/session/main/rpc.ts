import { createRPCNamespace, createRPCRouter } from '@shared/lib/ipc/rpc';
import { agentsController } from './core/agents/controller';
import { agentSessionController, assistantWorkController } from './core/sessions/agent-session-controller';
import { appController } from './core/app/controller';
import { automationsController } from './core/automations/controller';
import { browserController } from './core/browser/controller';
import { sessionController } from './core/sessions/controller';
import { editorBufferController } from './core/editor/controller';
import { extensionsController } from './core/extensions/controller';
import { machineFilesController } from './core/files/controller';
import { machineController } from './core/machine/controller';
import { workspaceFileSystemController } from './core/files/file-system/controller';
import { fileTreeController } from './core/files/file-tree/controller';
import { gitRepositoryController } from './core/git/repository/controller';
import { gitWorktreeController } from './core/git/worktree/controller';
import { githubController } from './core/github/controller';
import { integrationsController } from './core/integrations/controller';
import { issueController } from './core/issues/controller';
import { mcpController } from './core/mcp/controller';
import { mcpLibraryController } from './core/mcp-library/controller';
import { previewServersController } from './core/preview-servers/controller';
import { projectSetupController } from './core/project-setup/controller';
import { projectController } from './core/projects/controller';
import { promptLibraryController } from './core/prompt-library/controller';
import { ptyController } from './core/pty/controller';
import { remotePortsController } from './core/pty/direct-terminal/port-forward-controller';
import { pullRequestController } from './core/pull-requests/controller';
import { resourceMonitorController } from './core/resource-monitor/controller';
import { searchController } from './core/search/controller';
import { sessionTimelineController } from './core/session-timeline/controller';
import { sessionHistoryController } from './core/session-history/controller';
import { sessionImportController } from './core/session-import/controller';
import { appSettingsController } from './core/settings/controller';
import { providerSettingsController } from './core/settings/provider-settings-controller';
import { sessionCreateController } from './core/sessions/create-controller';
import { terminalsController } from './core/terminals/controller';
import { usageController } from './core/usage/controller';
import { viewStateController } from './core/view-state/controller';
import { projectSettingsController } from './core/workspaces/project-settings-controller';

export const rpcRouter = createRPCRouter({
  agents: agentsController,
  // agent 的 session_* 跨机器动作:别的机器经 `taskhost.call` 交给这台执行。
  agentSession: agentSessionController,
  assistantWork: assistantWorkController,
  app: appController,
  automations: automationsController,
  appSettings: appSettingsController,
  providerSettings: providerSettingsController,
  browser: browserController,
  // #7199 云电脑上 agent 用的那个 Chrome(状态与小图;实时画面另走隧道上的 websocket)。别的电脑经 rpcOn(云电脑) 问。
  extensions: extensionsController,
  gitRepository: gitRepositoryController,
  pty: ptyController,
  // #6264 别的机器上的「编程」会话:经 SSH 直连那台机器的终端(只给用 SSH 装上的机器)。
  // #6264 会话右侧工作区的「浏览器」打开那台机器的 localhost:<端口>:经 SSH 转一个本机端口过去。
  remotePorts: remotePortsController,
  resourceMonitor: resourceMonitorController,
  files: machineFilesController,
  // #6264 问「这台机器」本身的事(端口、git 署名);别的电脑经 rpcOn(机器) 问。
  machine: machineController,
  github: githubController,
  integrations: integrationsController,
  issues: issueController,
  promptLibrary: promptLibraryController,
  projectSetup: projectSetupController,
  projects: projectController,
  previewServers: previewServersController,
  sessionCreate: sessionCreateController,
  sessions: sessionController,
  terminals: terminalsController,
  mcp: mcpController,
  mcpLibrary: mcpLibraryController,
  pullRequests: pullRequestController,
  viewState: viewStateController,
  search: searchController,
  sessionHistory: sessionHistoryController,
  sessionImport: sessionImportController,
  sessionTimeline: sessionTimelineController,
  projectSettings: projectSettingsController,
  usage: usageController,
  workspace: createRPCNamespace({
    gitWorktree: gitWorktreeController,
    files: workspaceFileSystemController,
    fileTree: fileTreeController,
    editor: editorBufferController,
  }),
});

export type RpcRouter = typeof rpcRouter;
