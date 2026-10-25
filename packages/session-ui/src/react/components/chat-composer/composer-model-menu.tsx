/**
 * 模型 + 推理强度 —— 底排右组那颗触发器，以及它点开的**一层**面板。
 *
 * 从 `index.tsx` 拆出来（#4981 A1，理由见 `composer-options.ts` 顶部）。渲染出来的 DOM、
 * `data-slot` / `data-testid` / 类名 / 结构层级与 dev 上 #5110 那版逐字节相同 —— 它们是对外契约
 * （见 `index.tsx` 顶部的 slot 词汇表），`composer-model-menu-3249.test.tsx`、
 * `composer-settings-row-layout.test.tsx`、`composer-surface-3334.test.tsx` 正按它们选元素。
 *
 * ## 解剖（照 assistant-ui「With search, provider filters + groups」那一版）
 *
 * owner 2026-09-05 令严格套用;上游 demo 源码见
 * apps/docs/components/pages/docs/samples/model-selector.tsx。
 * 上游那版是**一层**面板:搜索框 → 厂商药丸 → 分组清单 → 底部 Thinking 行。
 * 原来「设置菜单 → 模型子菜单 / 强度子菜单」两级拍平成一层 —— 模型和强度本来就是同一次
 * 决定的两半,分两级要多点两下才看得见档位。
 *
 * ⚠️ **推翻了旧注释**「❌ 不再给模型列表配搜索框:声明了模型的 5 家最多 6 个」——
 * 那句话写在平台模型进这个下拉**之前**;现在一份清单里是 harness 自己那几个 + 咕咕十几个,
 * owner 2026-08-28 已经报过「我翻了半天才找到」。前提变了,结论跟着变。
 *
 * ⚠️ 底座是 Base UI(与旁边 agent 选择器同一套),❌ 不装 @assistant-ui/react(仓规:那会带进
 * Radix 与第二份 runtime)。上游那版的过滤条本身用的就是 Base UI 的 ToggleGroup/Toggle,
 * 这一段是逐件对应,不是另起炉灶。
 *
 * ## 两级分类(owner 2026-09-06 定)
 *
 * 一级 = **这条是谁的**(组头);二级 = **厂商**(顶部筛选药丸 + 行内 logo,❌ 不分组)。
 * 理由在产品上:用户先要决定的是这次调用记在谁账上,厂商是在那之后才挑的。
 */
import React, { useEffect, useId, useState } from 'react';
import { RotateCcw, Search } from '../../../icons';
import { Combobox } from '@session-ui/react/primitives/combobox/combobox';
// 上游那版的过滤条用的就是 Base UI 的这两件(见 model-selector.tsx 的
// `import { ToggleGroup } from "@base-ui/react/toggle-group"`)—— 逐件对应,不是另起炉灶。
import { ToggleGroup } from '@base-ui/react/toggle-group';
import { Toggle } from '@base-ui/react/toggle';
// 「思考」那一段是**一条有序标尺**,所以是 Slider 而不是一组单选药丸 ——
// 见 chat-composer.css.ts 的 modelEffortRow 抬头(owner 2026-09-17 指定)。
// ❌ 别退回 RadioGroup:并列选项这个语义本身就说不出"深浅"。
import { Slider } from '@base-ui/react/slider';
import type { ComboboxRootChangeEventDetails } from '@base-ui/react/combobox';
// 悬浮详情卡与 agent 选择器那张(ComboboxPopover)是同一个原语:同样的开关延时、同样不吃掉父面板的关闭。
import {
  HoverCard,
  isEventInsideInteractiveLayer,
  useHoverCard,
} from '@session-ui/react/primitives/hover-card';
import { useMessages } from '../../localization/message-provider';
import * as styles from './chat-composer.css';
// 圆钮直径的**唯一真源** —— 填充末端要落在圆心上,这里跟着它算,❌ 别再写一遍字面量。
import { EFFORT_THUMB_VAR } from './chat-composer.css';

import type {
  ComposerEffortItem,
  ComposerModelGroup,
  ComposerModelItem,
  ComposerModelUnlock,
  ComposerModelUpgrade,
} from './composer-options';

/** 底部「升级解锁」那一条在悬浮卡控制器里的 key —— 模型 id 都不会是这个串。 */
const UPGRADE_DETAIL_KEY = '\u0000upgrade';

/** 厂商过滤条一行最多几格 —— 264px 里第五格就放不下 `Anthropic` 了。 */
const PROVIDER_FILTER_MAX_COLUMNS = 4;

/**
 * 厂商过滤条每行几格:先算要几行,再按行均分 —— 5 家排成 3 + 2,而不是 4 + 1 留一格孤零零挂在第二行。
 */
export function providerFilterColumns(count: number): number {
  const rows = Math.ceil(count / PROVIDER_FILTER_MAX_COLUMNS);
  return Math.ceil(count / rows);
}

/**
 * @@@composer-model-trigger-label — 常驻触发器上剥掉括号,清单里保留全名。
 *
 * owner 2026-09-07:「一般括号里的信息确实是可以忽略的,或者渐进披露的」。
 * 括号内容(`Opus (1M context)` 的那半)是**规格**不是身份:底排那颗按钮的职责是回答
 * 「我现在用的是谁」,一眼扫过去要短;规格是打开清单挑的时候才需要分辨的。
 *
 * ⚠️ 所以这条**只作用于触发器**。清单里必须留全名 —— Claude Code 的目录里
 * `Opus` 与 `Opus (1M context)` 同时存在,剥了就变成两条一模一样的、选不出来。
 * 判据钉在 `composer-model-menu-3249.test.tsx`:剥后触发器短、清单两条仍可分辨。
 *
 * 剥不干净就原样返回(全名就是一对括号时,剥完是空串)—— 宁可长,不可空。
 */
const MODEL_PARENTHETICAL = /\s*[（(][^()（）]*[)）]/g;

function stripModelParenthetical(label: string): string {
  return label.replace(MODEL_PARENTHETICAL, '').replace(/\s{2,}/g, ' ').trim();
}

/**
 * ⚠️ 括号也可能**就是身份**(#6335):Antigravity 的目录是 `Gemini 3.8 Flash (High)` /
 * `(Medium)` / `(Low)` 三条,没有一条叫光秃秃的 `Gemini 3.8 Flash` —— 剥掉以后三档长得
 * 一模一样,底排那颗按钮就答不出「我现在用的是谁」。判据:剥后的名字被**两条以上**共享、
 * 且清单里**没有**一条本来就叫这个名字 ⇒ 括号是变体身份,留全名。
 * Claude 那对(`Opus` 与 `Opus (1M context)`)不受影响:`Opus` 本身在清单里,括号仍是规格。
 * `siblings` 是同一张清单里各条触发器会用的名字(不传 = 旧行为,一律剥)。
 */
