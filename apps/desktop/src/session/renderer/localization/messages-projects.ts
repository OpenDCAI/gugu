import type { SessionMessageValues } from './locale-store';
import type { SessionMessageLookupKey } from './messages';

/**
 * Message-producing helpers outside React take the translator as a parameter,
 * so their copy re-renders with the provider and stays unit testable. The key
 * type is the shared lookup key — the same one `useSessionMessages` exposes — so
 * a count-bearing base key resolves to its `_one`/`_other` variants.
 */
export type ProjectsTranslate = (key: SessionMessageLookupKey, values?: SessionMessageValues) => string;

export const enUSProjectMessages = {
  // ── browser: toolbar ────────────────────────────────────────────────────
  'browser.back': 'Back',
  'browser.forward': 'Forward',
  'browser.stop': 'Stop',
  'browser.reload': 'Reload',
  'browser.urlLabel': 'Browser URL',
  'browser.urlPlaceholder': 'Search or enter URL',
  'browser.copyScreenshot': 'Copy page screenshot',
  'browser.actions': 'Browser actions',
  'browser.openExternally': 'Open externally',
  'browser.forceReload': 'Force reload',
  'browser.openDevTools': 'Open DevTools',
  'browser.profile': 'Browser profile',
  'browser.isolatedPerTask': 'Isolated per task',
  'browser.manageProfiles': 'Manage profiles…',
  'browser.zoom': 'Zoom',
  'browser.zoomOut': 'Zoom out',
  'browser.zoomIn': 'Zoom in',
  'browser.resetZoom': 'Reset zoom',
  'browser.fitToWidth': 'Fit page to panel',
  'browser.clearCookies': 'Clear cookies',
  'browser.clearCache': 'Clear cache',
  'browser.clearStorage': 'Clear browser storage',

  // ── browser: URL rejection (protocol reason mapped at the boundary) ─────
  'browser.urlRejected.empty': 'Enter a URL',
  'browser.urlRejected.fileUrl': 'File URLs are not enabled for this browser',
  'browser.urlRejected.protocol': 'This URL scheme is not supported',
  'browser.urlRejected.invalid': 'Enter a valid URL',

  // ── browser: pane, tab, start page, diagnostics ────────────────────────
  'browser.sessionUnavailable': 'Browser session unavailable',
  'browser.preparingSession': 'Preparing browser session',
  'browser.agentDriving': 'The agent is using this page',
  'browser.agentPaused': 'You took over this page; the agent is paused',
  'browser.agentStop': 'Stop',
  'browser.agentResume': 'Let the agent continue',
  'browser.tabFallbackTitle': 'New tab',
  'browser.tools': 'Tools',
  'browser.newPage': 'New page',
  'browser.localServers': 'Local servers',
  'browser.serverPort': 'Port {port}',
  'browser.diagnostics': 'Diagnostics',
  'browser.clearDiagnostics': 'Clear',

  // ── browser: toolbar action feedback ───────────────────────────────────
  'browser.screenshotCopied': 'Screenshot copied to clipboard',
  'browser.screenshotFailed': 'Could not capture screenshot',
  'browser.clearDataFailed': 'Could not clear browser data',
  'browser.clearDataFailedDetail': 'Try again, or reload the browser view manually.',
  'browser.clearDataRequestFailed': 'The browser data request failed.',
  'browser.clearStorageTitle': 'Clear browser storage?',
  'browser.clearStorageDescription':
    'This clears cookies, local storage, IndexedDB, and cache for {profileLabel}. Browser tabs using the same storage boundary will be signed out.',
  'browser.clearStorageConfirm': 'Clear Storage',

  // ── browser: load errors (Chromium ERR_* / numeric code stay raw) ───────
  'browser.loadError.code': 'Error {code}',
  'browser.loadError.fallbackHost': 'This site',
  'browser.loadError.unreachable': "This site can't be reached",
  'browser.loadError.nameNotResolved': "{host}'s server IP address could not be found.",
  'browser.loadError.connectionRefused': '{host} refused to connect.',
  'browser.loadError.timedOut': '{host} took too long to respond.',
  'browser.loadError.connectionInterrupted': 'The connection to {host} was interrupted.',
  'browser.loadError.addressUnreachable': '{host} is unreachable.',
  'browser.loadError.noInternetHeading': 'No internet',
  'browser.loadError.noInternetDetail': 'You appear to be offline.',
  'browser.loadError.networkChanged': 'Your network connection changed.',
  'browser.loadError.insecureHeading': "This site can't provide a secure connection",
  'browser.loadError.insecureDetail': '{host} sent an invalid response.',
  'browser.loadError.certHeading': 'Your connection is not private',
  'browser.loadError.certDetail': "{host}'s security certificate is not trusted.",
  'browser.loadError.invalidUrl': "The web address isn't valid.",
  'browser.loadError.genericDetail': '{host} could not be loaded.',

  // ── projects: home, titlebar and view shell ────────────────────────────
  'projects.home.hero': 'What should we do in {projectName}?',
  'projects.home.connecting': 'Connecting to the project; you can send once it is ready…',
  'projects.folders.meta': '{folders} folders · {sessions} sessions',
  'projects.folders.agentTotal': '{count} agents in total',
  'projects.folders.agentCount': '{count} total',
  'projects.folders.scopeUnavailable': 'Folders on the selected devices are unavailable. Check the connection or choose another device scope.',
  'projects.folders.addMachine': 'Add a new device…',
  'projects.folders.offline': 'Offline',
  'projects.folders.deviceScope': 'Device scope',
  'projects.folders.deviceScopeHint': 'Available folders on: {devices}',
  'projects.folders.allDevices': 'All project devices',
  'projects.folders.scopeExecutionHint': 'Choose the device scope, then a folder to run this session in.',
  'projects.folders.deviceCount': '{count} devices',
  'projects.folders.agentMore': '{count} more agents',
  'projects.folders.running': '{count} running',
  'projects.folders.runningHere': '{count} running here',
  'projects.folders.idleHere': 'No sessions yet',
  'projects.folders.sessionsHere': '{count} sessions',
  'projects.folders.root': 'Project root',
  'projects.folders.fresh': 'Just attached',
  'projects.folders.hintClosed': 'Click the card to spread its {count} folders · pick one and the new task starts there',
  'projects.folders.hintOpen': 'Pick one and the new task starts there · click the card again to close',
  'projects.folders.hintFloating': 'Pick one and the new task starts there · type or press Esc to put it away',
  'projects.folders.attach': 'Attach a folder',
  'projects.folders.cardLabel': 'Folders of {projectName}',
  'projects.folders.dropHint': 'Drop to attach to {projectName}',
  'projects.folders.loadFailed': 'Couldn’t read this project’s folders',
  'projects.folders.loading': 'Reading folders…',
  'projects.folders.retry': 'Retry',
  'projects.folders.thisComputer': 'This computer',
  'projects.folders.attachDialogTitle': 'Attach a folder to {projectName}',
  'projects.folders.attachDialogMessage': 'The folder becomes part of this project; sessions can start there.',
  'projects.folders.attached': 'Attached {path} to {projectName}',
  'projects.folders.detached': '{path} is no longer part of {projectName}',
  'projects.folders.undo': 'Undo',
  'projects.folders.detach': 'Remove from project',
  'projects.folders.errorDetach': 'Couldn’t remove the folder — try again',
  'projects.folders.errorNotDirectory': 'Only folders can be attached',
  'projects.folders.errorIsProjectRoot': 'That folder is the project {projectName} itself',
  'projects.folders.errorOtherProject': 'That folder already belongs to {projectName}',
  'projects.folders.errorAttach': 'Couldn’t attach the folder — try again',
  'projects.folders.pickerTitle': 'Start in',
  'projects.folders.attachOn': 'Attach a folder on',
  'projects.folders.attachedOn': 'Attached {path} on {machine} to {projectName}',
  'projects.folders.mergeTitle': 'Bring {name} into {projectName}?',
  'projects.folders.mergeDescription': '{name} on {machine} already has {count} sessions. Their agents will join the {projectName} project group; its old group stays as history.',
  'projects.folders.mergeConfirm': 'Bring it in',
  'projects.titlebar.remove': 'Remove Project',
  'projects.fallbackName': 'this project',

  // ── projects: mount failure panels ─────────────────────────────────────
  'projects.error.setupFailed': 'Failed to set up project',
  'projects.error.openFailed': 'Failed to open project',
  'projects.error.notFoundAtPath': 'No project found at {path}',
  'projects.error.configuredPath': 'the configured path',
  'projects.notFound.title': 'Project not found',
  'projects.notFound.detail': 'The project directory no longer exists at the configured path.',
  'projects.accessBlocked.title': "Can't read the project folder",
  'projects.accessBlocked.detail':
    'Reading this folder timed out. On macOS, allow access to this location in Privacy settings, then retry.',
  'projects.accessBlocked.openSettings': 'Open Privacy Settings',
  'projects.error.retry': 'Retry',

  // ── projects: pending creation ─────────────────────────────────────────
  'projects.pending.creatingRepo': 'Creating repository',
  'projects.pending.cloning': 'Cloning',
  'projects.pending.registering': 'Registering',
  'projects.pending.genericError': 'An error occurred',
  'projects.pending.dismiss': 'Dismiss',

  // ── projects: add-project modal ────────────────────────────────────────
  'projects.add.configImported': '{label} config imported',
  'projects.add.configImportedDetail': '{files} was imported successfully.',

  // ── projects: directory browser ────────────────────────────────────────
  'projects.remoteDir.empty': 'Empty directory',
  'projects.remoteDir.listLabel': 'Directory contents',
  'projects.remoteDir.loading': 'Loading directory',
  'projects.remoteDir.useThis': 'Use this directory',
  'projects.remoteDir.selectDirectory': 'Select a directory',

  // ── projects: directory tree (web local folder picker) ────────────────
  'projects.dirTree.label': 'Folders',
  'projects.dirTree.loadFailed': 'Could not read',
  'projects.dirTree.homeUnavailable': 'Could not find the home directory on the host',
  // 原属 projects.remote.*,那一组随 #5058「下线远程项目入口」一起删了。文案一字不改地搬过来:
  // 「使用现有文件夹」用的就是这一句,它与远程无关,只是当初共用了那个目录浏览器。
  'projects.dirTree.notAGitRepo':
    'This directory is not a git repository; work will happen in it directly (an agent can initialize one if needed).',

  // ── projects: GitHub account select ────────────────────────────────────
  // "GitHub CLI" and "OAuth" are proper nouns and stay verbatim.
  'projects.github.sourceDeviceFlow': 'Device flow',
  'projects.github.sourceSavedToken': 'Saved token',
  'projects.github.default': 'Default',

  // ── projects: creation entry points ────────────────────────────────────
  'projects.create.nameTitle': 'Name the project',
  'projects.create.nameTitleOnMachine': 'Name the project on {machine}',
  'projects.create.nameLabel': 'Project name',
  'projects.create.cancel': 'Cancel',
  'projects.create.pickFolderTitle': 'Use an existing folder',
  'projects.create.pickFolderMessage': 'Choose a folder to use as the project',
  'projects.create.folderUnusable': 'Cannot use this folder',
  'projects.create.folderNameUnreadable': 'Could not read the folder name from the path',
  'projects.create.folderUnusableDetail':
    'Check that the folder still exists and that you can read and write it, or pick a different one.',
  'projects.create.blankProject': 'New blank project',
  'projects.create.existingFolder': 'Use an existing folder',
  'projects.create.creating': 'Creating…',
  'projects.create.save': 'Save',
  'projects.create.failed': 'Could not create the project',
  'projects.create.providerLocal': 'local',
  'projects.create.providerSsh': 'SSH',
  'projects.create.pathConflict':
    'The selected path is already used by the {provider} project "{name}" ({id}). Remove or move that project before creating another one.',
  'projects.create.noDefaultDirectory': 'No default projects directory is configured. Set one in settings first.',
  'projects.create.invalidName': 'A project name cannot contain path separators or reserved characters.',

  // ── projects: delete confirmation ──────────────────────────────────────
  'projects.delete.title': 'Delete project',
  'projects.delete.confirm': 'Delete',
  'projects.delete.description':
    '"{projectLabel}" will be deleted, together with all of its tasks (archived ones included) — they cannot be restored from Task history. The project folder and worktrees will stay on the filesystem.',
  'projects.delete.detachWarning_one':
    'This automation will be detached from the project and will not run until attached to another project:',
  'projects.delete.detachWarning_other':
    'These automations will be detached from the project and will not run until attached to another project:',

  // ── projects: task list ────────────────────────────────────────────────

  // ── projects: pull requests ────────────────────────────────────────────
  // PR titles, branches, numbers and author logins are raw GitHub data.

  // ── projects: settings view ────────────────────────────────────────────
  // ".gugu.json" is the real file name and stays literal in both locales.
  'projects.settings.detectedExternalConfig': 'Detected external project config.',
  'projects.settings.importInto': 'Import into {appName}',
  'projects.settings.importTitle': 'Import project config',
  'projects.settings.selectConfig': 'Select config',
  'projects.settings.settingsToImport': 'Settings to import',
  'projects.settings.saveTo': 'Save to',
  'projects.settings.destinationLocal': 'Settings',
  'projects.settings.destinationLocalHint': '– local to this machine',
  'projects.settings.destinationSharedHint': '– commit to share with team',
  'projects.settings.shareWithTeam': 'Share with team',
  'projects.settings.shareTooltip':
    'Writes selected settings to .gugu.json. Commit that file to share these defaults with your team.',
  'projects.settings.resetChanges': 'Reset changes',
  'projects.settings.shareTitle': 'Share settings with your team',
  'projects.settings.shareDescription':
    'This writes the selected settings to .gugu.json in the chosen working directory. Commit that file so teammates get the same project defaults after pulling.',
  'projects.settings.writeTo': 'Write to',
  'projects.settings.settingsToShare': 'Settings to share',
  'projects.settings.cancel': 'Cancel',
  'projects.settings.teamConfigShared': 'Team config shared',
  'projects.settings.teamConfigSharedDetail': '.gugu.json was written successfully.',
  'projects.settings.overriding': 'Overriding',
  'projects.settings.overridesIn': 'This overrides {teamConfigLabel} in {count}.',
  'projects.settings.useTeamSettingsFor': 'Use team settings for {label}',
  'projects.settings.useTeamSettings': 'Use team settings',

  // ── projects: settings fields ──────────────────────────────────────────
  'projects.settings.githubAccount': 'GitHub account',
  'projects.settings.githubAccountDescription': 'Used for pull requests and issues in this project.',
  'projects.settings.githubAccountUnavailable': 'Unavailable GitHub account',
  'projects.settings.githubAccountDisconnected': 'No longer connected',
  'projects.settings.noGithubAccount': 'No GitHub account',
  'projects.settings.defaultBranch': 'Default branch',
  'projects.settings.defaultBranchDescription': 'The branch new tasks are created from by default.',
  'projects.settings.baseRemote': 'Base remote',
  'projects.settings.baseRemoteDescription':
    'Used for fetching remote branches, choosing task base branches and targeting pull requests.',
  'projects.settings.pushRemote': 'Push remote',
  'projects.settings.pushRemoteDescription':
    'Used when publishing task branches and pushing commits.',
  'projects.settings.sameAsBaseRemote': 'Same as base remote',
  'projects.settings.enableTmux': 'Enable tmux',
  'projects.settings.enableTmuxDescription': 'Run the agent task inside a tmux session.',
  'projects.settings.lifecycleScripts': 'Lifecycle scripts',
  'projects.settings.lifecycleScriptsDescription':
    'Shell commands run at each stage of the worktree lifecycle. One command per line. When both are set to auto-run, the Run script waits for Setup to complete.',
  'projects.settings.autoRunOnTaskCreation': 'Auto-run on task creation',

  // ── projects: shareable field descriptors ──────────────────────────────
  // The placeholders stay literal: they are runnable command / glob examples.
  'projects.settings.field.preservePatterns': 'Preserve patterns',
  'projects.settings.field.preservePatternsLeaf': 'preserve patterns',
  'projects.settings.field.preservePatternsDescription':
    'Gitignored and untracked files matching these glob patterns are copied from the main repo into each worktree. One pattern per line.',
  'projects.settings.field.shellSetup': 'Shell setup',
  'projects.settings.field.shellSetupLeaf': 'shell setup',
  'projects.settings.field.shellSetupDescription':
    'Shell commands run before the agent starts in each worktree task',
  'projects.settings.field.scriptSetup': 'Setup script',
  'projects.settings.field.scriptSetupLeaf': 'setup',
  'projects.settings.field.scriptRun': 'Run script',
  'projects.settings.field.scriptRunLeaf': 'run',
  'projects.settings.field.scriptTeardown': 'Teardown script',
  'projects.settings.field.scriptTeardownLeaf': 'teardown',
} as const;

