import type { InstallationReading } from '@shared/core/agents/agent-payload';
import type { SessionMessageValues } from '@renderer/localization/locale-store';
import type { SessionMessageLookupKey } from '@renderer/localization/messages';

type Translate = (key: SessionMessageLookupKey, values?: SessionMessageValues) => string;

/**
 * @@@task-fusion (#2802) — composer 的 agent 选择器按安装状态**分组**。
 *
 * 第一版是给每个没装的 agent 挂一枚行尾标签「尚未安装」。真渲染出来 owner 判「设计不行」,
 * 复盘确实站不住:34 个 agent 里 32 个没装,于是同一句话在一列里重复 32 遍——那不是信号是
 * 噪声;标签还把行宽吃掉,「GitHub Copilot」被截成「GitH…」,认不出是哪个 agent。
 *
 * 改成分组:一句话说一次,由组头说。这也不是新发明——`ComposerAgentOption.groupLabel` 的注释
 * 写的就是 `'Installed' / 'Not installed'`;这里只是让 composer 跟它一致,而不是自造第二套表达。
 *
 * #6101:分组的键从 `DependencyStatus` 换成四态读数 `InstallationReading`,措辞也换成抽屉
 * 卡头那一套 —— 从前 composer 说「检测失败」、同一台机器上的列表说「未安装」、抽屉说
 * 「读不出版本」,三处说三套话,而用户的下一步动作完全不同。词表只有 `READING_LABEL_KEY` 一张。
 */
export type AgentGroupKey = InstallationReading;

/**
 * 四态各自的**词**与在下拉里的先后。
 *
 * 词一律取抽屉卡头那一套(它是用户读到最细的那一处,也是唯一说得出「读不出版本」与
 * 「你选的那一份不在了」区别的地方)。手机端建会话页走另一套 i18n,词在它自己的词表里,
 * 由 `agent-reading-vocabulary.test.ts` 逐格比对,❌ 不靠人记得同步。
 *
 * `selectable`:只有探测明确说「能跑」才让选。`missing`(选中那一份没了)仍然可选 ——
 * 运行时会回落到自动解析,那一份确实起得来,把它变成死行是另一种谎。
 */
const GROUPS: Record<
  AgentGroupKey,
  { labelKey: SessionMessageLookupKey; order: number; selectable: boolean }
> = {
  installed: { labelKey: 'agentsPage.installed', order: 0, selectable: true },
  missing: { labelKey: 'agentsPage.selectedCopyGone', order: 1, selectable: true },
  'detected-but-broken': { labelKey: 'agentsPage.stateBroken', order: 2, selectable: false },
  'not-detected': { labelKey: 'agentsPage.notInstalled', order: 3, selectable: false },
};

/** 四态 → 词表 key。界面上任何一处要给这四态写字,都从这里取。 */
export function readingLabelKey(reading: InstallationReading): SessionMessageLookupKey {
  const group = GROUPS[reading];
  if (!group) {
    // 类型上到不了这里。真到了说明有人喂了不在 `InstallationReading` 里的值(实际发生过:一份
    // 残缺的测试 fixture 没带 status)。响亮报出是哪个值,而不是返回 undefined,让调用方
    // 在几层之外炸出一句 "cannot read 'selectable' of undefined"。
    throw new Error(`未知的 agent 安装读数: ${JSON.stringify(reading)}`);
  }
  return group.labelKey;
}

export function agentGroupLabel(reading: InstallationReading, translate: Translate): string {
  return translate(readingLabelKey(reading));
}

/** 只有探测明确说「可用」才让选。缺证据一律不可选,不猜。 */
export function isAgentSelectable(reading: InstallationReading): boolean {
  readingLabelKey(reading);
  return GROUPS[reading].selectable;
}

/**
 * 没装的 agent 那一行的动作。
 *
 * owner 实遇:在新建会话的选择器里点一个没装的 agent,什么都不发生(先前甚至能选中,然后在
 * 会话启动时才炸)。它不该是死行 —— 点它就是「带我去装」。文案静息不显示(见 composer 的
 * `agentRowAction` 样式:32 行各挂一枚同样的标签是噪声),指到那行、或那行正在装才显出来。
 */
export function agentRowAction(
  installing: boolean,
  translate: Translate
): {
  label: string;
  busy: boolean;
  busyLabel: string;
} {
  return {
    label: translate('composer.agentInstall'),
    busy: installing,
    busyLabel: translate('composer.agentInstalling'),
  };
}

/**
 * 按组排序 —— 能用的排在最前。
 * 下拉的分组顺序取决于 options 数组里各组**首次出现**的先后(见 session-ui 的 buildAgentGroups),
 * 所以顺序必须在这里定死,不能指望调用方传进来时就是对的。组内保持原有顺序(稳定排序)。
 */
export function sortAgentsByAvailability<T extends { reading: InstallationReading }>(
  agents: readonly T[]
): T[] {
  return [...agents].sort((a, b) => {
    readingLabelKey(a.reading);
    readingLabelKey(b.reading);
    return GROUPS[a.reading].order - GROUPS[b.reading].order;
  });
}
