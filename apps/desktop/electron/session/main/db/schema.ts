import { isNotNull, sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';
import { versionedJsonColumn } from '@main/db/versioned-column';
import {
  automationAgentConfig,
  automationTriggerConfig,
  storedAutomationSessionConfig,
} from '@shared/core/automations/config';
import { sessionConfig } from '@shared/core/sessions/session-config';
import { linkedIssue } from '@shared/core/linked-issue';
import { providerAccountMeta } from '@shared/core/provider-accounts/provider-account-meta';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';
import { workspaceConfig } from '@shared/core/workspaces/workspace-config';
import { workspaceProviderData } from '@shared/core/workspaces/workspace-provider-data';

export const activityEvents = sqliteTable('activity_events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  eventId: text('event_id').notNull().unique(),
  occurredAt: integer('occurred_at'),
  observedAt: integer('observed_at').notNull(),
  kind: text('kind').notNull(),
  sessionId: text('session_id'),
  projectId: text('project_id'),
  data: text('data').notNull(),
}, table => ({ time: index('activity_events_time').on(table.occurredAt, table.seq),
  session: index('activity_events_session').on(table.sessionId, table.seq),
  project: index('activity_events_project').on(table.projectId, table.seq) }));

export const activityCoverage = sqliteTable('activity_coverage', {
  id: text('id').primaryKey(),
  startedAt: integer('started_at').notNull(),
  lastSeenAt: integer('last_seen_at').notNull(),
  endedAt: integer('ended_at'),
});

/** Written by a trigger on `sessions` (migration 0038); the activity journal reads it to place events in projects. */
export const activitySessionProjects = sqliteTable('activity_session_projects', {
  sessionId: text('session_id').primaryKey(),
  projectId: text('project_id').notNull(),
});

/**
 * SSH 远程已下架(#6264):表与引用它的列只为保留旧行而留在库里,产品代码不再读写。
 */
export const sshConnections = sqliteTable(
  'ssh_connections',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    host: text('host').notNull(),
    port: integer('port').notNull().default(22),
    username: text('username').notNull(),
    authType: text('auth_type').notNull().default('agent'), // 'password' | 'key' | 'agent'
    privateKeyPath: text('private_key_path'), // optional, for key auth
    useAgent: integer('use_agent').notNull().default(0), // boolean, 0=false, 1=true
    metadata: text('metadata'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameIdx: uniqueIndex('idx_ssh_connections_name').on(table.name),
    hostIdx: index('idx_ssh_connections_host').on(table.host),
  })
);

export const projects = sqliteTable(
  'projects',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    path: text('path').notNull(),
    workspaceProvider: text('workspace_provider').notNull().default('local'), // 'local' | 'ssh'
    baseRef: text('base_ref'),
    // gugu #2358: 非 git 项目标记。base_ref 自 0000 起就 nullable + 读路径 `?? 'main'` 兜底
    // （旧版本建的 git 项目 base_ref 也可能为 null），故不能用 base_ref===null 当非 git
    // 标记（会与 legacy null-git 撞车）。显式布尔列消歧:仅本列 true = 非 git,读路径据此把
    // baseRef 还原成 null（见 getProjects），既存行默认 false → 一律按 git 处理,不误伤。
    gitless: integer('gitless', { mode: 'boolean' }).notNull().default(false),
    sshConnectionId: text('ssh_connection_id').references(() => sshConnections.id, {
      onDelete: 'set null',
    }),
    /** The shared workspace representing this project's repository root. Set on first mount. */
    repositoryWorkspaceId: text('repository_workspace_id'),
    /** The root workspace remains available to historical sessions after its folder is detached. */
    rootFolderDetached: integer('root_folder_detached', { mode: 'boolean' }).notNull().default(false),
    /** Project removal hides its directory memberships without discarding them. */
    archivedAt: text('archived_at'),
    /** #609: 'project' = the person created or opened it; 'workspace' = a directory the app keeps for its own needs. */
    kind: text('kind').$type<'project' | 'workspace'>().notNull().default('project'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    pathIdx: uniqueIndex('idx_projects_path').on(table.path),
    sshConnectionIdIdx: index('idx_projects_ssh_connection_id').on(table.sshConnectionId),
  })
);