export function composerModelTriggerLabel(label: string, siblings: readonly string[] = []): string {
  const stripped = stripModelParenthetical(label);
  if (!stripped) return label;
  if (stripped !== label && !siblings.includes(stripped)) {
    const sharing = siblings.filter((name) => stripModelParenthetical(name) === stripped).length;
    if (sharing >= 2) return label;
  }
  return stripped;
}

// ── Model groups ──────────────────────────────────────────────────────────────

/**
 * 把模型条目按**相邻**的同组头切成若干段。
 *
 * ❌ 不照 buildAgentGroups 用 Map 按 label 收集:那会把不相邻的同名条目搬到一起,悄悄改掉
 * 调用方给的顺序。加个小标题不该有重排的副作用 —— 顺序是宿主排的,这里只切段。
 *
 * 一条都没有 groupLabel 时结果是「一段、label 为空」,渲染成原来的平铺列表(零回归)。
 */
export function buildComposerModelGroups(items: ComposerModelItem[]): ComposerModelGroup[] {
  const groups: ComposerModelGroup[] = [];
  for (const item of items) {
    const label = item.groupLabel ?? '';
    const last = groups[groups.length - 1];
    if (last && last.label === label) last.items.push(item);
    else groups.push({ label, items: [item] });
  }
  return groups;
}

// ── Model panel shape ─────────────────────────────────────────────────────────

/** 模型面板长什么样:开不开,以及「模型」那一行由谁占。 */
export type ComposerModelPanel =
  | { kind: 'hidden' }
  | { kind: 'shown'; modelRow: 'list' | 'none' };

/**
 * 面板的取舍抽成纯函数,是为了**能被判假**。
 *
 * 这段判断原本直接写在 JSX 的条件里,而 JSX 在本仓的可测范围之外(组件测在
 * `tests/unit/desktop/`,worktree 里跑不了)。⇒ 它坏掉时没有任何判据会红,
 * owner 2026-08-26 那次就是这么漏出去的:没登录 ⇒ 模型清单空 ⇒ 「模型」那一行
 * **整个不渲染**,面板上只剩「推理强度」。他的原话是「只有推理强度,反而没有模型」。
 *
 * 两条不变量,`model-groups.test.ts` 里逐条撞:
 *  · 有话可说就得开面板 —— 哪怕一个模型都没有,只要有「去登录」这条路(unlock)。
 *    ❌ 别退回「没模型就整颗触发器消失」:那样用户连「为什么没有模型」都无处可问。
 *  · 「模型」那一行不许静默消失 —— 有清单、或有登录入口,这一行就得在。
 *    只有两者皆无(既没模型也没登录入口,例如这家压根不声明模型轴)才空着。
 *
 * ⚠️ **2026-08-28 改了语义,别照旧版推理**:登录入口从前是「一个模型都没有时**顶掉**
 * 模型那一行」,于是它几乎永远不出现 —— 咕咕自家的模型一直在,清单从来不空。
 * 现在它是**清单里的一条**(渐进披露,owner 定):用户点开模型列表、正在挑模型的那一刻,
 * 才第一次看到「登录以使用 X 模型」。所以这里只判「这一行要不要在」,
 * 「登录那条摆在哪」由 `ComposerModelUnlock` 在清单内部决定。
 */
export function resolveComposerModelPanel(input: {
  modelCount: number;
  effortCount: number;
  unlock: boolean;
}): ComposerModelPanel {
  const modelRow = input.modelCount > 0 || input.unlock ? 'list' : 'none';
  if (modelRow === 'none' && input.effortCount === 0) return { kind: 'hidden' };
  return { kind: 'shown', modelRow };
}

// ── Model tooltip ─────────────────────────────────────────────────────────────

