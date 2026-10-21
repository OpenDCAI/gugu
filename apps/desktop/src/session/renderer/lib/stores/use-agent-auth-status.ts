import {
  agentConfigListSchema,
  type AgentConfigAuthError,
  type AuthStatusModelState,
} from '@gugu/session-core/workspace-server/agent-config';
import { ReplicaState } from '@gugu/session-wire';
import { createImmutableMobxStore } from '@gugu/session-wire/util/mobx';
import { reaction } from 'mobx';
import { useCallback, useEffect, useRef, useState } from 'react';
import { getAgentConfigRuntimeClient } from '@renderer/lib/agent-config/runtime-client';
import { log } from '@renderer/utils/logger';
import { expiredProviderIds } from './harness-auth-expiry';

function authErrorMessage(error: AgentConfigAuthError): string {
  return 'message' in error ? error.message : error.type;
}

/**
 * 「这一家登没登」—— 读的是**已有**那条判据通道,❌ 没有第二条探测路。
 *
 * 状态由 agent-config worker 的 `AgentAuthManager` 探出来并发布进 `agents.list` 这份 live state
 * (`packages/session-runtime/src/agent-config/runtime/auth.ts`);登录终端(`AgentSignInModal` 经
 * `AcpAuthLoginBinding`)订阅的就是同一份。所以这里只做两件事:
 *
 *  1. 订阅那份 state,取这一家的 `auth` 格 —— 登录终端跑完把新读数发布进来时,这一行**自己**就翻。
 *  2. 挂载时请 worker 探一次(`refreshAuthStatus`,在途按「这一家 × 这一份 CLI」去重)。
 *     ⚠️ 不探就只能读到进程开起来至今**碰巧**被别人触发过的那次读数 —— 多数时候是从来没探过,
 *        即 `{kind:'unknown'}`。那不是「判不出」,是「没问过」。
 *
 * ❌ 不把登录态塞进 `agents.listManagement` 那份 payload:那是 5 分钟 staleTime 的快照,而登录态
 *    要在登录终端关掉的那一刻就变。两者形状一样、时效完全不同,混在一格里必然漂。
 */
/**
 * `probe: false` = 只订阅那份 live state,❌ 挂载时去跑一次 CLI 的 status(#6264)。
 * 给只关心「登录已失效」的面用(模型清单、会话页、图标角标):那一格由 worker 发布,不用探就在;
 * 而每开一次模型清单就起一个 `codex login status` 进程是白付的代价。
 */
type AuthStatusOptions = {
  probe?: boolean;
  /** #6264 问哪台机器上的登录态(会话 / 新建框在别的机器上时);缺席 / null = 本机。 */
  machine?: string | null;
};

export function useAgentAuthStatus(
  providerId: string | null | undefined,
  /**
   * 哪个程序(#6335)。缺席 = 主程序(`auth` 那一格);给了伴随程序的依赖 id = `programAuth[program]`
   * 那一格,探的也是那个程序(主进程按它服务的腿解析可执行文件)。
   */
  program?: string,
  options: AuthStatusOptions = {}
) {
  const { auths, refresh } = useAgentAuthStatuses(providerId, [program], options);
  return { auth: auths[0] ?? null, refresh };
}

/**
 * 同一家**几个程序**的登录态一起读(#6335:资源库那一行把它们合成一份,见 `mergeAccountRows`)。
 * 一份订阅、每个程序各探一次;`refresh` 把这几个程序都重问一遍。返回的顺序与 `programs` 一致。
 */
