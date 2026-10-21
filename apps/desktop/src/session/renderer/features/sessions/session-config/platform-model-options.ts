import type { ComposerModelOption } from '@gugu/session-ui/react/components';
import { log } from '@renderer/utils/logger';
import { offeredInModelPicker, type PlatformModelOption } from '@shared/core/agents/platform-model';
import { resolveModelProvider } from './model-provider';
import { effortNamesLine } from './effort-options';
import type { ModelProvider } from './model-provider';

// 这几个**词表 key** 放在 `@/session/shared/platform-model-labels`(一个零 import 的模块),
// 因为黑盒 e2e 也要引它们来定位平台模型那一段,而经本文件引就得连整张 renderer 模块图
// 一起加载。原路径继续导出,产品侧的 import 一个字不用改。
export {
  PLATFORM_BILLING_LABEL_KEY,
  PLATFORM_GROUP_HEADING_KEY,
  PLATFORM_GROUP_LABEL_KEY,
  PLATFORM_RATE_KEY,
} from '@/session/shared/platform-model-labels';
import {
  PLATFORM_GROUP_HEADING_KEY,
  PLATFORM_RATE_KEY,
} from '@/session/shared/platform-model-labels';
import { translateSessionMessage } from '@renderer/localization/locale-store';

/** 下拉用到的平台条目字段 —— 手机从宿主拿到的目录条目(那一侧不带协议)也喂得进同一份装配。 */
export type PlatformModelRow = Pick<PlatformModelOption, 'id' | 'displayName' | 'creditMultiplier' | 'contextWindow'> &
  Partial<PlatformModelOption>;

// 前缀编解码同样搬去了零 import 的 `@/session/shared/platform-model-id` —— 会话页主进程的会话发现
// 工具(session_list_models / session_spawn)与咕咕主进程都要说同一件事,而它们各自是另一次打包,
// 引不到本文件。原路径继续导出,产品侧的 import 一个字不用改。
export {
  PLATFORM_OPTION_PREFIX,
  platformModelIdFromOption,
  platformNamespaceCollisions,
  platformOptionId,
} from '@/session/shared/platform-model-id';
import {
  PLATFORM_OPTION_PREFIX,
  platformNamespaceCollisions,
  platformOptionId,
} from '@/session/shared/platform-model-id';

/**
 * 「×0.7」/「×2.5」。倍率是相对值不是绝对积分数,取不到就返回 null —— 调用方省掉数字,
 * 但「按积分计费」照写:少一个倍率不该让一条目录条目看起来像不花钱。
 */
export function formatCreditMultiplier(multiplier: number | null): string | null {
  if (multiplier === null || !Number.isFinite(multiplier) || multiplier <= 0) return null;
  return `×${Number(multiplier.toFixed(2))}`;
}

/**
 * 平台条目在下拉里的**第一行**:只有模型名。
 *
 * ⚠️ 倍率 2026-09-05 从这里挪到了第二行。照 assistant-ui 那版做之后,一条是两段式
 * (粗体名 + 灰色小字),而第二行的职责正是「这条与别条的差别」。名字里再挂一个 `×0.7`
 * 等于把同一件事说两遍,还把粗体那行撑长。
 */
export function platformOptionRowLabel(model: PlatformModelRow): string {
  return model.displayName;
}

/**
 * 平台条目的**第二行**:只留倍率。
 *
 * ⚠️ `composer.platformModelRate` 原文是整句「咕咕提供的模型,按积分计费(相对倍率 ×0.7)」——
 * 那是**没有组头时**的写法。现在这一段有组头、组头已经把计费口径说过一遍,第二行再抄一遍
 * 只是噪声,而且在 288px 的面板里会被省略号截掉。⇒ 词表那条一并收短成倍率本身
 * (该 key **只有这一处**在用,实测)。
 *
 * 倍率取不到就没有第二行(上游的 description 本来也是可选的),❌ 不猜一个数 ——
 * 「花不花积分」由组头承载,不靠这一行。
 */
export function platformOptionRowDescription(model: PlatformModelRow): string | undefined {
  const multiplier = formatCreditMultiplier(model.creditMultiplier);
  return multiplier ? translateSessionMessage(PLATFORM_RATE_KEY, { multiplier }) : undefined;
}

