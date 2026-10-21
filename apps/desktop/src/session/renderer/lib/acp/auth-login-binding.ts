import {
  agentConfigListSchema,
  type AgentConfigError,
  type AgentConfigList,
  type AuthStatusModelState,
} from '@gugu/session-core/workspace-server/agent-config';
import type { Result } from '@gugu/session-shared';
import { ReplicaLog, ReplicaState } from '@gugu/session-wire';
import { createImmutableMobxStore } from '@gugu/session-wire/util/mobx';
import type { Terminal } from '@xterm/xterm';
import {
  getAgentConfigRuntimeClient,
  type AgentConfigRuntimeRpcClient,
} from '../agent-config/runtime-client';
import { createXtermLogSink } from '../pty/xterm-log-sink';

type AuthStatusHandle = {
  readonly ready: Promise<void>;
  current(): AuthStatusModelState;
  dispose(): void;
};

export class AcpAuthLoginBinding {
  private disposed = false;

  private constructor(
    private readonly client: AgentConfigRuntimeRpcClient,
    readonly providerId: string,
    /** 登哪个程序(#6335);缺席 = 主程序。之后的输入 / 缩放 / 取消都认这一个。 */
    readonly program: string | undefined,
    readonly connectionId: string | undefined,
    readonly status: AuthStatusHandle,
    /** 协议登录(`acp-authenticate`)没有终端,也就没有输出日志。 */
    private readonly output: ReplicaLog | null
  ) {}

  static async create(args: {
    providerId: string;
    methodId: string;
    program?: string;
    connectionId?: string;
    /** 缺席 = 协议登录:厂商自己开浏览器,界面上没有终端,不订阅登录输出。 */
    terminal?: Pick<Terminal, 'reset' | 'write'>;
    /** #6264 在哪台机器上登;缺席 = 本机。 */
    machine?: string | null;
    /** #6264 浏览器不在那台机器上:跑这家不靠回跳的登录方式(`headlessArgs`)。 */
    headless?: boolean;
  }): Promise<AcpAuthLoginBinding> {
    const client = await getAgentConfigRuntimeClient(args.machine ?? null);
    const target = programTarget(args.providerId, args.program, args.connectionId);
    const result = await client.startLogin({
      ...target,
      methodId: args.methodId,
      ...(args.headless ? { headless: true } : {}),
    });
    if (!result.success) throw new Error(errorMessage(result));

    const key = target;
    const agents = new ReplicaState(client.agents.state(undefined, 'list'), {
      schema: agentConfigListSchema,
      store: createImmutableMobxStore(),
    });
    const status = createAuthStatusHandle(args.providerId, args.program, agents, args.connectionId);
    const output = args.terminal
      ? new ReplicaLog(client.loginOutput.handle(key), {
          store: createXtermLogSink(args.terminal),
        })
      : null;
    const binding = new AcpAuthLoginBinding(client, args.providerId, args.program, args.connectionId, status, output);
    try {
      await Promise.all([status.ready, output?.ready]);
    } catch (error) {
      // @@@replica-failed-ready — 调用方收到的是错误、拿不到这个 binding,没人会再 dispose:拒掉的那份副本自己放掉了
      // attach,另一份还挂着;上面 startLogin 起的那一趟登录也没人取消 ⇒ 在这里整份拆掉(含取消)再抛。
      binding.dispose();
      throw error;
    }
    return binding;
  }

  sendInput(data: string): void {
    if (this.disposed) return;
    void this.client.sendLoginInput({ ...this.target(), data });
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) return;
    void this.client.resizeLogin({ ...this.target(), cols, rows });
  }

  /**
   * 再问一次**这个程序**的登录态(结果经同一份 live state 回来,`status` 随之翻)。
   * 给「这一趟登完了没有」一个事件触发的读数 —— 登录弹窗在用户从浏览器回到窗口时调它,❌ 不轮询。
   */
  refreshStatus(): void {
    if (this.disposed) return;
    void this.client.refreshAuthStatus(this.target());
  }

  markUrlHandled(urlId: string): void {
    if (this.disposed) return;
    void this.client.markUrlHandled({ ...this.target(), urlId });
  }

  dispose(cancel = true): void {
    if (this.disposed) return;
    this.disposed = true;
    void this.status.dispose();
    void this.output?.dispose();
    if (cancel) void this.client.cancelLogin(this.target());
  }

  private target(): { providerId: string; program?: string; connectionId?: string } {
    return programTarget(this.providerId, this.program, this.connectionId);
  }
}

/** 主程序那一路不带 `program` 键 —— 与改之前发出去的请求逐字节一致。 */
function programTarget(providerId: string, program: string | undefined, connectionId?: string): { providerId: string; program?: string; connectionId?: string } {
  return { providerId, ...(program === undefined ? {} : { program }), ...(connectionId ? { connectionId } : {}) };
}

function createAuthStatusHandle(
  providerId: string,
  program: string | undefined,
  agents: ReplicaState<AgentConfigList>,
  connectionId?: string
): AuthStatusHandle {
  return {
    ready: agents.ready,
    current: () => {
      const entry = agents.current()[providerId];
      return (
        (connectionId ? entry?.connectionAuth?.[connectionId] : program === undefined ? entry?.auth : entry?.programAuth?.[program]) ?? {
          status: { kind: 'unknown' },
          login: null,
        }
      );
    },
    dispose: () => {
      void agents.dispose();
    },
  };
}

function errorMessage(result: Result<unknown, AgentConfigError>): string {
  if (result.success) return '';
  return 'message' in result.error ? result.error.message : result.error.type;
}
