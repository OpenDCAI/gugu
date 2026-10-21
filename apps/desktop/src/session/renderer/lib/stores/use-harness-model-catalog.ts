import { useQuery, type QueryClient } from '@tanstack/react-query';
import { rpcOn } from '@renderer/lib/ipc';
import { useLibraryHost } from '@renderer/features/library/library-host';
import type {
  HarnessCatalogLookup,
  HarnessCatalogState,
} from '@main/core/agents/harness-model-catalog';

/**
 * 四态**就是**主进程那份 —— 这里只做类型转出,❌ 不再手抄一份。
 *
 * 原来两侧各写各的:主进程 `harness-model-catalog.ts` 一份、这里一份,注释里写着「改一处必须
 * 同步另一处」。那句叮嘱没有任何执行力 —— 2026-08-26 给 `auth-required` 加 `efforts` /
 * `selectedEffort` 时就漏了这边,渲染层照旧当它没有这两格,`state.efforts is not iterable`
 * 直接把整个 composer 摔在渲染里(单测抓到,靠的还是测试自己把 state 标成 `unknown` 绕过类型)。
 *
 * ⚠️ **只**能是 `export type`:它在编译期就被抹掉,会话页 bundle 不会因此把宿主模块复制一份进来
 * (`extension-bridge-relay` 那个坑的成因)。同样的做法 `lib/ipc.ts` 已经在用(`RpcRouter`)。
 */
export type {
  HarnessCatalogLookup,
  HarnessCatalogState,
  HarnessModelChoice,
} from '@main/core/agents/harness-model-catalog';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { isAuthExpired, withAuthExpiry } from './harness-auth-expiry';
import { useAgentAuthStatus } from './use-agent-auth-status';
import type { SessionpageLeg } from '@shared/core/sessions/sessions';

export const HARNESS_MODEL_CATALOG_QUERY_KEY = ['agents', 'modelCatalog'] as const;

/**
 * 后台还在探时,多久回来问一次。
 *
 * 这一趟 RPC 只读主进程的内存缓存(`lookupHarnessModelCatalog` 不等进程),所以便宜;
 * 而且它**自己会停** —— `refreshing` 一变 false 就不再排下一次。
 * ❌ 不是无条件定时器:没有在途探测时一次都不问。
 */
const REFRESHING_POLL_MS = 700;

/** 别的机器上的目录的过期时间。 */
const REMOTE_STALE_MS = 30_000;

/**
 * 这家 harness 现在能跑哪些模型 —— 问 harness 自己。
 *
 * `staleTime: Infinity` 是刻意的：**作废这件事归主进程管**，那里有两把闸（harness 版本变更
 * 为主、TTL 兜底），渲染层再叠一层自己的过期判断只会让两套规则打架 —— 界面以为该刷了，主进程
 * 说缓存还新鲜，于是每次都白跑一趟 IPC。要立刻重读走 `refresh()`（它带 force）。
 * 但「问」本身不能省：面挂上来时照样问主进程一次（`refetchOnMount: 'always'`，#7081），新不新鲜由它答。
 *
 * ❌ 不 `refetchOnWindowFocus`：探一次要起一个 harness 进程、2–3s，切个窗口就重来一遍纯浪费。
 */
function errorReason(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim() || translateSessionMessage('composer.unknownError');
}

/**
 * 强制重读这一家的模型目录 —— **不订阅**它。
 *
 * 抽屉的「账号」行(#6100)只需要「登完之后让它作废」这一下:挂 `useHarnessModelCatalog`
 * 就会顺带**起一个 harness 进程**去探(2–3s),而打开任意一家的详情抽屉都会触发那一趟 ——
 * 一个纯粹为了拿到 `refresh` 而付的代价。⇒ 动作抽成函数,订阅留给真要显示模型的那些面。
 *
 * 带 force:主进程那边的 TTL 对「用户刚刚登完」这件事一无所知。
 */
export async function forceRefreshHarnessModelCatalog(
  client: QueryClient,
  providerId: string,
  /** 带 force 探哪条腿(#6246 目录按腿取);其余腿随后按 provider 前缀重问。 */
  leg: SessionpageLeg = 'acp',
  machine: string | null = null
): Promise<void> {
  const key = [...HARNESS_MODEL_CATALOG_QUERY_KEY, providerId, leg, ...(machine ? ['remote', machine] : [])];
  try {
    // 这一句也**不等** harness:主进程只是让缓存作废、起一趟后台探测,随即带
    // `refreshing: true` 回来。真结果由订阅方那条轮询接走。
    const fresh = (await rpcOn(machine).agents.modelCatalog(providerId, leg, true)) as HarnessCatalogLookup;
    client.setQueryData(key, fresh);
    // 另一条腿的那份也要重问(#6246):主进程对大多数家两条腿共用一份目录,这次 force 探的结果
    // 也属于它;不重问,那份停在 `staleTime: Infinity` 下的旧答案(例如登录前的 auth-required)
    // 会一直留到重启。渲染层不知道哪家共用,所以一律按 provider 前缀作废,由它自己的轮询接走。
    void client.invalidateQueries({
      queryKey: [...HARNESS_MODEL_CATALOG_QUERY_KEY, providerId],
      predicate: (q) => (q.queryKey[3] === 'remote' ? q.queryKey[4] : null) === machine && q.queryKey[2] !== leg,
    });
  } catch (error) {
    client.setQueryData(key, {
      state: { kind: 'unavailable', reason: errorReason(error) },
      refreshing: false,
    } satisfies HarnessCatalogLookup);
  }
}