export const projectRemotes = sqliteTable(
  'project_remotes',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    remoteName: text('remote_name').notNull(),
    remoteUrl: text('remote_url').notNull(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.projectId, table.remoteName] }),
  })
);

export const projectSettings = sqliteTable('project_settings', {
  projectId: text('project_id')
    .primaryKey()
    .references(() => projects.id, { onDelete: 'cascade' }),
  baseProjectSettingsJson: text('base_project_settings_json').notNull().default('{}'),
  shareableProjectSettingsJson: text('shareable_project_settings_json').notNull().default('{}'),
  legacyConfigMigratedAt: text('legacy_config_migrated_at'),
  createdAt: text('created_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
  updatedAt: text('updated_at')
    .notNull()
    .default(sql`CURRENT_TIMESTAMP`),
});

export const appSettings = sqliteTable(
  'app_settings',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    keyIdx: uniqueIndex('idx_app_settings_key').on(table.key),
  })
);

export const workspaces = sqliteTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    key: text('key'),
    type: text('type').notNull().$type<'local' | 'project-ssh' | 'byoi'>(), // @deprecated — use kind + location
    /** Describes the nature of the workspace: a git worktree, the project root, a folder attached to a project (`path`), or BYOI. */
    kind: text('kind').$type<'worktree' | 'project-root' | 'path' | 'byoi'>(),
    /** Where the workspace runs: on the local machine or over SSH. */
    location: text('location').$type<'local' | 'remote'>(),
    /** FK to ssh_connections; only set when location = 'remote'. */
    sshConnectionId: text('ssh_connection_id').references(() => sshConnections.id, {
      onDelete: 'set null',
    }),
    data: versionedJsonColumn(workspaceProviderData)('data'),
    path: text('path'),
    config: versionedJsonColumn(workspaceConfig)('config'),
    branchName: text('branch_name'),
    linesAdded: integer('lines_added'),
    linesDeleted: integer('lines_deleted'),
    /**
     * #7341 这个文件夹挂在哪个项目下(product spec「挂文件夹」)。根目录**不**记在这里 ——
     * 它由 `projects.repositoryWorkspaceId` 指着;null = 没挂在任何项目下。
     */
    projectId: text('project_id').references(() => projects.id, { onDelete: 'set null' }),
    /** 挂上的时间(ISO);挂上时写、摘下时清。只在 `projectId` 有值时有意义(项目删了外键只清 `projectId`)。 */
    attachedAt: text('attached_at'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    keyIdx: uniqueIndex('idx_workspaces_key').on(table.key).where(isNotNull(table.key)),
    projectIdIdx: index('idx_workspaces_project_id').on(table.projectId),
  })
);

export const pullRequestUsers = sqliteTable('pull_request_users', {
  userId: text('user_id').primaryKey(),
  userName: text('user_name').notNull(),
  displayName: text('display_name'),
  avatarUrl: text('avatar_url'),
  url: text('url'),

  userUpdatedAt: text('user_updated_at'),
  userCreatedAt: text('user_created_at'),
});

export const pullRequests = sqliteTable(
  'pull_requests',
  {
    url: text('url').primaryKey(),
    provider: text('provider').notNull().default('github'),
    repositoryUrl: text('repository_url').notNull(),

    baseRefName: text('base_ref_name').notNull(),
    baseRefOid: text('base_ref_oid').notNull(),

    headRepositoryUrl: text('head_repository_url').notNull(),
    headRefName: text('head_ref_name').notNull(),
    headRefOid: text('head_ref_oid').notNull(),

    identifier: text('identifier'), // #123 for github
    title: text('title').notNull(),
    description: text('description'),
    status: text('status').notNull().default('open'),
    isDraft: integer('is_draft'),

    authorUserId: text('author_user_id').references(() => pullRequestUsers.userId, {
      onDelete: 'set null',
    }),

    additions: integer('additions'),
    deletions: integer('deletions'),
    changedFiles: integer('changed_files'),
    commitCount: integer('commit_count'),

    mergeableStatus: text('mergeable_status'),
    mergeStateStatus: text('merge_state_status'),
    reviewDecision: text('review_decision'),

    pullRequestCreatedAt: text('pull_request_created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    pullRequestUpdatedAt: text('pull_request_updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    urlIdx: uniqueIndex('idx_pull_requests_url').on(table.url),
    repositoryUrlIdx: index('idx_pull_requests_repository_url').on(table.repositoryUrl),
    headRepositoryUrlIdx: index('idx_pull_requests_head_repository_url').on(
      table.headRepositoryUrl
    ),
  })
);

