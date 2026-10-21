import type { ComposerModelOption } from '@gugu/session-ui/react/components';
import type { HarnessCatalogState } from '@renderer/lib/stores/use-harness-model-catalog';
import { harnessCatalogToOptions } from './harness-model-field';

/**
 * @@@own-model-tier — 「你的 X 模型」这一档的**成员**从哪来。
 *
 * 这一档是**一个事实**:这家 harness 在**用户自己凭据**下经 ACP 报出来的那份清单
 * (协议出口只有一个:`session/new` 响应里 `category="model"` 的 `configOptions`)。
 * 它有两个观察点,同一个出口、同一份事实:
 *
 * - **活的 BYOK 会话**:进程就跑在那条凭据路上,它自己报的就是这份事实,而且最新;
 * - **主进程的 BYOK 探针目录**(`harness-model-catalog`):没有活 BYOK 会话时唯一看得见它的人。
 *   新建会话页与会话发现工具(`session_list_models`)读的都是它。
 *
 * ⚠️ **平台会话的活清单不是这份事实的观察。** 那条进程握的是咕咕的票,清单被票的 allowlist
 * 裁过,而且各家裁法不同:
 * - codex —— 平台会话的 app-server 拿到的 model catalog 只有网关那组(`codex-model-catalog.mjs`),
 *   它的 `model/list` 于是只报平台模型,自家模型一条不在;
 * - claude —— `--settings` 文档用 `modelPicker.replaceBuiltInOptions` + `availableModels`
 *   把整张选单**换成**平台那组(`capability-bundle.ts` 的 `claudeSettingsOverride`)。
 *
 * 两处**都是对的**:进程只握着一条凭据,拿平台的票去选 native 模型是错账,它们守的正是这条。
 * 错的是拿那份被裁过的清单当**菜单** —— 那等于把「这条会话此刻能热切什么」冒充成
 * 「用户能选什么」。而换一条计费路本来就允许重开会话(`planModelSwitch` 的 `reload`),
 * 所以菜单该有的成员比这条进程能热切的多。
 *
 * ⇒ 这个函数只回答成员问题。**哪几条现在切得动**由 `planModelSwitch` 拿活清单
 * (`advertised`)去判 —— 那才是活清单的职责,两件事分开之后各自只有一个来源。
 *
 * 症状来历(#5808):平台 codex 会话里「你的 Codex 模型」只剩咕咕目录**没有**的那一条;
 * 平台 claude 会话里整档消失。
 */
export function ownModelTierOptions(input: {
  /**
   * 这条会话的计费路 —— **三态**,而且三态各不相同:
   * - `own`:会话记录里**明确**写着 BYOK ⇒ 活会话就在用户那条凭据路上,它自己报的就是这份事实;
   * - `platform`:记录里写着一个咕咕模型 ⇒ 活清单被票裁过,看不见用户那条路;
   * - `unknown`:**没有记录**(存量会话、自动化任务、派生子会话),或目录还没回来/回不来。
   *
   * ⚠️ `unknown` ❌ 不能并进 `own`。并进去的后果是:平台目录还在路上的那几百毫秒(以及目录
   * 取不到时的**永远**),菜单又照那份被裁过的活清单画一遍 —— #5808 原样复发,而且这次是闪一下
   * 或一直如此,比原来更难归因。⇒ 只有**明确知道是 BYOK** 才用活清单;不确定就用探针目录,
   * 那份目录对两条路都是对的(它本来就是「用户自己凭据下的宇宙」)。
   */
  route: 'platform' | 'own' | 'unknown';
  /** 这条活会话的 ACP 现在报出来的清单。 */
  live: Record<string, ComposerModelOption> | null;
  /** 主进程那趟 BYOK 探针的状态(六态)。 */
  catalog: HarnessCatalogState;
}): Record<string, ComposerModelOption> | null {
  if (input.route === 'own') return input.live;
  // 六态里只有 `ready` 产出行,其余一律 null —— 与新建页逐字同一条规则
  // (`harnessCatalogToOptions`:读不到清单时**没有模型可选**,❌ 不退回插件静态表:
  //  列一张用户跑不了的模型正是咕咕红线里的 fake)。
  // ⚠️ 于是 `auth-required`(用户没登录这家 harness —— 平台额度用户最常见的形态)在这里是
  //   **空档**,与新建页同口径。新建页还会在清单里摆一条「登录解锁 X」,会话内这条入口还没接
  //   (gugu#5816);少的是入口,不是把一份错的清单顶上来。
  // ⚠️ `unsupported`(不说 ACP 的 agent)在 ACP 会话面上不可达 ⇒ 不喂静态表兜底。
  return harnessCatalogToOptions(input.catalog);
}
