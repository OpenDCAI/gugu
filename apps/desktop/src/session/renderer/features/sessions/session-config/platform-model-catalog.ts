import { useEffect, useRef, useState } from 'react';
import { useLibraryHost } from '@renderer/features/library/library-host';
import { invokeOnMachine } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import {
  parsePlatformReasoningEfforts,
  PLATFORM_MODELS_CHANGED_EVENT,
  SESSIONPAGE_PLATFORM_CATALOG_CHANNEL,
  type PlatformModelOption,
  type PlatformModelProtocol,
} from '@shared/core/agents/platform-model';
// 深路径,理由同 platform-model.ts 抬头:总入口会把 node 依赖拖进浏览器包。
import { MODEL_ACCESS_PROTOCOL_IDS } from '@gugu/core/shared/agentModelSelection';
import type { SessionpageSessionSurface } from '@gugu/session-core/agents/plugins';
import { guguCatalogReasonCode, guguCatalogReasonKind } from '@gugu/session-core/session-record/contract';
import { guguReasonCopy } from '@renderer/features/sessions/gugu-reason';
import type { SessionMessageKey } from '@renderer/localization/messages';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { platformModelIdFromRuntimeOption } from '@/session/shared/platform-model-id';

export type PlatformModelCatalog = {
  models: PlatformModelOption[];
  agentDefault: { modelId: string } | null;
  /** The explicit per-conversation composer decision, if this is a persisted conversation. */
  sessionSelection: { modelId: string } | null | undefined;
  /** 「为什么没有目录」的原因码(宿主报的,见 `GuguCatalogReason`);显示前过 `guguCatalogNotice`,❌ 原样上屏。 */
  catalogError: string | null;
};

export type PlatformModelCatalogState = PlatformModelCatalog & {
  retry: () => void;
  /**
   * 重取一次,**不先清空**:会话记录刚被改过(热切后记录跟上,#6182)时用它 ——
   * 清空那一刻 `sessionSelection` 变回 undefined,菜单会把平台组撤掉、计费路退成 unknown/own。
   */
  refresh: () => void;
};

/**
 * 目录取不到时的取值。「咕咕提供的模型」分组是**加法**:主进程没接线、控制面不可达、
 * 响应超时,都只让这一组缺席,harness 自家模型照常可选 —— composer 不因为一个额度目录
 * 取不到就打不开。(计费路径本身的 fail loud 在主进程,见 sessionpage-platform-model.ts。)
 *
 * 这里原因码为 null:这是「还没取 / 不该取」的初值。IPC 这一趟真失败了由 hook 记成
 * `host-not-ready`(带重试),见 usePlatformModelCatalog。
 */
export const NO_PLATFORM_CATALOG: PlatformModelCatalog = {
  models: [],
  agentDefault: null,
  sessionSelection: undefined,
  catalogError: null,
};

/**
 * 目录经控制面取,一次网络往返。留足慢网的余量,又不让一个吊死的 handler 把分组永远卡在
 * 「还没到」——超时按取不到处理。
 */
const CATALOG_TIMEOUT_MS = 8_000;
const CATALOG_AUTH_RETRY_DELAY_MS = 250;
/** 回到前台时重取目录的最短间隔:focus 与 visibilitychange 常常一前一后同时到,别为一次切窗取两遍。 */
const FOREGROUND_REFRESH_MIN_MS = 5_000;
/** 这一侧问宿主没问到(IPC 失败 / 超时)。 */
export const PLATFORM_CATALOG_RETRY_ERROR = guguCatalogReasonCode('host-not-ready');

/**
 * `catalogError` → 界面上那一句(按界面语言)+ 旁边给不给「重试」。
 * 认不出的串(老版本宿主送来的服务端英文原文)一律说「暂时用不了」,❌ 原样显示(#6264 真机:
 * `model access server is not configured` 铺进了新建任务的工具栏)。
 */
export function guguCatalogNotice(
  raw: string | null | undefined,
  translate: (key: SessionMessageKey) => string,
): { text: string; retryable: boolean } | null {
  const kind = guguCatalogReasonKind(raw);
  if (!kind) return null;
  const { copy, action } = guguReasonCopy(kind);
  return { text: translate(copy), retryable: action === 'retry' };
}

/**
 * 让列着的模型下拉一起重取目录(与设置「模型」页开关一条同一个信号)。
 * #7092「我开好了」:会员可能是在手机或别的窗口开的,回到这里未必有一次「回到前台」 ——
 * 不重取的话会话按会员模型起来了,下拉和输入框仍按免费档挡着。
 */
export function refreshPlatformModelCatalogs(): void {
  window.dispatchEvent(new Event(PLATFORM_MODELS_CHANGED_EVENT));
}