export function useHarnessModelCatalog(
  providerId: string | null | undefined,
  /** 这份目录替哪条腿读(#6246):两条腿的配置根可能不同,清单也就可能不同。 */
  leg: SessionpageLeg
) {
  // #6264 会话 / 新建框在别的机器上:问那台机器的同一个控制器(一套工作台)。
  const machine = useLibraryHost().remote?.deviceId ?? null;
  const remote = machine !== null;
  const query = useQuery<HarnessCatalogLookup>({
    queryKey: machine
      ? [...HARNESS_MODEL_CATALOG_QUERY_KEY, providerId ?? '', leg, 'remote', machine]
      : [...HARNESS_MODEL_CATALOG_QUERY_KEY, providerId ?? '', leg],
    queryFn: () => rpcOn(machine).agents.modelCatalog(providerId as string, leg) as Promise<HarnessCatalogLookup>,
    enabled: !!providerId,
    // ⚠️ 远端**不能**是 Infinity(#6264 实撞):本机那份作废归主进程管,可那台机器上的变化(人在它的终端里
    // 装了、登了)这边的主进程一无所知 —— Infinity 会把第一次读到的「没登录」钉到重启 app 为止。
    // 远端按 30s 过期、切回窗口时重问(人多半是去那台机器的终端里登完回来);在咕咕里登完的那条路另有作废。
    staleTime: remote ? REMOTE_STALE_MS : Infinity,
    // ⚠️ 本机:面每次挂上来(打开新建任务页、打开模型菜单)都问主进程一次(#7081)。作废归主进程管,
    // 可它只在**被问到**时才比输入指纹 —— 光有 Infinity,同一份清单还在缓存里(5 分钟内重开,或别处
    // 一直挂着)时一次都不问,主进程认出了就地升级也传不到界面上。这一问只读内存缓存 + 算一次指纹
    // (一次 `which` + 一次 stat),不起 harness;挂着时的重渲染不触发。
    refetchOnMount: remote ? true : 'always',
    refetchOnWindowFocus: !!remote,
    retry: false,
    /**
     * ⚠️ 这一行是 `staleTime: Infinity` 的**解药**,不是优化。
     *
     * 主进程现在不等 harness 了(见 `lookupHarnessModelCatalog`),所以第一个回包很可能是
     * 一份**陈的**清单加一句「我还在探」。而 `staleTime: Infinity` 的意思正是「永远别自己再问」——
     * 两者放在一起,那份陈的清单会一直显示到用户重启 app:把「等 30 秒」换成了「一直是错的」,
     * 那比原来更糟。
     *
     * ⇒ 只要主进程说还在探,就按 `refreshing` 排下一次询问;它一变 false,轮询自己停。
     *   `staleTime: Infinity` 照旧保留 —— 作废归主进程管(版本闸 + TTL),渲染层不另立一套。
     */
    refetchInterval: (q) => (q.state.data?.refreshing ? REFRESHING_POLL_MS : false),
  });
  // IPC 本身失败时 `data` 永远是 undefined，而 `retry: false` 意味着它不会再变 —— 不把它
  // 映射成 `unavailable`，界面就会**永远**停在「正在读取可用模型…」：四态里那个「坏了 + 原因
  // + 重试」的分支根本到不了，用户看着一个转不完的圈，没有任何下一步。
  const probed: HarnessCatalogState = query.data?.state
    ?? (query.isError
      ? { kind: 'unavailable', reason: errorReason(query.error) }
      : { kind: 'unknown' });
  // #6264 目录探针判不出「登录已失效」,叠上那台机器的 worker 发布的那一格(只订阅,不探)。
  const { auth } = useAgentAuthStatus(providerId, undefined, { probe: false, machine });
  const state = withAuthExpiry(probed, isAuthExpired(auth));

  return {
    /** 还没探完时是 `unknown` —— 界面据此显示「读取中」，❌ 不显示「没有模型」。 */
    state,
    // 后台还在探也算「在读」—— 手上这份可能是陈的,调用方有权知道它还会变。
    isLoading: query.isPending || query.isFetching || (query.data?.refreshing ?? false),
  };
}
