import type { ComposerModelOption } from '@gugu/session-ui/react/components';
import type { HarnessCatalogState } from '@renderer/lib/stores/use-harness-model-catalog';

/** 本模块用到的词表 key —— 与 messages-capabilities 里的 `harnessCatalog.*` 一一对应。 */
export type HarnessCatalogMessageKey =
  | 'harnessCatalog.loading'
  | 'harnessCatalog.notInstalled'
  | 'harnessCatalog.authRequired'
  | 'harnessCatalog.authRequiredWith'
  | 'harnessCatalog.authExpired'
  | 'harnessCatalog.unavailable';

/**
 * harness 目录 → composer 下拉的选项表。
 *
 * 只有 `ready` 才产出选项。其余三态一律 null —— 拿不到清单时**没有模型可选**，
 * ❌ 不退回插件里那张静态表：列一张用户根本跑不了的模型，正是咕咕红线里的 fake
 * （实测过它错到什么程度：静态表钉的 `claude-opus-4-8` 在 claude 2.1.229 里根本不被识别）。
 */
export function harnessCatalogToOptions(
  state: HarnessCatalogState,
  /**
   * 插件静态表。**只在 `unsupported` 那一态使用** —— 那些 agent 压根不说 ACP，静态表是它们
   * 一直以来唯一的来源（amp 4 条 / antigravity 8 条）。
   * ❌ 不在 not-installed / auth-required / unavailable 时使用：那几态是「会说 ACP 但这次读不
   * 到」，退回静态表就是列一张用户跑不了的模型 —— 实测 `claude-opus-4-8` 在 claude 2.1.229
   * 里根本不被识别、窗口回落 200K，正是这个 PR 要消灭的东西。
   */
  staticFallback?: Record<string, ComposerModelOption> | null
): Record<string, ComposerModelOption> | null {
  if (state.kind === 'unsupported') return staticFallback ?? null;
  if (state.kind !== 'ready' || state.models.length === 0) return null;
  return Object.fromEntries(
    state.models.map((model) => [
      model.id,
      {
        name: model.name,
        // description 必须带上：harness 给的常是别名（`default` / `opus[1m]`），而 `default`
        // 是**相对**别名 —— 它指「harness 当前推荐的那个」，含义随 harness 升级而变。
        // 不显示描述，用户就不知道今天选中的到底是谁。
        ...(model.description ? { description: model.description } : {}),
      },
    ])
  );
}

/**
 * 拿不到模型清单时，该跟用户说什么。
 *
 * 四态各有各的下一步动作，❌ 不能合并成一句「暂无模型」：
 * 「该去装」「该去登录」「坏了可以重试」是三件不同的事，合并等于让用户自己猜。
 *
 * 返回 null = 有清单（或这个 harness 本来就不让选模型），调用方照常渲染下拉。
 */
export function harnessCatalogNotice(
  state: HarnessCatalogState,
  agentName: string
): {
  tone: 'info' | 'warn';
  /** 词表 key —— ❌ 不返回成品中文串：这一排的邻居全走 `translate()`，硬编码会让 en-US 用户看到中文。 */
  key: HarnessCatalogMessageKey;
  values: Record<string, string>;
  /**
   * 主进程给的原始失败原因，**不进这一排**。
   *
   * 它是长度不可控的外部字符串（实测拿到过整句英文
   * `opencode acp requires runtime exactly 1.18.18; found 1.18.16`），而这一排是 composer 工具栏，
   * 邻居是「编辑」「Chat UI」这种两三个字的标签。把它拼进内联文案会把工具栏撑破、溢出到卡片外
   * —— 真机上就是这么炸的。所以内联只留一句定性，细节交给调用方走 toast 弹出。
   */
  detail?: string;
  action?: 'install' | 'login' | 'retry';
} | null {
  switch (state.kind) {
    case 'unsupported':
      // 不说 ACP 的 agent 没什么可解释的：它用的就是插件静态表，跟改动前一模一样。
      return null;
    case 'unknown':
      // 「还没读到」不是「没有模型」——显示读取中，别让用户以为这个 agent 不支持选模型。
      return { tone: 'info', key: 'harnessCatalog.loading', values: {} };
    case 'not-installed':
      return {
        tone: 'warn',
        key: 'harnessCatalog.notInstalled',
        values: { name: agentName },
        action: 'install',
      };
    case 'auth-required':
      // #6264 登录过、但登录已失效:说「登录已失效」,❌ 说成需要先登录(用户会以为自己从没登过)。
      if (state.expired) {
        return { tone: 'warn', key: 'harnessCatalog.authExpired', values: { name: agentName }, action: 'login' };
      }
      // 登录方式由协议自己回来（实测 qwen 就是这个形态），所以这里能说得具体。
      return state.authMethods.length
        ? {
          tone: 'warn',
          key: 'harnessCatalog.authRequiredWith',
          values: { name: agentName, methods: state.authMethods.map((m) => m.name).join(' / ') },
          action: 'login',
        }
        : {
          tone: 'warn',
          key: 'harnessCatalog.authRequired',
          values: { name: agentName },
          action: 'login',
        };
    case 'unavailable':
      return {
        tone: 'warn',
        key: 'harnessCatalog.unavailable',
        values: { name: agentName },
        // reason 是主进程给的原始原因，原样转达 —— 它不进词表（服务返回内容不入表，见表头约定），
        // 也不进内联文案（长度不可控，见 detail 的说明）。
        detail: state.reason,
        action: 'retry',
      };
    case 'ready':
      // 空清单不是错误：有些 harness 就是不提供模型选择。这时不显示任何提示，
      // 也不渲染下拉 —— 与改动前那些 `models.kind === 'none'` 的 agent 表现一致。
      return null;
  }
}

// 档位与「目录 → models 能力」那几条纯规则搬去了 shared(主进程为手机端建会话时要同一份);
// 这里只保旧 import 路径。
export {
  harnessCatalogToEfforts,
  harnessCatalogToModelsCapability,
  pluginDeclaredEfforts,
} from '@shared/core/agents/create-efforts';