function platformComposerOption(model: PlatformModelRow): ComposerModelOption {
  const description = platformOptionRowDescription(model);
  const efforts = model.reasoningEfforts ? effortNamesLine(model.reasoningEfforts, translateSessionMessage) : null;
  return {
    name: platformOptionRowLabel(model),
    // 能力说明与 harness 自家模型走**同一格**(`modelTitle()` 会把它写成
    // `Context 1M tokens` 挂在行的 title 上)—— 咕咕的模型此前是这张下拉里唯一没有它的一档,
    // 而用户要在 ×0.1 与 ×5 之间挑,窗口大小正是他要比的东西之一。
    // ❌ 不另做一套展示:上游(assistant-ui model picker)与本仓 harness 侧用的都是这一格。
    ...(model.contextWindow === null
      ? {}
      : { modelFeatures: { contextWindowSize: model.contextWindow } }),
    groupLabel: translateSessionMessage(PLATFORM_GROUP_HEADING_KEY),
    // 底栏那颗按钮和设置面板的「模型」行都用 shortName,那两处看不见组头;留一个「咕咕」
    // 前缀,收起状态下也看得出这条会话在花积分。
    shortName: translateSessionMessage('composer.platformModelShortName', {
      model: model.displayName,
    }),
    // 倍率只在悬浮详情卡里说一次(#7056)。行尾曾经也写过,owner 2026-10-10:「卡片里已经展示过了,右侧就不要再展示了」。
    ...(description ? { description } : {}),
    ...(efforts ? { facts: [{ label: translateSessionMessage('composer.effort'), value: efforts }] } : {}),
  };
}

/**
 * 前缀是平台条目与 harness 条目的**唯一**分界,所以 harness 侧一旦冒出一个 `platform:` 开头的
 * 模型 id,合并表就会互相覆盖、`platformModelIdFromOption` 也会把它误认成平台模型 —— 那是「以为
 * 选了自己的模型,实际按积分计费」这一类错账,不能靠事后看日志发现。
 *
 * 现有 5 家插件的 modelOptions 无一如此(claude/codex/amp/mistral/antigravity 已逐一核对),
 * 所以这里守的是将来:开发期直接炸,让写下那个 id 的人当场看见;生产期记一条并丢掉这一条,
 * 宁可少一个模型可选,也不让它顶着平台条目的身份被选中。
 *
 * ⚠️ 「开发期直接炸」的**前提是 id 出自本仓库的静态表** —— 那时确实有个「写下它的人」能当场
 * 改掉。模型改由 harness 经 ACP 报上来之后,id 是外部进程给的任意字符串:某家 harness(或它
 * 背后的中转网关)真报了 `platform:` 开头的名字,炸的就是开发者的整个渲染进程,而且谁也改不了
 * 那个 id。所以按**来源**分:静态表照旧炸,外部来的一律记一条并丢掉。
 */
export function sanitizeHarnessModelOptions(
  harnessOptions: Record<string, ComposerModelOption> | null,
  /** id 是否出自本仓库的插件静态表(可当场修)。默认 false = 外部 harness 报的,永不抛。 */
  options?: { fromStaticTable?: boolean }
): Record<string, ComposerModelOption> | null {
  if (!harnessOptions) return null;
  // 判定住在 `@/session/shared/platform-model-id`,两条用户面共用同一处 —— 这里只决定**怎么报**。
  const offending = platformNamespaceCollisions(Object.keys(harnessOptions));
  if (offending.length === 0) return harnessOptions;
  const message =
    `harness 模型 id 撞上了平台条目前缀 '${PLATFORM_OPTION_PREFIX}':${offending.join(', ')}。` +
    '改插件里的模型 id,或改 platform-model-options.ts 的前缀 —— 两个命名空间不能重叠。';
  if (import.meta.env.DEV && options?.fromStaticTable) throw new Error(message);
  log.warn(message);
  // 丢的就是判定点名的那些 —— ❌ 别在这里再写一次 `startsWith`:那会让同一条规则在同一个函数里
  // 出现两遍,而它们可以各自被改。
  const collided = new Set(offending);
  return Object.fromEntries(
    Object.entries(harnessOptions).filter(([id]) => !collided.has(id))
  );
}