// 运行时白名单**从协议表导出**,❌ 不再手抄一份。手抄那份漏一个新协议时不会报错,
// 只会让那个协议的模型被下面的 parseModel 静默丢掉 —— composer 里少几行、没有任何信号。
const PROTOCOLS: readonly PlatformModelProtocol[] = MODEL_ACCESS_PROTOCOL_IDS;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(translateSessionMessage('composer.platformCatalogTimeout'))), ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

function parseModel(value: unknown): PlatformModelOption | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = value as Record<string, unknown>;
  const { id, protocol } = raw;
  if (typeof id !== 'string' || !id) return null;
  if (typeof protocol !== 'string' || !PROTOCOLS.includes(protocol as PlatformModelProtocol)) {
    return null;
  }
  return {
    id,
    displayName: typeof raw.displayName === 'string' && raw.displayName ? raw.displayName : id,
    protocol: protocol as PlatformModelProtocol,
    // 倍率是 display-only,坏值与缺失同义:省掉数字,不猜、也不拖累整条目录。
    creditMultiplier:
      typeof raw.creditMultiplier === 'number' && Number.isFinite(raw.creditMultiplier)
        ? raw.creditMultiplier
        : null,
    // 与倍率同一条纪律:**坏值与缺失同义**,省掉这一格而不是猜一个 —— 0 会被格式化成
    // `Context 0 tokens`,那是假信息,比没有更坏。
    contextWindow:
      typeof raw.contextWindow === 'number' && Number.isInteger(raw.contextWindow) && raw.contextWindow > 0
        ? raw.contextWindow
        : null,
    // 同一条纪律,但「坏值」与「空」要分开:`[]` 是目录的答案(没有这根轴),坏值是「不知道」⇒ null。
    reasoningEfforts: parsePlatformReasoningEfforts(raw.reasoningEfforts),
    // 只认 true:缺省(旧主进程)与坏值都按「不用会员」—— 门槛在网关,这一格判错只会标错、不会放行(#7056)。
    requiresMembership: raw.requiresMembership === true,
    // 同上:只认 true,旧主进程不带 ⇒ 没关。
    hidden: raw.hidden === true,
  };
}

/** 跨进程边界的响应按不可信处理:形状不对的条目丢掉,而不是让 composer 崩在一个空字段上。 */
export function parsePlatformModelCatalog(response: unknown): PlatformModelCatalog {
  if (typeof response !== 'object' || response === null) return NO_PLATFORM_CATALOG;
  const raw = response as Record<string, unknown>;
  const models = Array.isArray(raw.models)
    ? raw.models.map(parseModel).filter((model): model is PlatformModelOption => model !== null)
    : [];
  const agentDefault = raw.agentDefault;
  const defaultModelId =
    typeof agentDefault === 'object' &&
    agentDefault !== null &&
    typeof (agentDefault as Record<string, unknown>).modelId === 'string'
      ? ((agentDefault as Record<string, unknown>).modelId as string)
      : null;
  const knownModelIds = models.map((model) => model.id);
  const canonicalize = (modelId: string) =>
    platformModelIdFromRuntimeOption(modelId, knownModelIds) ?? modelId.trim();
  return {
    models,
    agentDefault: defaultModelId ? { modelId: canonicalize(defaultModelId) } : null,
    sessionSelection:
      Object.prototype.hasOwnProperty.call(raw, 'sessionSelection')
        ? (() => {
            const value = raw.sessionSelection;
            if (value === null) return null;
            if (typeof value !== 'object' || value === null) return undefined;
            const modelId = (value as Record<string, unknown>).modelId;
            return typeof modelId === 'string' && modelId.trim()
              ? { modelId: canonicalize(modelId) }
              : undefined;
          })()
        : undefined,
    catalogError:
      typeof raw.catalogError === 'string' && raw.catalogError.trim() ? raw.catalogError : null,
  };
}

export async function fetchPlatformModelCatalog(
  providerId: string,
  surface: SessionpageSessionSurface,
  /** 已存在的会话;新建时没有,agentDefault 便为空。 */
  sessionId?: string | null,
  /** #6264 新建框选的机器(会话已存在时按会话所在机器);null = 本机。 */
  machine: string | null = sessionId ? machineRegistry.machineOf(sessionId) : null
): Promise<PlatformModelCatalog> {
  const response = await withTimeout(
    invokeOnMachine(machine, SESSIONPAGE_PLATFORM_CATALOG_CHANNEL, { providerId, surface, sessionId }),
    CATALOG_TIMEOUT_MS
  );
  return parsePlatformModelCatalog(response);
}

/**
 * 当前 provider 的平台模型目录。providerId 为 null(未选 agent,或调用方关掉了平台分组)
 * 时不发请求。
 */