export const pullRequestLabels = sqliteTable(
  'pull_request_labels',
  {
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.url, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    color: text('color'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pullRequestId, table.name] }),
    nameIdx: index('idx_prl_name').on(table.name),
  })
);

export const pullRequestAssignees = sqliteTable(
  'pull_request_assignees',
  {
    pullRequestUrl: text('pull_request_url')
      .notNull()
      .references(() => pullRequests.url, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => pullRequestUsers.userId, { onDelete: 'cascade' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.pullRequestUrl, table.userId] }),
    pullRequestUrlIdx: index('idx_pra_pull_request_url').on(table.pullRequestUrl),
    userIdIdx: index('idx_pra_user_id').on(table.userId),
  })
);

export const pullRequestChecks = sqliteTable(
  'pull_request_checks',
  {
    id: text('id').primaryKey(),
    pullRequestUrl: text('pull_request_url')
      .notNull()
      .references(() => pullRequests.url, { onDelete: 'cascade' }),
    commitSha: text('commit_sha').notNull(),
    name: text('name').notNull(),
    status: text('status').notNull(),
    conclusion: text('conclusion').notNull(),

    detailsUrl: text('details_url'),
    startedAt: text('started_at'),
    completedAt: text('completed_at'),
    workflowName: text('workflow_name'),
    appName: text('app_name'),
    appLogoUrl: text('app_logo_url'),
  },
  (table) => ({
    pullRequestUrlIdx: index('idx_prc_pull_request_url').on(table.pullRequestUrl),
  })
);

export const automations = sqliteTable(
  'automations',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    projectId: text('project_id').references(() => projects.id, {
      onDelete: 'set null',
    }),
    triggerConfig: versionedJsonColumn(automationTriggerConfig)('trigger_config'),
    agentConfig: versionedJsonColumn(automationAgentConfig)('agent_config'),
    sessionConfig: versionedJsonColumn(storedAutomationSessionConfig)('session_config'),
    enabled: integer('enabled').notNull().default(1),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    /**
     * #7221 非空 = agent 给自己排的:到点把 prompt 送回这条会话,不新开会话。
     * No FK cascade: true deletion uses the automation service's run cleanup/barrier; list load repairs older orphans.
     * Archiving retains this identity and its schedule so Restore can show it again.
     */
    agentSessionId: text('agent_session_id'),
  },
  (table) => ({
    projectIdIdx: index('idx_automations_project_id').on(table.projectId),
    agentSessionIdx: index('idx_automations_agent_session_id').on(table.agentSessionId),
  })
);

