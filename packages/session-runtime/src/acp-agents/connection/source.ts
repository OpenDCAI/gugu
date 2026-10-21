import type { Client } from '@agentclientprotocol/sdk';
import type { AcpPlatformInjection, AdapterExit, AgentRunContext } from '@gugu/session-core/acp';
import { acpErr } from '@gugu/session-core/acp';
import type { AcpProcessHost } from '@gugu/session-core/acp/node';
import type {
  AcpAgentApi,
  AgentHostError,
  AgentPluginHost,
  IAcpBehavior,
} from '@gugu/session-core/agents/plugins';
import { SessionRuntimeCompatibilityError } from '@gugu/session-core/agents/plugins';
import { isErr, toSerializedError } from '@gugu/session-shared';
import type { Logger } from '@gugu/session-shared/logger';
import { createManagedSource, type ManagedSource, type Scope } from '@gugu/session-wire/util';
import {
  createAcpAgentConnection,
  type AcpConnectionError,
  type AcpSessionUpdateNormalizer,
} from './acp-agent-connection';

type AcpConnectionProcessHost = Pick<AcpProcessHost, 'spawn' | 'spawnTerminal'>;

export interface AcpConnectionContext {
  key: string;
  providerId: string;
  workspaceId: string;
  cwd: string;
  normalize: AcpSessionUpdateNormalizer;
}

export interface AcpConnectionEntry extends AcpConnectionContext {
  agent: AcpAgentApi;
  supportsLoadSession: boolean;
  supportsForkSession: boolean;
  /** 见 AcpAgentConnection.supportsImagePrompt:决定图片附件能不能走 ACP 这条路。 */
  supportsImagePrompt: boolean;
  /** initialize._meta.steering.supported: route busy steering through the ACP extension. */
  supportsSteering: boolean;
  /** 见 AcpAgentConnection.reportsState。 */
  reportsState: boolean;
  /** 这个受管进程的 pid(spawn 当场绑定);重载判据用它,见 AcpAgentConnection.pid。 */
  pid: number | null;
}

export type PooledAcpProcess = AcpConnectionEntry;

export interface CreateAcpConnectionSourceDeps {
  host: AcpConnectionProcessHost;
  agentHost: AgentPluginHost;
  logger: Logger;
  onClosed: (key: string, exit: AdapterExit) => void;
}

export interface AcquireAcpConnectionInput {
  providerId: string;
  workspaceId: string;
  cwd: string;
  behavior: IAcpBehavior;
  /** Host-resolved executable for this session start (#5681). */
  runContext: AgentRunContext;
  platform?: AcpPlatformInjection;
  capabilitySpawnEnv?: Readonly<Record<string, string>>;
  capabilitySpawnArgs?: readonly string[];
  buildClient: (agent: AcpAgentApi, context: AcpConnectionContext) => Client;
  /** 进程 stderr 的每一整行(见 `IAcpBehavior.turnFailure`)。 */
  onStderrLine?: (line: string) => void;
  /** 启动走到了哪一步(版本探针 / 起引擎)—— 属主据此让等待看得见(#6183)。 */
  onStage?: (stage: 'checking-executable' | 'starting-engine', executable: string | null) => void;
}

export type AcpConnectionSource = ManagedSource<
  string,
  PooledAcpProcess,
  AcquireAcpConnectionInput
>;

export function createAcpConnectionSource(
  deps: CreateAcpConnectionSourceDeps
): AcpConnectionSource {
  const source: AcpConnectionSource = createManagedSource<
    string,
    PooledAcpProcess,
    AcquireAcpConnectionInput
  >({
    key: (key) => key,
    create: (key, input, scope) => provisionAcpConnection(deps, key, input, scope),
    onError: (error, key) => {
      // ⚠️ 这条路上抛的是 `provisionAcpConnection` 自己的结构化错误(`{type, cause}`),
      //    **不是 Error 实例**。`String()` 和 `toSerializedError()`(对非 Error 也走 `String()`)
      //    都会把它渲染成 `[object Object]` —— #6183 真机日志里就只剩这五个字,
      //    而同一时刻 renderer 那一侧手里的是完整的 `initialize_failed` + cause。
      //    ⇒ 已经是可序列化的结构化错误就原样记;只有意外的 Error 才需要序列化。
      deps.logger.warn('AcpConnectionSource: provisioning failed', {
        key,
        error: isAcpConnectionError(error) ? error : toSerializedError(error),
      });
    },
  });
  return source;
}