export function usePlatformModelCatalog(
  providerId: string | null,
  surface: SessionpageSessionSurface,
  sessionId?: string | null
): PlatformModelCatalogState {
  const [catalog, setCatalog] = useState<PlatformModelCatalog>(NO_PLATFORM_CATALOG);
  const [retryNonce, setRetryNonce] = useState(0);
  const keepCurrent = useRef(false);
  const retry = () => setRetryNonce((value) => value + 1);
  // #6264 会话 / 新建框在别的机器上:平台模型也问那台机器(它用自己的登录态与额度)。
  const host = useLibraryHost().remote;
  const hostMachine = host?.deviceId ?? null;
  const machine = sessionId ? machineRegistry.machineOf(sessionId) : hostMachine;
  // 那台机器此刻连没连上(只有这个框所在的那台知道;会话落在别处的照旧去问)。
  const online = machine === null || machine !== hostMachine || host?.online !== false;
  const wasOnline = useRef(online);
  const refresh = () => {
    keepCurrent.current = true;
    setRetryNonce((value) => value + 1);
  };
  // The model list belongs to provider + surface + machine; only the preselection belongs to the session.
  // Switching sessions keeps the list on screen (it was emptied and refilled on every switch) and drops
  // just the previous session's preselection until this one's arrives.
  const catalogOf = `${providerId}\u0000${surface}\u0000${machine}`;
  const lastCatalogOf = useRef(catalogOf);
  // 设置「模型」页开关了一条(#7056):列着的这几个下拉一起重取,不等下次换 agent / 换会话。
  useEffect(() => {
    const onChanged = () => {
      keepCurrent.current = true;
      setRetryNonce((value) => value + 1);
    };
    window.addEventListener(PLATFORM_MODELS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(PLATFORM_MODELS_CHANGED_EVENT, onChanged);
  }, []);
  // 回到前台就重取(#7056):人可能刚在网页上开通、续费会员 —— 点「升级解锁更多模型」去付完钱回来,
  // 下拉里就该是会员的模型。开会员只写会员表(bind_subscription),没有任何推送会到这里;
  // 与 useSpendingPower 的 refreshWhenVisible 同一条规矩、同一个理由。
  // owner 2026-10-10 实测:升级后回到窗口,下拉仍是三个免费模型 + 「升级解锁」。
  useEffect(() => {
    let lastAt = Date.now();
    const onForeground = () => {
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastAt < FOREGROUND_REFRESH_MIN_MS) return;
      lastAt = now;
      keepCurrent.current = true;
      setRetryNonce((value) => value + 1);
    };
    window.addEventListener('focus', onForeground);
    document.addEventListener('visibilitychange', onForeground);
    return () => {
      window.removeEventListener('focus', onForeground);
      document.removeEventListener('visibilitychange', onForeground);
    };
  }, []);

  useEffect(() => {
    // 机器断开 / 连上本身不换目录也不换会话:列着的留着,别先清空再填。
    if (online !== wasOnline.current) keepCurrent.current = true;
    // 回来了:断开前那次没问到的失败作废(它是机器那头没应答),❌ 重取回来之前再亮一下「尚未就绪」。
    if (online && !wasOnline.current) setCatalog((prev) => (prev.catalogError ? { ...prev, catalogError: null } : prev));
    wasOnline.current = online;
    // 列着的是哪一份(提供方 + 界面 + 机器)与连没连上无关:换了就清,❌ 离线时把上一台 / 上一家的模型留在下拉里。
    const sameCatalog = lastCatalogOf.current === catalogOf;
    lastCatalogOf.current = catalogOf;
    if (!sameCatalog) setCatalog(NO_PLATFORM_CATALOG);
    else if (!keepCurrent.current) setCatalog((prev) => ({ ...prev, agentDefault: null, sessionSelection: undefined }));
    keepCurrent.current = false;
    // 机器没连上就不问:问不到只会落一个「模型列表尚未就绪」,而原因是机器离线(那由机器的提示说)。
    // 连上时 online 变回 true、这里重跑 —— 机器回来,列表自己续上,❌ 停在「尚未就绪」等人点重试。
    if (!online || !providerId) return;
    let live = true;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const load = (retry: boolean) => {
      void fetchPlatformModelCatalog(providerId, surface, sessionId, machine)
        .then((next) => {
          if (!live) return;
          // The main process may receive the first request before its renderer-backed auth
          // provider has observed the freshly injected session. Retry one empty response;
          // transport failures remain single-shot and the second response is authoritative.
          if (retry && next.models.length === 0) {
            setCatalog(next);
            retryTimer = setTimeout(() => load(false), CATALOG_AUTH_RETRY_DELAY_MS);
            return;
          }
          setCatalog(next);
        })
        .catch(() => {
          if (retry) {
            retryTimer = setTimeout(() => load(false), CATALOG_AUTH_RETRY_DELAY_MS);
            return;
          }
          setCatalog({ ...NO_PLATFORM_CATALOG, catalogError: PLATFORM_CATALOG_RETRY_ERROR });
        });
    };
    load(true);
    return () => {
      live = false;
      if (retryTimer) clearTimeout(retryTimer);
    };
  }, [providerId, surface, sessionId, retryNonce, machine, online]);

  return { ...catalog, retry, refresh };
}