export const automationRuns = sqliteTable(
  'automation_runs',
  {
    id: text('id').primaryKey(),
    automationId: text('automation_id')
      .notNull()
      .references(() => automations.id, { onDelete: 'cascade' }),
    scheduledAt: integer('scheduled_at'),
    deadlineAt: integer('deadline_at'),
    startedAt: integer('started_at'),
    sessionCreatedAt: integer('session_created_at'),
    launchedAt: integer('launched_at'),
    finishedAt: integer('finished_at'),
    status: text('status').notNull(),
    error: text('error'),
    triggerKind: text('trigger_kind').notNull(),
    triggerConfigSnapshot: text('trigger_config_snapshot').notNull().default('{}'),
    agentConfigSnapshot: text('agent_config_snapshot').notNull().default('{}'),
    sessionConfigSnapshot: text('session_config_snapshot'),
    generatedSessionName: text('generated_session_name'),
  },
  (table) => ({
    automationStartedIdx: index('idx_automation_runs_automation_started').on(
      table.automationId,
      table.startedAt
    ),
    automationScheduledIdx: index('idx_automation_runs_automation_scheduled').on(
      table.automationId,
      table.scheduledAt
    ),
    automationStatusIdx: index('idx_automation_runs_automation_status').on(
      table.automationId,
      table.status
    ),
    statusIdx: index('idx_automation_runs_status').on(table.status),
    statusScheduledIdx: index('idx_automation_runs_status_scheduled').on(
      table.status,
      table.scheduledAt
    ),
  })
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    provider: text('provider'),
    config: versionedJsonColumn(sessionConfig)('config'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    lastInteractedAt: text('last_interacted_at'),
    providerSessionId: text('provider_session_id'),
    agentStatus: text('agent_status'),
    agentStatusSeen: integer('agent_status_seen').default(1),
    /** spec agent-status「附属态」:显示用的细分(running / parked / approval / … / done / plain),可空。 */
    agentStatusDetail: text('agent_status_detail'),
    runtime: text('runtime'),
    // spec session-page: any conversation can be pinned; pinned rows leave their state group
    // and gather in the sidebar's Pinned section.
    isPinned: integer('is_pinned').notNull().default(0),
    parentSessionId: text('parent_session_id').references(
      (): AnySQLiteColumn => sessions.id,
      { onDelete: 'set null' }
    ),
    /**
     * The extension that started this conversation, when one did.
     *
     * A plain string, ❌ 不设外键:扩展卸载之后这条痕迹必须还在(behavior
     * tab-extensions:「卸载后照跑不误,标记留存并显示为『由已卸载的扩展 X 发起』」)。
     * 外键会把「发起者不在了」变成「发起者是 null」,而那正是用户最需要看见的
     * 那一条信息。
     */
    spawnedByExtensionId: text('spawned_by_extension_id'),
    spawnedBySessionId: text('spawned_by_session_id').references(
      (): AnySQLiteColumn => sessions.id,
      { onDelete: 'set null' }
    ),
    /**
     * spec session-graph:归档的归属键是**这条会话自己**。null = 在会话列表里,时间戳 = 已归档。
     * 会话可不可见只问这一列。
     */
    archivedAt: text('archived_at'),
    /** 这条会话在哪个工作区里干活。多条会话可以共享一个(spawn 出来的子会话就是这样)。 */
    workspaceId: text('workspace_id'),
    /** 新建会话时挑的 issue;首句会提及它,输入框里可以 @ 它。 */
    linkedIssue: versionedJsonColumn(linkedIssue)('linked_issue'),
    /** 有值 = 这条会话是这次自动化运行建出来的(非交互)。运行删了,会话留下、这一格置空。 */
    automationRunId: text('automation_run_id').references(() => automationRuns.id, {
      onDelete: 'set null',
    }),
  },
  (table) => ({
    workspaceIdIdx: index('idx_sessions_workspace_id').on(table.workspaceId),
    parentSessionIdIdx: index('idx_sessions_parent_session_id').on(
      table.parentSessionId
    ),
    spawnedByExtensionIdIdx: index('idx_sessions_spawned_by_extension_id').on(
      table.spawnedByExtensionId
    ),
    spawnedBySessionIdIdx: index('idx_sessions_spawned_by_session_id').on(
      table.spawnedBySessionId
    ),
  })
);

export const terminals = sqliteTable(
  'terminals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    ssh: integer('ssh').notNull().default(0), // boolean, 0=false, 1=true
    name: text('name').notNull(),
    shellId: text('shell_id').$type<TerminalShellId>().notNull().default('system'),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    updatedAt: text('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    sessionIdIdx: index('idx_terminals_session_id').on(table.sessionId),
  })
);

export const messages = sqliteTable(
  'messages',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    sender: text('sender').notNull(),
    timestamp: text('timestamp')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
    metadata: text('metadata'),
  },
  (table) => ({
    sessionIdIdx: index('idx_messages_session_id').on(table.sessionId),
    timestampIdx: index('idx_messages_timestamp').on(table.timestamp),
  })
);

/**
 * 会话历史的落盘（#5381）。一条已提交的回合一行，`data` 是那一回合的结构化条目
 * （消息 / 思考 / 工具调用），不是渲染好的文本。
 *
 * **为什么必须自己存**：从前会话页不存对话内容，历史唯一来源是恢复时的 ACP `session/load`
 * 重放。而重放完不完整取决于 provider —— 实测 `claude-agent-acp` 在上下文压缩之后只重放最后一次
 * 压缩边界之后的部分（6177 行的会话只推回 46 条），压缩前的消息就永久离开了界面。用户视角是
 * 「我重启了，我消息也丢了」，而这段对话在 agent 侧其实还在。把「用户会不会丢历史」交给
 * 二十多家 provider 各自决定，方向就是错的。
 *
 * **`seq` 由主进程分配，不复用运行时那份**。运行时的回合序号是「在当前这条 cell 里的位置」，
 * 重开会话后它从 0 重数——而重放只包含压缩后的一段，于是新回合的序号会与库里已有的撞号。
 * 写入时取 `max(seq)+1`，序即到达序。
 */