function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(0)}K tokens`;
  return `${tokens} tokens`;
}

/**
 * 模型条目的悬浮说明。原来这些信息在一张 hover 详情卡里,Codex 的设置面板没有那一层,
 * 卡片随弹层重构一起去掉了 —— 但 modelFeatures 是插件真声明过的数据,不能跟着卡片一起
 * 消失,所以折进条目的 title,信息还在,只是不再占一块面板。
 */
export function modelTitle(item: ComposerModelItem): string | undefined {
  const parts: string[] = [];
  if (item.description) parts.push(item.description);
  const f = item.modelFeatures;
  if (f?.contextWindowSize !== undefined) parts.push(`Context ${formatContextWindow(f.contextWindowSize)}`);
  if (f?.speed !== undefined) parts.push(`Speed ${f.speed}/5`);
  if (f?.intelligence !== undefined) parts.push(`Intelligence ${f.intelligence}/5`);
  return parts.length > 0 ? parts.join(' · ') : undefined;
}

/**
 * 悬浮详情卡里的一条模型(#7056,对齐 Cursor 那张):名字 → 这条是谁的 → 一句话说明 → 事实两列 → 选不了的原因。
 * 事实里上下文、速度、智能来自 `modelFeatures`(插件 / 目录真声明过的),其余由宿主翻好递进来(`facts`)。
 * 什么都没有的那几格就不画 —— ❌ 写「未知」占位。
 */
function ModelDetail({ item }: { item: ComposerModelItem }) {
  const { translate } = useMessages();
  const f = item.modelFeatures;
  const facts = [
    ...(f?.contextWindowSize !== undefined
      ? [{ label: translate('composer.modelDetailContext'), value: formatContextWindow(f.contextWindowSize) }]
      : []),
    ...(item.facts ?? []),
    ...(f?.speed !== undefined ? [{ label: translate('composer.modelDetailSpeed'), value: `${f.speed}/5` }] : []),
    ...(f?.intelligence !== undefined
      ? [{ label: translate('composer.modelDetailIntelligence'), value: `${f.intelligence}/5` }]
      : []),
  ];
  return (
    <div data-slot="composer-model-detail" style={{ display: 'contents' }}>
      <div className={styles.modelDetailHead}>
        {item.icon && (
          <span className={styles.modelTriggerIcon} aria-hidden="true">
            {item.icon}
          </span>
        )}
        <span className={styles.modelDetailName}>{item.name}</span>
      </div>
      {item.groupLabel && <div className={styles.modelDetailTier}>{item.groupLabel}</div>}
      {item.description && <p className={styles.modelDetailSummary}>{item.description}</p>}
      {facts.length > 0 && (
        <dl className={styles.modelDetailFacts}>
          {facts.map((fact) => (
            <React.Fragment key={fact.label}>
              <dt className={styles.modelDetailFactLabel}>{fact.label}</dt>
              <dd className={styles.modelDetailFactValue}>{fact.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
      {item.disabled && item.disabledReason && (
        <p className={styles.modelDetailSummary}>{item.disabledReason}</p>
      )}
    </div>
  );
}

// ── The menu ──────────────────────────────────────────────────────────────────

export interface ComposerModelMenuProps {
  /** `resolveComposerModelPanel` 的结果。`hidden` 时整颗触发器不渲染。 */
  panel: ComposerModelPanel;
  disabled?: boolean;
  /**
   * 触发器的 `title`。⚠️ 传进来的是**当前 agent** 的说明而不是模型的 —— 这是既有行为，
   * 搬家时原样保留；要改得单独立判据，别在一次纯搬运里顺手改掉。
   */
  triggerTitle?: string;
  modelItems: ComposerModelItem[];
  selectedModel?: string;
  onModelChange?: (modelId: string) => void;
  /**
   * 宿主要把模型面板打开(例如「这个模型要会员」那一行上的「换模型」,#7056)。每变一次开一次;0 / 缺省 = 不开。
   * ❌ 宿主去 DOM 里找触发器 click —— 那是拿测试锚点当产品接口。
   */
  openRequest?: number;
  modelUnlock?: ComposerModelUnlock | null;
  onModelUnlock?: () => void;
  /** 底部「管理模型」:宿主打开设置里的「模型」那一页(#7056)。不给 = 不画。 */
  onManageModels?: () => void;
  /** 底部「升级解锁更多模型」(免费档才有,见 `ComposerModelUpgrade`)。 */
  modelUpgrade?: ComposerModelUpgrade | null;
  onModelUpgrade?: () => void;
  effortItems: ComposerEffortItem[];
  selectedEffort?: string;
  onEffortChange?: (effortId: string) => void;
  defaultEffort?: string;
}

export function ComposerModelMenu({
  panel,
  disabled = false,
  triggerTitle,
  modelItems,
  selectedModel,
  onModelChange,
  openRequest,
  modelUnlock,
  onModelUnlock,
  onManageModels,
  modelUpgrade,
  onModelUpgrade,
  effortItems,
  selectedEffort,
  onEffortChange,
  defaultEffort,
}: ComposerModelMenuProps) {
  const { translate } = useMessages();

  /**
   * 厂商过滤条选了哪几家。**空集 = 不过滤**(上游原话:An empty filter means no
   * filtering — all providers are shown)。❌ 别把「一个都没选」实现成「一条都不显示」:
   * 那会让用户一进面板就看见空清单。
   */
  const [modelProviderFilter, setModelProviderFilter] = useState<ReadonlySet<string>>(new Set());
  const [modelPanelOpen, setModelPanelOpen] = useState(false);
  /**
   * 拖动中的档位 —— **本地**状态，不绕宿主。
   *
   * ⚠️ owner 2026-09-18:「按钮没有拖拽动画，很死板很僵硬」。两个僵硬源，这是第一个：
   * 原来填充与刻点是由 `selectedEffort` 这个 prop 画的，而 prop 要等
   * `onEffortChange → 宿主 setState → 回传` 绕一圈才变。拖动中每跨一格都绕一圈，
   * 圆钮（由 Base UI 内部值驱动，立刻动）与填充（等回传）之间就错开一拍。
   * ⇒ 拖动期间一律读本地值，松手才把最终那一档交给宿主。
   */
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  /**
   * 说明行的 id —— 圆钮用 `aria-describedby` 指过来,读屏器才念得到「为什么改不了」。
   * ⚠️ 必须排在下面那个早退**之前**:hook 的调用顺序每次渲染都得一样。
   */
  const effortHintId = `${useId()}-effort-hint`;
  useEffect(() => {
    if (openRequest) setModelPanelOpen(true);
  }, [openRequest]);
  /**
   * 悬浮详情卡(#7056,对齐 Cursor):指到哪一行,卡就贴着那一行出现在面板旁边。
   * ⚠️ 这三个 hook 同样必须排在早退之前。
   */
  const detailCard = useHoverCard();
  const [detailAnchor, setDetailAnchor] = useState<HTMLElement | null>(null);
  const [panelEl, setPanelEl] = useState<HTMLElement | null>(null);

  if (panel.kind !== 'shown') return null;

  /**
   * 一行(或底部那条)的悬停:记下贴哪一条,再交给控制器去延时开卡。
   * ⚠️ 卡贴的必须是**和面板一样宽**的那一条(整行 / 整条底栏)—— 贴在右端那枚按钮上,卡会往左压回面板里
   * (实机截图里盖住了半张清单)。
   */
  const detailHoverProps = (key: string) => {
    const row = detailCard.getRowHoverProps(key);
    return {
      onMouseEnter: (event: React.MouseEvent<HTMLElement>) => {
        setDetailAnchor(
          event.currentTarget.closest<HTMLElement>('[data-slot="composer-model-footer"]') ?? event.currentTarget
        );
        row.onMouseEnter(event);
      },
      onMouseLeave: row.onMouseLeave,
    };
  };
  const detailItem =
    detailCard.activeKey && detailCard.activeKey !== UPGRADE_DETAIL_KEY
      ? (modelItems.find((m) => m.id === detailCard.activeKey) ?? null)
      : null;
  const showUpgradeDetail = detailCard.activeKey === UPGRADE_DETAIL_KEY && !!modelUpgrade;

  const selectedModelItem = selectedModel
    ? (modelItems.find((m) => m.id === selectedModel) ?? null)
    : null;
  const selectedEffortItem = selectedEffort
    ? (effortItems.find((e) => e.id === selectedEffort) ?? null)
    : null;
  const defaultEffortItem = defaultEffort
    ? (effortItems.find((e) => e.id === defaultEffort) ?? null)
    : null;
  const resetEffortItem = defaultEffortItem ?? effortItems.find((e) => e.id === 'default');
  // The trigger and the Thinking row must describe the same effective level. A model default is
  // not an explicit user override, but it is still the level currently in effect when no override
  // exists; leaving it out of the radio value makes the trigger say one level while the panel says
  // that nothing is selected.
  const effectiveEffortItem = selectedEffortItem ?? defaultEffortItem;
  /**
   * 滑杆上的位置 = 这一档在目录里的**序号**。
   *
   * ⚠️ 顺序由 harness 自己给(目录是它经 ACP 报上来的那份,见 create-efforts.ts),
   * composer ❌ 不重排、也不按 id 猜深浅:全库那条规范阶梯
   * (`none < minimal < low < medium < high < xhigh < max < ultra`,见 effort-options.ts)
   * 只覆盖已知的词表,harness 自定义的档(claude 活会话报的 `Default` / `UltraCode`)不在里面。
   * 拿一条自编的顺序去画标尺,等于对用户宣称一个我们并不知道的深浅关系。
   */
  /**
   * 面板里**此刻显示**的那一档 —— 拖动中是圆钮下那一档，否则是已生效的那一档。
   *
   * 圆钮位置、读数、说明行、读屏器念的档名都只读这一个值(#6309:说明行曾读已生效那一档,
   * 拖动中圆钮走了、字没动,松手才跟上)。交给宿主仍只在松手时发生;「和当前档相同就不发」
   * 的判据比的是**已生效**那一档(`effectiveEffortItem`),❌ 别换成这个。
   */
  const shownEffortItem =
    (draggingIndex !== null ? effortItems[draggingIndex] : undefined) ?? effectiveEffortItem;
  /** 拖动中的那一档就是用户正在选的 —— 与「显式覆盖」同样不压暗。 */
  const shownIsUserPick = draggingIndex !== null || !!selectedEffortItem;
  const effortIndex = shownEffortItem
    ? effortItems.findIndex((e) => e.id === shownEffortItem.id)
    : -1;
  /**
   * 整条滑杆能不能动。
   *
   * 宿主置灰档位是**整组一起**的(会话中途读不到档位目录时,acp-chat-panel 对每一档都挂
   * `disabled` + 同一条原因)。滑杆是一条连续的轴,没有"跳过中间某一档"的表达方式 ——
   * 所以只要有一档动不了就整条动不了,并把那条原因挂上去。
   * ❌ 不做"部分可选"的假象:那会让用户拖到一档、手一松又弹回去。
   */
  const lockedEffort = effortItems.find((e) => e.disabled) ?? null;
  const effortLocked = lockedEffort !== null;
  // ⚠️ 回落到**固定文案**,❌ 不回落到 `description`:那是"这一档有多深"的说明,
  // 摆在"为什么改不了"的位置上答非所问,而且取的还是目录里第一个被禁的那条、
  // 未必是当前这一档。宿主没给原因是宿主的 bug,这里给一句诚实的通用话,别拿别的话充数。
  const effortLockedReason = lockedEffort
    ? (lockedEffort.disabledReason ?? translate('composer.effortLocked'))
    : undefined;
  /** 目录里有没有说明文字 —— 决定读数下面那一行占不占位(见 modelEffortHint 抬头)。 */
  const effortHasHints =
    effortItems.some((e) => !!e.description) || effortLocked || !shownEffortItem;
  /**
   * 读数下面那一行说什么 —— 锁住了先说为什么,其次说当前这一档是干嘛的,
   * 一档都没选时说"由引擎自己定"。`title` 与读屏器取的都是这一份,别再各写一遍。
   */
  const effortHintText = effortLocked
    ? (effortLockedReason ?? '')
    : shownEffortItem
      ? (shownEffortItem.description ?? '')
      : translate('composer.effortUnset');
  /** 复位钮只在「你改过、且改到了默认档之外」时出现 —— 见 modelEffortReset 那段。 */
  const canResetEffort =
    !effortLocked && !!onEffortChange && !!selectedEffortItem && !!resetEffortItem &&
    selectedEffort !== resetEffortItem.id;

  // 选中项要**从清单里取同一个对象**递给 Combobox:它按 isItemEqualToValue 比,
  // 但触发器上的回显走的是这个值 —— 现拼一个新对象会让「当前选中」在重渲染间抖。
  const selectedModelEntry = selectedModelItem
    ? { ...selectedModelItem, id: selectedModelItem.id }
    : null;

  /**
   * 这一列要不要留出图标位。
   *
   * ⚠️ 判据是「**有没有条目认得出厂商**」,不是「这一条认不认得出」。实机撞到的:claude 的
   * 「Default (recommended)」不带任何厂商词根 ⇒ 认不出 ⇒ 那一行不画图标位 ⇒ 名字比其余 18 行
   * **左移 22px**,而它恰好是列表第一条。缺一枚 logo 只是信息少一点,整行错位看着就是坏了。
   * ⇒ 只要这一列有人有图标,所有行都留位;整列都没有(某些 harness)才不留 —— 那时不存在错位。
   */
  const anyModelIcon = modelItems.some((m) => m.icon);

  /**
   * 药丸 = **厂商**(二级),按它们在清单里的先后(= 屏幕上的先后)。
   *
   * ❌ 不排序:顺序是宿主定的产品决定(用户自己那档在前)。
   * ⚠️ 同一家厂商在两档里各出现一次时**只出一枚药丸** —— 药丸问的是「哪家厂商」,
   * 一家出两枚会让人以为是两家。
   */
  const modelProviderLabels = [
    ...new Set(modelItems.map((m) => m.providerLabel).filter((l): l is string => Boolean(l))),
  ];

  /**
   * 厂商过滤**作用在条目上,不是整段上** —— 厂商横切在两档之上,筛 OpenAI 要把两档里的
   * OpenAI 条目都留下。先筛条目再切段,于是空掉的那一档自然消失,留下的组头照旧。
   */
  const visibleModelGroups = buildComposerModelGroups(
    modelProviderFilter.size === 0
      ? modelItems
      : modelItems.filter((m) => m.providerLabel && modelProviderFilter.has(m.providerLabel))
  );

  return (
    // `display:contents` —— 这层只为寻址存在,不参与布局(工具栏是 flex,
    // 真占一个盒子会把间距挤歪)。上游给触发器挂的是 `model-selector-trigger`,
    // 本仓 primitive 自己的 data-slot 不许被调用点顶掉(见 combobox 的
    // FixedDataSlotProps),所以那个名字落在外面这一层。
    <span data-slot="composer-model" style={{ display: 'contents' }}>
      <Combobox.Root
        // items 必须传:Combobox 的 filter 只作用于它自己持有的 items。
        // 同 agent 选择器踩过的那个坑(能打字、一行都不过滤)。
        items={visibleModelGroups}
        value={selectedModelEntry}
        onValueChange={(item: ComposerModelItem | null) => {
          if (!item) return;
          detailCard.close();
          onModelChange?.(item.id);
          setModelPanelOpen(false);
        }}
        open={modelPanelOpen}
        onOpenChange={(next: boolean, details: ComboboxRootChangeEventDetails) => {
          // 鼠标移进悬浮卡不算「离开面板」:与 ComboboxPopover 同一条判据,❌ 一碰卡面板就关。
          if (!next && isEventInsideInteractiveLayer(details.event, panelEl)) {
            details.cancel();
            return;
          }
          if (!next) detailCard.close();
          setModelPanelOpen(next);
        }}
        isItemEqualToValue={(a: ComposerModelItem, b: ComposerModelItem) => a.id === b.id}
        // 上游:匹配 id、name 与 keywords(它的 demo 正是把厂商名放在 keywords 里)。
        // 本仓没有 keywords 字段,两级分类承担同一职责 —— 打「咕咕」筛得出平台那一档
        // (一级),打「智谱」筛得出那一家(二级)。
        filter={(item: ComposerModelItem, query: string) => {
          const q = query.toLowerCase();
          return (
            item.name.toLowerCase().includes(q) ||
            item.id.toLowerCase().includes(q) ||
            (item.groupLabel ?? '').toLowerCase().includes(q) ||
            (item.providerLabel ?? '').toLowerCase().includes(q)
          );
        }}
        autoHighlight
      >
        <Combobox.Trigger
          className={styles.agentTrigger}
          disabled={disabled}
          title={triggerTitle}
          // 这颗触发器的可访问名是「当前模型名」——会随选择变化,拿它定位等于拿一个
          // 动态值当锚点。旁边还有别的弹层按钮(用户菜单),按序数取第一个会抓到那个
          // (实测抓到了「设置/会员与额度/退出登录」)。给它一个稳定锚点。
          data-testid="composer-model-trigger"
        >
          {/* 上游的触发器同样先画一枚厂商 logo(`ModelSelectorValue` 里
              `{selectedModel.icon && <ModelIcon>}`)—— 收起状态下也一眼看出这条会话
              跑的是谁家的模型。 */}
          {selectedModelItem?.icon && (
            <span className={styles.modelTriggerIcon} aria-hidden="true">
              {selectedModelItem.icon}
            </span>
          )}
          {/* 触发器的名字是解剖里独立的一格(旁边还有厂商图形与强度档),给它自己的 slot ——
              判据要能只读这一格:整颗触发器的 textContent 会把强度档("中")粘在名字后面。 */}
          <span data-slot="composer-model-trigger-label" className={styles.modelTriggerLabel}>
            {/* 括号在这里剥掉,清单里不剥 —— 见 @@@composer-model-trigger-label。 */}
            {selectedModelItem
              ? composerModelTriggerLabel(
                  selectedModelItem.shortName ?? selectedModelItem.name,
                  modelItems.map((m) => m.shortName ?? m.name)
                )
              : translate('composer.model')}
          </span>
          {/* 强度就地显示(如「5.6 Sol 轻度」)。armed 的用 muted;
              没 armed 时退回该模型自己的默认档,再压一档不透明度 —— 那是目录里的出厂
              默认,用户写在 ~/.codex/config.toml 里的值会盖过它,我们读不到。 */}
          {effectiveEffortItem ? (
            <span
              data-slot="composer-effort"
              className={styles.modelTriggerEffort}
              style={{ opacity: selectedEffortItem ? 1 : 0.6 }}
            >
              {effectiveEffortItem.name}
            </span>
          ) : null}
          {/* @@@composer-no-chevron — ❌ 不画下拉箭头(owner 2026-09-07:「下拉按钮这个 icon
              都删除」,底排三枚一并撤)。三枚箭头本身不携带信息:一个 hover 会变底色的药丸,
              点开就是清单,箭头只是把同一件事再说一遍,却占掉三份横向空间 ——
              而这一排正是「放不下」压力最大的地方(见 use-toolbar-disclosure)。
              ⚠️ 09-05 owner 曾就**渐进披露把箭头当一档收掉**判过「箭头收了不合适」;
              09-07 是看着去箭头的设计稿定的「都删除」,按新的来。要翻回去,这三处一起加回。 */}
        </Combobox.Trigger>
        {/* 定宽 18rem = 上游 `w-72`(288px)。
            ⚠️ 这里替掉的是 #5082 的 `width="content"` —— 那条修的是「面板跟着**触发器**宽度
            走」(`--anchor-width`,只有十几个字符宽,于是标签折两行、模型名折行被下沿裁掉)。
            288px 比触发器宽得多,同一个病照样治好;差别只在超长名字是省略号还是把面板撑宽,
            而上游那版就是省略号(`truncate`)。owner 2026-09-06 在实机上看过这一版并认可。
            ⇒ 换了机制、没丢那条修复;要回到「按内容撑宽」,改这一个 className 即可。 */}
        <Combobox.Content ref={setPanelEl} className={styles.modelPanelContent}>
          {panel.modelRow === 'list' ? (
            <>
              <Combobox.Input
                showTrigger={false}
                // 上游的 CommandInput 自带一枚放大镜,少了它这一格看着像个普通文本框。
                leftAddon={<Search />}
                aria-label={translate('composer.searchModels')}
                placeholder={translate('composer.searchModels')}
                data-testid="composer-model-search"
              />
              {/* 厂商过滤条 —— 上游那排药丸就是厂商(OpenAI / Google / xAI / DeepSeek
                  / Groq),本仓照抄这根轴。
                  ⚠️ 只有一家时不渲染:一枚药丸筛不出任何东西,是纯噪音。
                  ⚠️ 空选 = 不过滤(上游同款语义:An empty filter means no filtering)。
                  ⚠️ ❌ 别把「你的 / 咕咕提供的」摆回这排 —— 那是一级分类,组头说。 */}
              {modelProviderLabels.length > 1 && (
                <div className={styles.modelFilterRow}>
                <ToggleGroup
                  multiple
                  value={[...modelProviderFilter]}
                  onValueChange={(next: unknown) =>
                    setModelProviderFilter(new Set((next as string[]) ?? []))
                  }
                  aria-label={translate('composer.filterByProvider')}
                  className={styles.modelProviderFilter}
                  // 等分(owner 2026-10-10:「按钮块的大小能保持一致,智谱那块太小了不好点」)。
                  // 一行最多四格 —— 264px 里放第五格,`Anthropic` 就放不下了;多出来的按行均分(7 家 = 4 + 3)。
                  style={{ gridTemplateColumns: `repeat(${providerFilterColumns(modelProviderLabels.length)}, minmax(0, 1fr))` }}
                  onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
                    // 照上游那三条键盘让路(它对着 cmdk 写,这里对着 Combobox 的输入框):
                    // Enter/Home/End 不许被列表抢走 —— 否则焦点在药丸上按回车,选中的
                    // 是高亮那条模型而不是切换这枚药丸。
                    if (e.key === 'Enter' || e.key === 'Home' || e.key === 'End') {
                      e.stopPropagation();
                    }
                    // 上下键把焦点交还给清单,与上游「matching the packaged Thinking row」同。
                    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
                      const input = e.currentTarget
                        .closest('[data-slot="combobox-content"], [role="dialog"]')
                        ?.querySelector<HTMLInputElement>('input');
                      input?.focus();
                    }
                  }}
                >
                  {modelProviderLabels.map((label) => (
                    <Toggle
                      key={label}
                      value={label}
                      className={styles.modelFilterChip}
                      // 等分之后长名字可能被截成省略号,悬停读得到全名。
                      title={label}
                      data-testid={`composer-model-provider-${label}`}
                    >
                      {label}
                    </Toggle>
                  ))}
                </ToggleGroup>
                </div>
              )}
              {/* 「去登录」排在清单**最前面**(owner 2026-08-28:放末尾时它躺在咕咕那
                  15 个模型下面,「我翻了半天才找到」)。
                  ❌ 不进 Combobox.List:它不是这份清单里的一个取值,选了它不会变成
                  「当前模型」;放在 List 外面才不会被读屏器报成一个可选项,也不会被
                  搜索过滤掉 —— 正在找模型的人更需要看见它。 */}
              {modelUnlock ? (
                <div className={styles.modelFilterRow}>
                  <span className={styles.modelEffortLabel}>{modelUnlock.groupLabel}</span>
                  <button
                    type="button"
                    className={styles.settingRowUnlock}
                    title={modelUnlock.title}
                    onClick={() => onModelUnlock?.()}
                    data-testid="composer-model-unlock"
                  >
                    {modelUnlock.label}
                  </button>
                </div>
              ) : null}
              <Combobox.List className={styles.settingSubContent}>
                {(group: ComposerModelGroup) => (
                  // key 用首条的模型 id,不用 label:同一个 label 可以出现在两段不相邻
                  // 的条目上(宿主的顺序说了算),用 label 当 key 就会撞。
                  <Combobox.Group key={group.items[0]?.id} items={group.items}>
                    {/* 组头 = 一级分类(这条是谁的)。与上游一样是一行纯文字。
                        厂商不在这里 —— 它在顶部那排筛选药丸和每行左边那枚 logo 上。 */}
                    {group.label && <Combobox.Label>{group.label}</Combobox.Label>}
                    <Combobox.Collection>
                      {(m: ComposerModelItem) => (
                        <Combobox.Item
                          key={m.id}
                          value={m}
                          // 置灰时 title 挂**原因** —— 那一刻用户要问的是「为什么不能选」
                          // (owner 2026-08-21:选不了的那一头要说明原因)。能选的行不挂 title:
                          // 规格在悬浮详情卡里,原生提示再弹一遍就是同一件事说两次。
                          title={m.disabled ? (m.disabledReason ?? modelTitle(m)) : undefined}
                          disabled={m.disabled}
                          className={`${styles.composerPanelItem} ${styles.modelPanelItemCompact}`}
                          {...detailHoverProps(m.id)}
                        >
                          {/* 上游每一行左边是**厂商 logo**(`ModelIcon`,14px 见方,
                              与首行基线对齐)。宿主给成品节点 —— 这个包够不到 app 的
                              图片资源。
                              ⚠️ 认不出厂商时**位子照留、内容为空**(见 `anyModelIcon`):
                              ❌ 不画一个通用占位图形(那是假装认得),❌ 也不收掉这一格
                              (那会让这一行的名字比别行左移 22px,实机上第一行正是如此)。 */}
                          {anyModelIcon && (
                            <span
                              className={styles.composerPanelItemIcon}
                              data-slot="composer-model-icon"
                              aria-hidden="true"
                            >
                              {m.icon}
                            </span>
                          )}
                          {/* 单行(#7056,owner 2026-10-10 看着 Cursor:「表达密度可以更丰富、更紧凑一点」):
                              只有名字。说明、倍率、上下文、推理档都在悬浮详情卡里 —— 行尾曾经写过倍率,
                              owner 同日:「卡片里已经展示过了,右侧就不要再展示了」。
                              ⚠️ 这里替掉的是 09-05 照 assistant-ui 做的两段式:那一版一屏只放得下五六条,
                              第二行又被 288px 截成省略号。要翻回去,连悬浮卡一起想。 */}
                          <span data-slot="composer-model-name" className={styles.modelPanelItemName}>
                            {m.name}
                          </span>
                        </Combobox.Item>
                      )}
                    </Combobox.Collection>
                  </Combobox.Group>
                )}
              </Combobox.List>
              <Combobox.Empty>{translate('composer.noMatchingModels')}</Combobox.Empty>
              {/* 底部两条去路(#7056):「管理模型」开设置里的「模型」页 —— 哪些出现在这张清单里由那一页的开关定;
                  「升级解锁更多模型」只给免费档,悬停看得到开会员后多出哪几个。
                  ❌ 不进 Combobox.List:它们不是取值,不该被读屏器报成可选项,也不该被搜索滤掉。 */}
              {(onManageModels || modelUpgrade) && (
                <div className={styles.modelPanelFooter} data-slot="composer-model-footer">
                  {onManageModels ? (
                    <button
                      type="button"
                      className={styles.modelPanelFooterAction}
                      onClick={() => {
                        detailCard.close();
                        setModelPanelOpen(false);
                        onManageModels();
                      }}
                      data-testid="composer-model-manage"
                    >
                      {translate('composer.manageModels')}
                    </button>
                  ) : (
                    <span />
                  )}
                  {modelUpgrade && (
                    <button
                      type="button"
                      className={styles.modelPanelUpgrade}
                      onClick={() => {
                        detailCard.close();
                        onModelUpgrade?.();
                      }}
                      data-testid="composer-model-upgrade"
                      {...detailHoverProps(UPGRADE_DETAIL_KEY)}
                    >
                      {modelUpgrade.label}
                    </button>
                  )}
                </div>
              )}
            </>
          ) : null}
          {/* 上游那段叫 **Thinking**,在 Content 最底下、清单之外,滚动列表时不跟着走。
              档位有几档、按什么顺序,都由 harness 说了算 —— codex 报 6 档、claude 活会话 7 档,
              ❌ 别按「Low/Med/High 三档」去裁:那是上游 demo 的取值,不是产品的。 */}
          {effortItems.length > 0 && (
            <div
              className={styles.modelEffortRow}
              data-slot="composer-effort-row"
              // 照上游那两段键盘让路(它对着 cmdk 写,这里对着 Combobox 的输入框):
              // **上下键属于模型清单**,而滑杆(与之前的 RadioGroup 一样)会把它们抢去。
              // 捕获阶段截住、把这次按键转交给输入框,焦点在滑杆上时才还能继续翻模型。
              // 左右键留给滑杆自己 —— 那是它调档位的手。
              onKeyDownCapture={(e: React.KeyboardEvent<HTMLDivElement>) => {
                if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
                const input = e.currentTarget
                  .closest('[data-slot="combobox-content"], [role="dialog"]')
                  ?.querySelector<HTMLInputElement>('input:not([type="range"])');
                // 目录一个模型都没有时搜索框不渲染 —— 那也不该让上下键掉到滑杆上去改档位
                // (实测:空目录时按一下 ArrowDown 会直接改档并关掉面板)。拦下来,不转交。
                if (!input) {
                  e.preventDefault();
                  e.stopPropagation();
                  return;
                }
                e.preventDefault();
                e.stopPropagation();
                input.focus();
                input.dispatchEvent(new KeyboardEvent('keydown', e.nativeEvent));
              }}
              onKeyDown={(e: React.KeyboardEvent<HTMLDivElement>) => {
                // Home/End:滑杆自己认(跳到最小/最大档),而外面的清单会把它们抢去跳到首尾。
                // ⚠️ 只在焦点**真的落在滑杆上**时才拦。这一行里还有复位钮:在它身上按 End
                // 时既跳不了档、又被这里吃掉,那一下什么也不会发生。
                if (e.key !== 'Home' && e.key !== 'End') return;
                if (!(e.target as HTMLElement).closest?.('input[type="range"]')) return;
                e.stopPropagation();
              }}
            >
              <div className={styles.modelEffortHeader}>
                <span className={styles.modelEffortLabel}>{translate('composer.effort')}</span>
                <span
                  className={styles.modelEffortValue}
                  data-slot="composer-effort-value"
                  // 置灰那一刻该说的是为什么,不是这一档的说明(同模型行)。
                  title={effortLocked ? effortLockedReason : shownEffortItem?.description}
                  // 没有覆盖时这是**模型自己的默认档**,压暗半档说明它不是你选的 ——
                  // 与触发器上那半档透明度是同一个说法(@@@composer-model-trigger-label)。
                  data-armed={shownEffortItem ? 'true' : 'false'}
                  style={{ opacity: shownIsUserPick || !shownEffortItem ? 1 : 0.6 }}
                >
                  {shownEffortItem?.name ?? translate('composer.default')}
                </span>
                {/* 当前这一档是干什么的 —— 跟在档名后面同一行(owner 2026-10-10:「思考那块显得特别大」,
                    原来它独占一行)。见 modelEffortHint 抬头:目录里只要有一档带说明就恒占这一格(空的也占)。
                    锁住时这里空着,原因单独起一行写全(见下)。 */}
                <span
                  className={styles.modelEffortHint}
                  data-slot={effortHasHints && !effortLocked ? 'composer-effort-hint' : undefined}
                  id={effortHasHints && !effortLocked ? effortHintId : undefined}
                  // 一行装不下时省略号会把话吃掉 —— 悬停至少还能把整句读出来。
                  title={!effortLocked && effortHintText ? effortHintText : undefined}
                >
                  {effortHasHints && !effortLocked ? effortHintText : null}
                </span>
                {canResetEffort && resetEffortItem && (
                  <button
                    type="button"
                    className={styles.modelEffortReset}
                    data-testid="composer-effort-reset"
                    title={translate('composer.effortReset')}
                    aria-label={translate('composer.effortReset')}
                    onClick={() => {
                      // ACP select options accept advertised value IDs, including a provider's default row.
                      onEffortChange?.(resetEffortItem.id);
                      setModelPanelOpen(false);
                    }}
                  >
                    <RotateCcw size={12} aria-hidden />
                  </button>
                )}
              </div>
              {/* 锁住时那句是**操作指引**(「创建任务时可以选」),挤在档名后面会被省略号吃掉后半句 ——
                  单独一行、最多两行写全。这一态整条会话不变,多一行不会让面板跳。 */}
              {effortLocked && (
                <span
                  className={styles.modelEffortLockedHint}
                  data-slot="composer-effort-hint"
                  id={effortHintId}
                  data-locked=""
                  title={effortHintText || undefined}
                >
                  {effortHintText}
                </span>
              )}
              {/* ⚠️ **恰好一档时不画滑杆**:量程会被撑成 0→1,右半条轨道拖得动却永远弹回,
                  唯一那个刻点还压在圆钮底下 —— 一条拖不动的死轨道。Smashing 与 Microsoft
                  的指南都说选项太少时滑杆不如别的控件,这里取最保守的一刀:只留读数。 */}
              {effortItems.length > 1 && (
              <>
              {/* 离散滑杆:一档一格。`thumbAlignment="edge"` 让最小档时圆钮**左缘**贴住轨道左缘
                  (而不是圆心贴左缘),那正是上游那个控件的样子;刻点层跟着缩进半个圆钮,
                  于是刻点与圆心逐像素对齐(见 EFFORT_THUMB_HALF)。 */}
              <Slider.Root
                className={styles.modelEffortSlider}
                min={0}
                max={effortItems.length - 1}
                step={1}
                largeStep={1}
                thumbAlignment="edge"
                disabled={effortLocked}
                // 一档都没生效时圆钮只能停在最左(滑杆没有"没有值"那个位置)——
                // 见 modelEffortControl 里 data-armed 那段:压暗 + 读数写「默认」把这一态
                // 与"你选了最低档"分开。
                data-armed={shownEffortItem ? 'true' : 'false'}
                value={effortIndex < 0 ? 0 : effortIndex}
                onValueChange={(next: number | number[], details: { reason: string }) => {
                  const index = Array.isArray(next) ? next[0] : next;
                  const picked = effortItems[index];
                  // 越界(不该发生,量程就是档位数 - 1)就当没发生 ——
                  // ❌ 别发一个 undefined 的档位 id 出去。
                  if (!picked) return;
                  // 拖动中:只动本地,界面立刻跟上;❌ 不每跨一格就往宿主发一次
                  // (那是上面 draggingIndex 注释里说的第一个僵硬源,顺带也少了 5 次无用往返)。
                  if (details.reason === 'drag' || details.reason === 'track-press') {
                    setDraggingIndex(index);
                    return;
                  }
                  setDraggingIndex(null);
                  if (picked.id === effectiveEffortItem?.id) return;
                  onEffortChange?.(picked.id);
                }}
                onValueCommitted={(_next: number | number[], details: { reason: string }) => {
                  // ⚠️ **键盘那条路不关面板**。Base UI 的方向键每按一下都会 commit,
                  // 跟着关的话键盘用户一次只调得动一格,六档从最低调到最高要开五次面板 ——
                  // 药丸那版一次按键 = 一个决定,滑杆的心智模型是"滑到想要的位置",
                  // 这是换控件带进来的新毛病(2026-09-17 找茬审查实测:按一下 ArrowRight
                  // 面板当场关闭)。键盘用 Esc / Enter 自己收。
                  // ⚠️ 键盘那条路**在这里什么都不做**:`onValueChange` 已经当场把它交出去了。
                  // 在这儿再发一次会**重复调用** —— 而那道「和当前档相同就跳过」的守卫拦不住它:
                  // 同一拍里 prop 还没回传,`effectiveEffortItem` 仍是旧值(自审 2026-09-18)。
                  if (details.reason === 'keyboard') return;
                  // 指针那条路相反:拖动全程只动本地,松手(或点轨道)才把最终那一档交给宿主。
                  const committed = Array.isArray(_next) ? _next[0] : _next;
                  const picked = effortItems[committed];
                  setDraggingIndex(null);
                  if (picked && picked.id !== effectiveEffortItem?.id) onEffortChange?.(picked.id);
                  // ⚠️ **这一句是刻意偏离上游的**:上游那个面板选完档位不关。但 #3249 是 owner
                  // 亲自报的、且明写「推理强度那组同样收起(与模型同一个毛病,别只修一半)」。
                  // 收在 committed 而不是 change 上:拖动过程中每跨一格都关一次面板,手还没松
                  // 控件就没了。键盘按一下也会 commit,所以键盘路径同样会收。
                  setModelPanelOpen(false);
                }}
              >
                <Slider.Control
                  className={styles.modelEffortControl}
                  title={effortLocked ? effortLockedReason : undefined}
                >
                  <Slider.Track className={styles.modelEffortTrack}>
                    <span
                      className={styles.modelEffortIndicator}
                      data-slot="composer-effort-indicator"
                      aria-hidden
                      style={{
                        // 见 modelEffortIndicator 抬头:末端 == **圆钮圆心**,所以整段躲在圆钮
                        // 底下,由圆钮那道 1px 环切出上游那条发丝缝。
                        // ⚠️ 最低档仍然是 0:那时填充会整段藏在圆钮下(圆头半径 12 内切于
                        // 圆钮半径 14),写 0 与写半个圆钮在屏幕上没有差别,而 0 更说得清
                        // 「一档都没走过」。
                        width:
                          effortIndex > 0
                            ? `calc((100% - var(${EFFORT_THUMB_VAR})) * ${
                                effortIndex / (effortItems.length - 1)
                              } + var(${EFFORT_THUMB_VAR}) / 2)`
                            : 0,
                      }}
                    />
                    <span className={styles.modelEffortTicks} aria-hidden>
                      {effortItems.map((e, index) => (
                        <span
                          key={e.id}
                          className={styles.modelEffortTick}
                          data-slot="composer-effort-tick"
                          data-testid={`composer-effort-${e.id}`}
                          // 严格小于:当前那一档的刻点正压在圆钮**底下**(刻点与圆心对齐),
                          // 写成 `<=` 等于给一个看不见的点上色。上游实测第 4/5 档时正好
                          // 三个亮点 + 一个灰点,也是这条。
                          data-filled={index < effortIndex ? '' : undefined}
                          style={{
                            // 逻辑属性:从右往左的语言里刻点要跟着滑杆一起翻面,
                            // 写死 `left` 会让刻点顺序与圆钮方向相反。
                            insetInlineStart:
                              effortItems.length > 1
                                ? `${(index / (effortItems.length - 1)) * 100}%`
                                : '0%',
                          }}
                        />
                      ))}
                    </span>
                    <Slider.Thumb
                      className={styles.modelEffortThumb}
                      aria-label={translate('composer.effort')}
                      // 读屏器念的是**档名**,不是序号 —— 「思考,3」什么也没说。
                      // ⚠️ 空串等于"不提供文字值",读屏器会退回去念 aria-valuenow,
                      // 也就是量程最小值 0 —— 看得见的人读到「默认/未指定」,
                      // 听的人听到「最低档」。两边必须说同一件事。
                      getAriaValueText={() =>
                        shownEffortItem?.name ?? translate('composer.effortUnset')
                      }
                      // 「为什么改不了」那句话挂在外层 div 的 title 上,读屏器取不到;
                      // 锁住时 input 还是 disabled,更取不到。这里显式指过去。
                      aria-describedby={effortHasHints ? effortHintId : undefined}
                    />
                  </Slider.Track>
                </Slider.Control>
              </Slider.Root>
              </>
              )}
            </div>
          )}
        </Combobox.Content>
        {(detailItem || showUpgradeDetail) && (
          <HoverCard
            anchor={detailAnchor}
            ownPopup={panelEl}
            controller={detailCard}
            // 面板贴着底排右侧往上开,右边常常没地方 —— 卡放左边,与 Cursor 同侧;贴不下时定位器自己翻。
            side="left"
            align="center"
            sideOffset={8}
            className={styles.modelDetailCard}
          >
            {detailItem ? (
              <ModelDetail item={detailItem} />
            ) : modelUpgrade ? (
              <div data-slot="composer-model-detail" style={{ display: 'contents' }}>
                <div className={styles.modelDetailName}>{modelUpgrade.title}</div>
                <ul className={styles.modelDetailList}>
                  {modelUpgrade.models.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </HoverCard>
        )}
      </Combobox.Root>
    </span>
  );
}