type ProjectMessageKey = keyof typeof enUSProjectMessages;

export const zhCNProjectMessages: Record<ProjectMessageKey, string> = {
  // ── browser: toolbar ────────────────────────────────────────────────────
  'browser.back': '后退',
  'browser.forward': '前进',
  'browser.stop': '停止',
  'browser.reload': '重新加载',
  'browser.urlLabel': '浏览器地址',
  'browser.urlPlaceholder': '搜索或输入网址',
  'browser.copyScreenshot': '复制网页截图',
  'browser.actions': '浏览器操作',
  'browser.openExternally': '在外部打开',
  'browser.forceReload': '强制重新加载',
  'browser.openDevTools': '打开开发者工具',
  'browser.profile': '浏览器配置',
  'browser.isolatedPerTask': '每个会话独立',
  'browser.manageProfiles': '管理配置…',
  'browser.zoom': '缩放',
  'browser.zoomOut': '缩小',
  'browser.zoomIn': '放大',
  'browser.resetZoom': '重置缩放',
  'browser.fitToWidth': '适应面板宽度',
  'browser.clearCookies': '清除 Cookie',
  'browser.clearCache': '清除缓存',
  'browser.clearStorage': '清除浏览器存储',

  // ── browser: URL rejection (protocol reason mapped at the boundary) ─────
  'browser.urlRejected.empty': '请输入网址',
  'browser.urlRejected.fileUrl': '此浏览器未启用 file 网址',
  'browser.urlRejected.protocol': '不支持该网址协议',
  'browser.urlRejected.invalid': '请输入有效的网址',

  // ── browser: pane, tab, start page, diagnostics ────────────────────────
  'browser.sessionUnavailable': '浏览器会话不可用',
  'browser.preparingSession': '正在准备浏览器会话',
  'browser.agentDriving': 'agent 正在操作这个页面',
  'browser.agentPaused': '你接管了这个页面，agent 已暂停',
  'browser.agentStop': '停止',
  'browser.agentResume': '让 agent 继续',
  'browser.tabFallbackTitle': '新标签页',
  'browser.tools': '工具',
  'browser.newPage': '新建页面',
  'browser.localServers': '本地服务',
  'browser.serverPort': '端口 {port}',
  'browser.diagnostics': '诊断',
  'browser.clearDiagnostics': '清空',

  // ── browser: toolbar action feedback ───────────────────────────────────
  'browser.screenshotCopied': '截图已复制到剪贴板',
  'browser.screenshotFailed': '无法截图',
  'browser.clearDataFailed': '无法清除浏览器数据',
  'browser.clearDataFailedDetail': '请重试，或手动重新加载浏览器视图。',
  'browser.clearDataRequestFailed': '清除浏览器数据的请求失败。',
  'browser.clearStorageTitle': '清除浏览器存储？',
  'browser.clearStorageDescription':
    '这会清除 {profileLabel} 的 Cookie、本地存储、IndexedDB 和缓存。使用同一存储边界的浏览器标签页将被登出。',
  'browser.clearStorageConfirm': '清除存储',

  // ── browser: load errors (Chromium ERR_* / numeric code stay raw) ───────
  'browser.loadError.code': '错误 {code}',
  'browser.loadError.fallbackHost': '该站点',
  'browser.loadError.unreachable': '无法访问此网站',
  'browser.loadError.nameNotResolved': '找不到 {host} 的服务器 IP 地址。',
  'browser.loadError.connectionRefused': '{host} 拒绝了连接。',
  'browser.loadError.timedOut': '{host} 响应时间过长。',
  'browser.loadError.connectionInterrupted': '与 {host} 的连接被中断。',
  'browser.loadError.addressUnreachable': '无法连接到 {host}。',
  'browser.loadError.noInternetHeading': '无网络连接',
  'browser.loadError.noInternetDetail': '你似乎已离线。',
  'browser.loadError.networkChanged': '你的网络连接已改变。',
  'browser.loadError.insecureHeading': '此网站无法提供安全连接',
  'browser.loadError.insecureDetail': '{host} 返回了无效的响应。',
  'browser.loadError.certHeading': '你的连接不是私密连接',
  'browser.loadError.certDetail': '{host} 的安全证书不受信任。',
  'browser.loadError.invalidUrl': '该网址无效。',
  'browser.loadError.genericDetail': '无法加载 {host}。',

  // ── projects: home, titlebar and view shell ────────────────────────────
  'projects.home.hero': '我们应该在 {projectName} 中做些什么？',
  'projects.home.connecting': '正在连接项目，就绪后即可发送…',
  'projects.folders.meta': '{folders} 个文件夹 · {sessions} 个会话',
  'projects.folders.agentTotal': '共 {count} 个 Agent',
  'projects.folders.agentCount': '共 {count} 位',
  'projects.folders.scopeUnavailable': '所选设备的文件夹暂不可用，请检查连接或更换设备范围。',
  'projects.folders.addMachine': '添加新设备…',
  'projects.folders.offline': '离线',
  'projects.folders.deviceScope': '设备范围',
  'projects.folders.deviceScopeHint': '可选文件夹所在设备：{devices}',
  'projects.folders.allDevices': '全部项目设备',
  'projects.folders.scopeExecutionHint': '圈定可用设备，再选择这次会话开工的文件夹。',
  'projects.folders.deviceCount': '{count} 台设备',
  'projects.folders.agentMore': '另有 {count} 个 Agent',
  'projects.folders.running': '{count} 个在跑',
  'projects.folders.runningHere': '{count} 个会话在这儿跑',
  'projects.folders.idleHere': '还没有会话',
  'projects.folders.sessionsHere': '{count} 个会话',
  'projects.folders.root': '项目根目录',
  'projects.folders.fresh': '刚挂上',
  'projects.folders.hintClosed': '点卡片摊开这个项目挂的 {count} 个文件夹 · 点其中一张，新任务就从那儿开工',
  'projects.folders.hintOpen': '点其中一张，新任务就从那儿开工 · 再点卡片收起',
  'projects.folders.hintFloating': '点其中一张，新任务就从那儿开工 · 直接打字或按 Esc，它就收起',
  'projects.folders.attach': '挂一个文件夹',
  'projects.folders.cardLabel': '「{projectName}」的文件夹',
  'projects.folders.dropHint': '松手 = 挂进「{projectName}」',
  'projects.folders.loadFailed': '读不到这个项目的文件夹',
  'projects.folders.loading': '正在读取文件夹…',
  'projects.folders.retry': '重试',
  'projects.folders.thisComputer': '这台电脑',
  'projects.folders.attachDialogTitle': '挂一个文件夹到「{projectName}」',
  'projects.folders.attachDialogMessage': '挂上后它就是这个项目的一部分，新会话可以从那儿开工。',
  'projects.folders.attached': '已把 {path} 挂进「{projectName}」',
  'projects.folders.detached': '{path} 不再挂在「{projectName}」下',
  'projects.folders.undo': '撤销',
  'projects.folders.detach': '从项目中摘除',
  'projects.folders.errorDetach': '没摘除成功，再试一次',
  'projects.folders.errorNotDirectory': '只能挂文件夹',
  'projects.folders.errorIsProjectRoot': '这个文件夹本身就是项目「{projectName}」',
  'projects.folders.errorOtherProject': '这个文件夹已经挂在项目「{projectName}」下',
  'projects.folders.errorAttach': '没挂上，再试一次',
  'projects.folders.pickerTitle': '从哪个文件夹开工',
  'projects.folders.attachOn': '挂到哪台机器上的文件夹',
  'projects.folders.attachedOn': '已把 {machine} 上的 {path} 挂进「{projectName}」',
  'projects.folders.mergeTitle': '把「{name}」并进「{projectName}」？',
  'projects.folders.mergeDescription': '{machine} 上的项目「{name}」已经有 {count} 个会话。并进来以后，这些会话的 agent 会进「{projectName}」的项目群；它原来的群不删，留作历史。',
  'projects.folders.mergeConfirm': '并进来',
  'projects.titlebar.remove': '移除项目',
  'projects.fallbackName': '此项目',

  // ── projects: mount failure panels ─────────────────────────────────────
  'projects.error.setupFailed': '项目设置失败',
  'projects.error.openFailed': '无法打开项目',
  'projects.error.notFoundAtPath': '在 {path} 找不到项目',
  'projects.error.configuredPath': '配置的路径',
  'projects.notFound.title': '找不到项目',
  'projects.notFound.detail': '配置路径下的项目目录已不存在。',
  'projects.accessBlocked.title': '读不到项目目录',
  'projects.accessBlocked.detail':
    '读取目录超时。在 macOS 上，请在隐私设置中允许访问该位置后重试。',
  'projects.accessBlocked.openSettings': '打开隐私设置',
  'projects.error.retry': '重试',

  // ── projects: pending creation ─────────────────────────────────────────
  'projects.pending.creatingRepo': '正在创建仓库',
  'projects.pending.cloning': '正在克隆',
  'projects.pending.registering': '正在注册',
  'projects.pending.genericError': '发生错误',
  'projects.pending.dismiss': '关闭',

  // ── projects: add-project modal ────────────────────────────────────────
  'projects.add.configImported': '已导入 {label} 配置',
  'projects.add.configImportedDetail': '已成功导入 {files}。',

  // ── projects: directory browser ────────────────────────────────────────
  'projects.remoteDir.empty': '空目录',
  'projects.remoteDir.listLabel': '目录内容',
  'projects.remoteDir.loading': '正在读取目录',
  'projects.remoteDir.useThis': '使用此目录',
  'projects.remoteDir.selectDirectory': '选择目录',

  // ── projects: directory tree (web local folder picker) ────────────────
  'projects.dirTree.label': '文件夹',
  'projects.dirTree.loadFailed': '读取失败',
  'projects.dirTree.homeUnavailable': '找不到宿主的家目录',
  'projects.dirTree.notAGitRepo': '该目录不是 git 仓库，将直接在其中工作（agent 可按需自行初始化）。',

  // ── projects: GitHub account select ────────────────────────────────────
  // "GitHub CLI" and "OAuth" are proper nouns and stay verbatim.
  'projects.github.sourceDeviceFlow': '设备流',
  'projects.github.sourceSavedToken': '已保存的令牌',
  'projects.github.default': '默认',

  // ── projects: creation entry points ────────────────────────────────────
  'projects.create.nameTitle': '为项目命名',
  'projects.create.nameTitleOnMachine': '在 {machine} 上新建项目',
  'projects.create.nameLabel': '项目名称',
  'projects.create.cancel': '取消',
  'projects.create.pickFolderTitle': '使用现有文件夹',
  'projects.create.pickFolderMessage': '选择要作为项目使用的文件夹',
  'projects.create.folderUnusable': '无法使用此文件夹',
  'projects.create.folderNameUnreadable': '无法从路径中读取文件夹名称',
  'projects.create.folderUnusableDetail': '确认这个文件夹还在、且你能读写它；也可以换一个文件夹。',
  'projects.create.blankProject': '新建空白项目',
  'projects.create.existingFolder': '使用现有文件夹',
  'projects.create.creating': '创建中…',
  'projects.create.save': '保存',
  'projects.create.failed': '项目创建失败',
  'projects.create.providerLocal': '本地',
  'projects.create.providerSsh': 'SSH',
  'projects.create.pathConflict':
    '所选路径已被{provider}项目“{name}”（{id}）占用。请先删除或移动该项目，再创建新项目。',
  'projects.create.noDefaultDirectory': '未配置默认项目目录，请先到设置中配置',
  'projects.create.invalidName': '项目名称不能包含路径分隔符或系统保留字符',

  // ── projects: delete confirmation ──────────────────────────────────────
  'projects.delete.title': '删除项目',
  'projects.delete.confirm': '删除',
  'projects.delete.description': '将删除“{projectLabel}”。项目里的会话（包括已归档的）会一并永久删除，不能从会话历史里恢复。项目文件夹与 worktree 仍会保留在文件系统上。',
  'projects.delete.detachWarning_one': '该自动化将从项目分离，并在挂到其他项目之前不会运行：',
  'projects.delete.detachWarning_other': '这些自动化将从项目分离，并在挂到其他项目之前不会运行：',

  // ── projects: task list ────────────────────────────────────────────────

  // ── projects: pull requests ────────────────────────────────────────────
  // PR titles, branches, numbers and author logins are raw GitHub data.

  // ── projects: settings view ────────────────────────────────────────────
  // ".gugu.json" is the real file name and stays literal in both locales.
  'projects.settings.detectedExternalConfig': '检测到外部项目配置。',
  'projects.settings.importInto': '导入到 {appName}',
  'projects.settings.importTitle': '导入项目配置',
  'projects.settings.selectConfig': '选择配置',
  'projects.settings.settingsToImport': '要导入的设置',
  'projects.settings.saveTo': '保存到',
  'projects.settings.destinationLocal': '设置',
  'projects.settings.destinationLocalHint': '— 仅本机',
  'projects.settings.destinationSharedHint': '— 提交后与团队共享',
  'projects.settings.shareWithTeam': '与团队共享',
  'projects.settings.shareTooltip':
    '把所选设置写入 .gugu.json。提交该文件即可与团队共享这些默认配置。',
  'projects.settings.resetChanges': '重置更改',
  'projects.settings.shareTitle': '与团队共享设置',
  'projects.settings.shareDescription':
    '这会把所选设置写入所选工作目录下的 .gugu.json。提交该文件，队友拉取后即可获得相同的项目默认配置。',
  'projects.settings.writeTo': '写入到',
  'projects.settings.settingsToShare': '要共享的设置',
  'projects.settings.cancel': '取消',
  'projects.settings.teamConfigShared': '团队配置已共享',
  'projects.settings.teamConfigSharedDetail': '.gugu.json 已成功写入。',
  'projects.settings.overriding': '覆盖中',
  'projects.settings.overridesIn': '这会覆盖 {count} 中的 {teamConfigLabel}。',
  'projects.settings.useTeamSettingsFor': '对 {label} 使用团队设置',
  'projects.settings.useTeamSettings': '使用团队设置',

  // ── projects: settings fields ──────────────────────────────────────────
  'projects.settings.githubAccount': 'GitHub 账号',
  'projects.settings.githubAccountDescription': '用于此项目的拉取请求和议题。',
  'projects.settings.githubAccountUnavailable': 'GitHub 账号不可用',
  'projects.settings.githubAccountDisconnected': '已断开连接',
  'projects.settings.noGithubAccount': '没有 GitHub 账号',
  'projects.settings.defaultBranch': '默认分支',
  'projects.settings.defaultBranchDescription': '新会话默认从该分支创建。',
  'projects.settings.baseRemote': '基础远程仓库',
  'projects.settings.baseRemoteDescription':
    '用于拉取远程分支、选择会话基础分支以及指定拉取请求的目标。',
  'projects.settings.pushRemote': '推送远程仓库',
  'projects.settings.pushRemoteDescription': '用于发布会话分支和推送提交。',
  'projects.settings.sameAsBaseRemote': '与基础远程仓库相同',
  'projects.settings.enableTmux': '启用 tmux',
  'projects.settings.enableTmuxDescription': '在 tmux 会话中运行 agent 会话。',
  'projects.settings.lifecycleScripts': '生命周期脚本',
  'projects.settings.lifecycleScriptsDescription':
    '在 worktree 生命周期各阶段运行的 shell 命令，每行一条。两者都设为自动运行时，Run 脚本会等待 Setup 完成。',
  'projects.settings.autoRunOnTaskCreation': '创建会话时自动运行',

  // ── projects: shareable field descriptors ──────────────────────────────
  // The placeholders stay literal: they are runnable command / glob examples.
  'projects.settings.field.preservePatterns': '保留文件模式',
  'projects.settings.field.preservePatternsLeaf': '保留文件模式',
  'projects.settings.field.preservePatternsDescription':
    '匹配这些 glob 模式的、被 gitignore 或未跟踪的文件，会从主仓库复制到每个 worktree。每行一条模式。',
  'projects.settings.field.shellSetup': 'Shell 初始化',
  'projects.settings.field.shellSetupLeaf': 'shell 初始化',
  'projects.settings.field.shellSetupDescription': '在每个 worktree 会话中 agent 启动前运行的 shell 命令',
  'projects.settings.field.scriptSetup': 'Setup 脚本',
  'projects.settings.field.scriptSetupLeaf': 'setup',
  'projects.settings.field.scriptRun': 'Run 脚本',
  'projects.settings.field.scriptRunLeaf': 'run',
  'projects.settings.field.scriptTeardown': 'Teardown 脚本',
  'projects.settings.field.scriptTeardownLeaf': 'teardown',
};