export const sessionTurns = sqliteTable(
  'session_turns',
  {
    /** `${conversationId}:${seq}` —— 一条会话内唯一，天然幂等。 */
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** 主进程分配的到达序，一条会话内单调递增。 */
    seq: integer('seq').notNull(),
    /** 运行时那侧的回合 id，仅作诊断与追溯用，❌ 不做跨重启的对齐键。 */
    turnId: text('turn_id').notNull(),
    /** 该回合的结构化条目，JSON。 */
    data: text('data').notNull(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    sessionSeqIdx: index('idx_session_turns_session_seq').on(
      table.sessionId,
      table.seq
    ),
  })
);

export type SessionTurnRow = typeof sessionTurns.$inferSelect;

/**
 * #6334 用量页:一条会话「在干活」(working / needs_user)的一段时间一行,时间是 epoch 毫秒。
 * `endedAt` 为 null = 还开着;`lastSeenAt` 是主进程每分钟的心跳,进程被强杀后下次开机按它收口。
 * ❌ 不挂外键:会话删了,它那天跑过的时长仍是那天的事实。写入方见 core/usage/run-interval-recorder.ts。
 */
export const sessionRunIntervals = sqliteTable(
  'session_run_intervals',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    provider: text('provider'),
    startedAt: integer('started_at').notNull(),
    endedAt: integer('ended_at'),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (table) => ({
    startedAtIdx: index('idx_session_run_intervals_started_at').on(table.startedAt),
    sessionEndedIdx: index('idx_session_run_intervals_session_ended').on(
      table.sessionId,
      table.endedAt
    ),
  })
);

/**
 * #6334 用量页:各家 CLI 日志文件的解析缓存(路径为键)。size + mtime 没变就不再读;
 * 只长不改的文件从 `data` 里记着的偏移接着读。形状见 core/usage/token-file-cache.ts。
 */
/**
 * #6334 用量页:会话每次启动时用的是咕咕模型('gugu')还是用户自己的账号('byok'),一次启动一行、
 * 与上一行相同则不记。Token 按时刻归到当时那一段(见 core/usage/model-source-recorder.ts)。
 */
export const sessionModelSources = sqliteTable(
  'session_model_sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    sessionId: text('session_id').notNull(),
    source: text('source').notNull(),
    startedAt: integer('started_at').notNull(),
  },
  (table) => ({
    sessionStartedIdx: index('idx_session_model_sources_session_started').on(
      table.sessionId,
      table.startedAt
    ),
  })
);

export const usageTokenFileCache = sqliteTable('usage_token_file_cache', {
  path: text('path').primaryKey(),
  size: integer('size').notNull(),
  mtimeMs: integer('mtime_ms').notNull(),
  provider: text('provider').notNull(),
  providerSessionId: text('provider_session_id').notNull(),
  data: text('data').notNull(),
});

/**
 * 输入框里拖/粘进来的附件(#5269)。
 *
 * **字节存一份在我们自己的地盘,❌ 不靠放宽某道访问边界去够别人的地盘。** 从前这些文件落在
 * `$TMPDIR/gugu-dropped-blobs`,消息里那条 mention 就长期指着一个临时文件:退出即清、24 小时
 * 扫一遍,于是历史消息里的附件迟早点不开;而临时目录又在 home 之外,连点开那一下都要给
 * `openPath` 的 home jail 开口子。落进 `<userData>/task-attachments/<会话 id>/` 两件事一起没了。
 * (目录名 `task-attachments` 是磁盘路径,不随概念改名;库里只认 `stored_path`,不按目录名猜归属。)
 *
 * `origin` 分两种,决定这一行**拥不拥有**盘上那个文件:
 * - `copy`      —— 粘贴/剪贴板/长文本收成的 .txt:除了我们没人存着这些字节,所以我们存一份,
 *                  文件归这一行所有,会话删了跟着删。
 * - `reference` —— 用户从访达拖进来的、他自己盘上的文件:那是他的东西,记一条指向就够,
 *                  ❌ 不拷贝(他可能正想让 agent 就地改它,拷贝反而给错了对象)。
 *
 * ⚠️ 行由 FK cascade 连坐删,但**盘上的文件不会跟着走** —— 删会话时要按行的 `stored_path` 显式删文件。
 */