export function useAgentAuthStatuses(
  providerId: string | null | undefined,
  programs: ReadonlyArray<string | undefined>,
  options: AuthStatusOptions = {}
) {
  const probeOnMount = options.probe !== false;
  const machine = options.machine ?? null;
  // 数组每次渲染都是新对象 —— 按内容做依赖(`undefined` = 主程序,记成空串)。
  const programsKey = programs.map((program) => program ?? '').join('\u0000');
  const [auths, setAuths] = useState<Array<AuthStatusModelState | null>>(() => programs.map(() => null));
  const probeRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const list = programsKey.split('\u0000').map((key) => (key === '' ? undefined : key));
    setAuths(list.map(() => null));
    probeRef.current = null;
    if (!providerId) return;

    let disposed = false;
    const disposers: Array<() => void> = [];
    /** 落一个终局的「判不出」—— 只在还没有任何真读数时。 */
    const settle = (index: number, message: string) => {
      if (disposed) return;
      setAuths((current) =>
        current.map((auth, i) => (i === index ? auth ?? { status: { kind: 'unknown', message }, login: null } : auth))
      );
    };
    // pop 式 —— 重复调用是安全的(下面 await 之间的每个逃逸点都会调它)。
    const runDisposers = () => {
      while (disposers.length) disposers.pop()?.();
    };

    void (async () => {
      const client = await getAgentConfigRuntimeClient(machine);
      if (disposed) return;
      const agents = new ReplicaState(client.agents.state(undefined, 'list'), {
        schema: agentConfigListSchema,
        store: createImmutableMobxStore(),
      });
      disposers.push(() => void agents.dispose());
      if (disposed) return runDisposers();

      const probe = async () => {
        await Promise.all(
          list.map(async (program, index) => {
            const result = await client.refreshAuthStatus(
              program === undefined ? { providerId } : { providerId, program }
            );
            if (result.success) return;
            log.warn('Agent auth status probe failed', { providerId, program, error: result.error });
            // 探不出也要落一个**终局**读数。❌ 不让「正在检查」转到天荒地老 —— 那是把
            // 「问不出来」画成「还在问」,用户对着一个永远转的圈没有任何下一步。
            // `?? ` 而不是覆盖:订阅那侧要是已经送来真读数,它比这条兜底新。
            settle(index, authErrorMessage(result.error));
          })
        );
      };
      probeRef.current = probe;

      // 先 seed 再建 reaction:`current()` 在 seed 之前没有值可读。
      await agents.ready;
      if (disposed) return runDisposers();
      disposers.push(
        reaction(
          () => {
            const entry = agents.current()[providerId];
            return list.map(
              (program) => (program === undefined ? entry?.auth : entry?.programAuth?.[program]) ?? null
            );
          },
          (next) => {
            if (!disposed) setAuths(next);
          },
          { fireImmediately: true, equals: (a, b) => a.length === b.length && a.every((x, i) => x === b[i]) }
        )
      );
      if (probeOnMount) await probe();
    })().catch((error) => {
      log.warn('Agent auth status subscription failed', { providerId, programs: list, error });
      // 通道根本没建起来(wire 不在 / runtime 掉线)同样要落终局读数,理由同上。
      const message = error instanceof Error ? error.message : String(error);
      list.forEach((_, index) => settle(index, message));
    });

    return () => {
      disposed = true;
      runDisposers();
    };
  }, [providerId, programsKey, probeOnMount, machine]);

  /** 登录终端关掉之后再问一次 —— 关窗那一刻的旧读数 ❌ 不是本次的结果(见 `login-success.ts`)。 */
  const refresh = useCallback(async () => {
    await probeRef.current?.();
  }, []);

  return { auths, refresh };
}

/**
 * #6264 这台机器上此刻「登录已失效」的那几家 —— 只订阅 live state,❌ 探任何一家。
 * 资源库图标网格一次读完用(一格一个订阅就是几十条通道)。读不到就是空集合:没有读数时不把谁说成失效。
 */
export function useExpiredAgentIds(enabled = true): ReadonlySet<string> {
  const [ids, setIds] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    setIds(new Set());
    if (!enabled) return;
    let disposed = false;
    const disposers: Array<() => void> = [];
    void (async () => {
      const client = await getAgentConfigRuntimeClient();
      if (disposed) return;
      const agents = new ReplicaState(client.agents.state(undefined, 'list'), {
        schema: agentConfigListSchema,
        store: createImmutableMobxStore(),
      });
      disposers.push(() => void agents.dispose());
      await agents.ready;
      if (disposed) return;
      disposers.push(
        reaction(
          () => [...expiredProviderIds(agents.current())].sort().join('\u0000'),
          (key) => {
            if (!disposed) setIds(new Set(key ? key.split('\u0000') : []));
          },
          { fireImmediately: true }
        )
      );
    })().catch((error) => {
      log.warn('Agent auth expiry subscription failed', { error });
    });
    return () => {
      disposed = true;
      while (disposers.length) disposers.pop()?.();
    };
  }, [enabled]);
  return ids;
}