export function makeAcpConnectionKey(
  providerId: string,
  workspaceId: string,
  sessionId: string,
): string {
  // Every ACP conversation owns its adapter process. The managed source still coalesces
  // overlapping acquires for this exact key, which preserves single-flight startup per session.
  return `${providerId}:${workspaceId}:session:${sessionId}`;
}

export function isAcpConnectionError(error: unknown): error is AcpConnectionError {
  if (typeof error !== 'object' || error === null) return false;
  const type = (error as { type?: unknown }).type;
  return type === 'spawn_failed' || type === 'initialize_failed';
}

async function provisionAcpConnection(
  deps: CreateAcpConnectionSourceDeps,
  key: string,
  input: AcquireAcpConnectionInput,
  scope: Scope
): Promise<PooledAcpProcess> {
  // 这条连接的寿命就是这个 scope:启动被放弃(会话停止 / 删除 / 应用退出)时它被销毁,
  // 仍在跑的版本探针随之收掉。启动路上没有任何时钟,放弃等待只有这一个入口。
  const started = new AbortController();
  scope.add(() => started.abort(new Error('ACP session start was abandoned by its owner')));
  input.onStage?.(
    'checking-executable',
    input.runContext.cli.kind === 'resolved' ? input.runContext.cli.path : null,
  );
  const spawn = await deps.agentHost.buildAcpSpawn(input.providerId, {
    cwd: input.cwd,
    runContext: input.runContext,
    platform: input.platform,
    capabilitySpawnEnv: input.capabilitySpawnEnv,
    capabilitySpawnArgs: input.capabilitySpawnArgs,
    signal: started.signal,
  });
  if (!spawn.success) {
    const failure = toSerializedError(new Error(agentHostErrorMessage(spawn.error)));
    // 版本低于下界:两个数原样带过边界,界面才说得出「需要 X,现在是 Y」(与终端腿 #6341 同一份提示)。
    const versionBlock = spawn.error instanceof SessionRuntimeCompatibilityError
      && spawn.error.code === 'runtime-version-unsupported'
      && spawn.error.installedVersion
      && spawn.error.supportedFloor
      ? spawn.error
      : null;
    throw acpErr.spawnFailed(versionBlock
      ? {
          ...failure,
          code: versionBlock.code,
          data: {
            installedVersion: versionBlock.installedVersion!,
            supportedFloor: versionBlock.supportedFloor!,
            ...(versionBlock.probe?.executable ? { executable: versionBlock.probe.executable } : {}),
          },
        }
      : failure)
      .error;
  }

  // This is the task session-start boundary. Model catalog resolution uses the legacy free
  // resolver and never reaches this point, so it cannot produce a startup diagnostic.
  void deps.agentHost
    .probeAcpSpawnRuntimeIdentity(input.providerId, spawn.data)
    .then((identity) => {
      if (!identity) return;
      deps.logger.info('session/acp-start: harness runtime identity', { ...identity });
    })
    .catch((error) => {
      deps.logger.info('session/acp-start: harness runtime identity unavailable', {
        providerId: input.providerId,
        diagnosticError: String(error),
      });
    });

  input.onStage?.('starting-engine', spawn.data.command);
  const connection = await createAcpAgentConnection(
    {
      host: deps.host,
      behavior: input.behavior,
      logger: deps.logger,
    },
    {
      providerId: input.providerId,
      connectionKey: key,
      spawn: spawn.data,
      scope,
      buildClient: (agent, normalize) =>
        input.buildClient(agent, {
          key,
          providerId: input.providerId,
          workspaceId: input.workspaceId,
          cwd: input.cwd,
          normalize,
        }),
      onClosed: (exit) => deps.onClosed(key, exit),
      ...(input.onStderrLine ? { onStderrLine: input.onStderrLine } : {}),
    }
  );
  if (isErr(connection)) throw connection.error;

  return {
    key,
    providerId: input.providerId,
    workspaceId: input.workspaceId,
    cwd: input.cwd,
    agent: connection.data.agent,
    normalize: connection.data.normalize,
    supportsLoadSession: connection.data.supportsLoadSession,
    supportsForkSession: connection.data.supportsForkSession,
    supportsImagePrompt: connection.data.supportsImagePrompt,
    supportsSteering: connection.data.supportsSteering,
    reportsState: connection.data.reportsState,
    pid: connection.data.pid,
  };
}

function agentHostErrorMessage(error: AgentHostError): string {
  return 'message' in error ? error.message : error.type;
}