export const sessionAttachments = sqliteTable(
  'session_attachments',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    /** 用户读的那个名字 —— ❌ 不是盘上的文件名(那个带 uuid)。 */
    name: text('name').notNull(),
    mimeType: text('mime_type'),
    size: integer('size').notNull(),
    /**
     * 绝对路径。新行恒指向**我们自己那一份**;`origin='reference'` 的历史行指向用户的文件
     * (那种行不再产生,见 0028)。
     */
    storedPath: text('stored_path').notNull(),
    /**
     * 用户自己盘上那个文件在哪(拖进来的才有;粘贴的没有,为 NULL)。
     *
     * 它与 `stored_path` 分工明确,❌ 别合并:**发给 agent 的 mention 用 `original_path`**
     * —— 用户拖一个文件进来往往是想让 agent 就地改它,指向副本就改错了对象;
     * **消息里的显示与点开用 `stored_path`** —— 副本在 userData 里,永远在、永远够得着,
     * 而原路径依赖两件我们管不了的事(文件还在不在、在不在 home 里,home 之外 openPath 直接判死)。
     */
    originalPath: text('original_path'),
    origin: text('origin').notNull().$type<'copy' | 'reference'>(),
    createdAt: text('created_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    sessionIdIdx: index('idx_session_attachments_session_id').on(table.sessionId),
  })
);

export const editorBuffers = sqliteTable(
  'editor_buffers',
  {
    id: text('id').primaryKey(), // `${projectId}:${workspaceId}:${filePath}`
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').notNull(),
    filePath: text('file_path').notNull(),
    content: text('content').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    workspaceFileIdx: index('idx_editor_buffers_workspace_file').on(
      table.workspaceId,
      table.filePath
    ),
  })
);

export const kv = sqliteTable(
  'kv',
  {
    key: text('key').primaryKey(),
    value: text('value').notNull(),
    updatedAt: integer('updated_at')
      .notNull()
      .default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    keyIdx: uniqueIndex('idx_kv_key').on(table.key),
  })
);

export const providerAccounts = sqliteTable(
  'provider_accounts',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    accountId: text('account_id').notNull(),
    credentialRef: text('credential_ref').notNull(),
    isDefault: integer('is_default', { mode: 'boolean' }).notNull().default(false),
    meta: versionedJsonColumn(providerAccountMeta)('meta'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => ({
    accountIdx: uniqueIndex('idx_provider_accounts_provider_account').on(
      table.providerId,
      table.accountId
    ),
    defaultIdx: uniqueIndex('idx_provider_accounts_default')
      .on(table.providerId)
      .where(sql`is_default = 1`),
  })
);

export const appSecrets = sqliteTable(
  'app_secrets',
  {
    key: text('key').primaryKey(),
    secret: text('secret').notNull(),
  },
  (table) => ({
    keyIdx: uniqueIndex('idx_app_secrets_key').on(table.key),
  })
);

export type SshConnectionRow = typeof sshConnections.$inferSelect;
export type SshConnectionInsert = typeof sshConnections.$inferInsert;
export type ProjectRow = typeof projects.$inferSelect;
export type AutomationRow = typeof automations.$inferSelect;
export type AutomationRunRow = typeof automationRuns.$inferSelect;
export type ProjectSettingsRow = typeof projectSettings.$inferSelect;
export type ProjectSettingsInsert = typeof projectSettings.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type TerminalRow = typeof terminals.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type EditorBufferRow = typeof editorBuffers.$inferSelect;
export type EditorBufferInsert = typeof editorBuffers.$inferInsert;
export type KvRow = typeof kv.$inferSelect;
export type KvInsert = typeof kv.$inferInsert;
export type AppSecretRow = typeof appSecrets.$inferSelect;
export type AppSecretInsert = typeof appSecrets.$inferInsert;
export type ProviderAccountRow = typeof providerAccounts.$inferSelect;
export type ProviderAccountInsert = typeof providerAccounts.$inferInsert;
export type WorkspaceRow = typeof workspaces.$inferSelect;
export type WorkspaceInsert = typeof workspaces.$inferInsert;