/** 一条模型的一级分类 + 二级厂商 + 图标,贴到 `ComposerModelOption` 上。 */
function decorate(
  option: ComposerModelOption,
  modelId: string,
  tierLabel: string | null | undefined,
  icon: ComposerModelDecor['icon']
): ComposerModelOption {
  const provider = resolveModelProvider(modelId, option.name);
  const node = icon?.(provider);
  return {
    ...option,
    // 已经自带组头的条目不动 —— 平台条目由 `platformComposerOption` 贴过了(走词表),
    // 插件静态表将来若自己分组,那也是它更清楚的分法。
    ...(option.groupLabel || !tierLabel ? {} : { groupLabel: tierLabel }),
    ...(provider ? { providerLabel: provider.name } : {}),
    ...(node ? { icon: node } : {}),
  };
}

export interface ComposerModelDecor {
  /**
   * 用户自己那档的**一级**组头,已翻好的成品串(如「你的 Codex 模型」)。
   *
   * 由调用方翻译而不是本模块自己 `translate()`:这个文件被黑盒 e2e 与主进程侧一起引用,
   * 而 harness 名字是运行时才知道的参数。不给 = harness 条目不贴组头(平铺)。
   */
  ownTierLabel?: string | null;
  /** 厂商 → 图标。不给 = 不画图标(纯数据调用方,如单测与 e2e,不必拖上 React)。 */
  icon?: (provider: ModelProvider | null) => ComposerModelOption['icon'];
}

/**
 * harness 自家模型 + 「咕咕提供的模型」并成 composer 下拉的一份选项表,平台条目排在
 * harness 之后(插入序即渲染序)。目录为空时原样返回 harness 那份 —— 分组缺席时下拉与
 * 改动前逐字节一致。
 *
 * ⚠️ 两档**同名条目并存**是准确的:同一个名字在两档下是**两条真实不同的凭据路径**
 * (自己的订阅 vs 咕咕代付),组头正是用来分它们的。❌ 别按 id 相同把它们折成一条 ——
 * 那正是 #5808:平台会话里用户自己那档被同名平台条目吃掉。
 *
 * ## 分类是两级的,一级是「谁的」(owner 2026-09-06 定)
 *
 * **一级 = 这条是谁的**:「你的 Codex 模型」/「咕咕提供的模型 · 按积分计费」—— 它是组头,
 * 也决定顺序。用户先要定的是**这次调用记在谁账上**(花不花积分、凭据归谁管)。
 * **二级 = 厂商**(OpenAI / Anthropic / 智谱 …):它**不分组**,只做筛选药丸与行内 logo。
 *
 * ⚠️ 我第一版把这两级做反了(厂商当组头、来源当副标题),owner 原话「你这个分类层次反了」。
 * ❌ 别再把厂商升成组头:厂商横切在两档之上(同一家可以既有你自己的、又有咕咕代付的),
 * 拿它分组会把「谁的」这条更要紧的界线切碎。
 *
 * 顺序:用户自己那档在**前**,咕咕提供的在后(owner 2026-09-05)。插入序即渲染序
 * (`buildComposerModelGroups` 按相邻同组头切段,不重排)。❌ 不按厂商重排:厂商既然不分组,
 * 重排只会把宿主给的顺序无故打乱。
 */
export function composerModelOptions(
  harnessOptions: Record<string, ComposerModelOption> | null,
  catalogModels: readonly PlatformModelRow[],
  decor?: ComposerModelDecor,
  /**
   * 这条会话**正在用**的平台模型 id(不带前缀)。它即便要会员(会员到期)或被他在设置里关掉,也照列 ——
   * 下拉的触发器写的是它的名字,清单里没有它,触发器就只剩一个「模型」,而那正是用户最想看清的一格。
   */
  currentPlatformModelId?: string | null
): Record<string, ComposerModelOption> | null {
  const harness = sanitizeHarnessModelOptions(harnessOptions);
  // 只列点得中、跑得起来的(#7056):要会员的、他在设置「模型」页关掉的都不进下拉 —— 见 `offeredInModelPicker`。
  const platformModels = catalogModels.filter(
    (model) => offeredInModelPicker(model) || model.id === currentPlatformModelId
  );
  if (!harness && platformModels.length === 0) return null;

  return {
    ...Object.fromEntries(
      Object.entries(harness ?? {}).map(([id, option]) => [
        id,
        decorate(option, id, decor?.ownTierLabel, decor?.icon),
      ])
    ),
    ...Object.fromEntries(
      platformModels.map((model) => [
        platformOptionId(model.id),
        decorate(platformComposerOption(model), model.id, null, decor?.icon),
      ])
    ),
  };
}
