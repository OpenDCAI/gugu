import type { PlatformCallableRoutes, SessionModelCapability } from './session-bundle'

/**
 * 平台模型的**写法** —— 这一家怎么把「咕咕的模型 + 中转」说给自己听。声明了 `platform: supported` 的家
 * 必须实现它(注册时核);宿主只按 `platform.dialect` 找到这一家,再调它的 `declare` / `load`。
 *
 * 从前这两步是宿主 `capability-bundle.ts` 里两个按方言分支的 switch(`buildAcpModelCapability` /
 * `loadAcpModel`),每接一家就要往宿主加两格。
 */
export interface IPlatformModelBehavior {
  /** 这次会话的模型声明(原 `buildAcpModelCapability` 里这一家的那一格)。 */
  declare(input: PlatformModelInput): SessionModelCapability;
  /** 模型声明 → 这一家吃的 argv / 环境变量 / 会话 settings 文档(原 `loadAcpModel` 里这一家的那一格)。 */
  load(model: SessionModelCapability): PlatformModelLoad;
}

/** 宿主替每一家先算好的那几样 —— 与哪一家无关的部分。 */
export interface PlatformModelInput {
  /** composer / 调用方点名的模型;没点名 = undefined。 */
  explicitModel: string | undefined;
  /** composer 为这条会话选的**起始**推理档;没选 = undefined(没选和选了某一档是两件事)。 */
  requestedEffort: string | undefined;
  /** 调试开关:先读这次会话的环境,再读宿主进程的环境。 */
  envOverride(key: string): string | undefined;
  /** 平台会话时的 OpenAI 面中转(`<relay>/v1` + 会话令牌);BYOK / 默认 = undefined。 */
  platformProvider: { baseUrl: string; apiKey: string } | undefined;
  /** 平台会话时签发响应的原样几样;BYOK / 默认 = null / undefined。 */
  platformAccess:
    | {
        relayUrl: string;
        token: string;
        contextWindow?: number | null;
        reasoningEfforts?: readonly string[] | null;
        callableRoutes?: PlatformCallableRoutes;
      }
    | null
    | undefined;
  /** 这条会话可以切到的全部咕咕模型。 */
  platformModels: SessionModelCapability['platformModels'];
  /** 平台模型的真实窗口;只在平台会话有。 */
  contextWindow: number | null | undefined;
  /** 令牌在哪些路由上能调哪些模型(#6921);没有 = `{}`。 */
  callableRoutes: PlatformCallableRoutes;
  /**
   * 「把这一家的线协议指向平台中转」那组环境变量 —— core 协议表的原话,宿主按这一家声明的
   * `wireProtocol` 算好递进来(插件看不见 core)。❌ 不在插件里另写一遍变量名。
   */
  protocolEnv(relayUrl: string, contextWindow?: number | null): Record<string, string>;
}

/** 一家吃的那几样。都缺席 = 这次不注入任何东西。 */
export interface PlatformModelLoad {
  extraArgs?: string[];
  spawnEnv?: Record<string, string>;
  /** 会话级 settings 文档的内容;写成文件、传路径是持有会话生命期那一层的事。 */
  settingsOverride?: Record<string, unknown>;
}

/** 咕咕在各家 harness 自己的 provider 列表里显示的名字。 */
export const PLATFORM_PROVIDER_NAME = 'Gugu 平台额度';

export function trimmedValue(value: string | undefined): string | undefined {
  return value?.trim() || undefined;
}

/**
 * 窗口值得不得说给 harness 听。未知(null/undefined)与胡数(0、负数、小数、NaN)同一个答案:不说,
 * 让 harness 用它自己的默认 —— 默认只是保守,一个混过去的坏数却会被当成权威发出去。
 */
export function positiveWindow(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}
