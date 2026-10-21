import { describe, expect, it } from 'vitest';
import type { InstallationReading } from '@shared/core/agents/agent-payload';
import zhMobile from '@/i18n/locales/zh-CN/main';
import enMobile from '@/i18n/locales/en-US/main';
import {
  enUSCapabilityMessages,
  zhCNCapabilityMessages,
} from '@renderer/localization/messages-capabilities';
import { readingLabelKey } from './agent-availability-groups';

/** 词表按 key 查词。两份目录的 key 联合不同,这里只关心「这个 key 的词是什么」。 */
const zhSessionPage: Record<string, string> = zhCNCapabilityMessages;
const enSessionPage: Record<string, string> = enUSCapabilityMessages;

/**
 * 四态的**词**在两套 i18n 里各存一份:会话页(`messages-capabilities`)与手机端
 * (`i18n/locales`)。两套是产品现状,不是本次要动的东西 —— 但「同一个状态两处说两套话」
 * 正是 #6101 第三条要治的病:列表说「未安装」、下拉说「检测失败」、抽屉说「读不出版本」。
 *
 * ⇒ 这条用例逐格比对两套词表,❌ 不靠人记得同步。手机端那条通道只报得出
 * `DependencyStatus`,所以只有它能表达的两态参与比对。
 */
const SHARED_WITH_MOBILE: InstallationReading[] = ['detected-but-broken', 'not-detected'];

type MobileCatalog = {
  agentWatch: { create: { harnessStatus: Record<string, string> } };
};

function mobileWord(catalog: unknown, reading: InstallationReading): string {
  const status = (catalog as MobileCatalog).agentWatch.create.harnessStatus;
  const word = status[reading];
  // 阳控的一半:key 拼错会让比对变成「两边都 undefined」,那时它永远绿。
  expect(typeof word).toBe('string');
  return word as string;
}

describe('四态词表:任务页与手机端逐字一致', () => {
  it.each(SHARED_WITH_MOBILE)('zh «%s»', (reading) => {
    expect(mobileWord(zhMobile, reading)).toBe(zhSessionPage[readingLabelKey(reading)]);
  });

  it.each(SHARED_WITH_MOBILE)('en «%s»', (reading) => {
    expect(mobileWord(enMobile, reading)).toBe(enSessionPage[readingLabelKey(reading)]);
  });

  /**
   * 阴控:比对本身能判假吗。拿另一态的词去比同一格,必须红 —— 否则上面两条绿只说明
   * 「两个 undefined 相等」。
   */
  it('the comparison can fail', () => {
    expect(mobileWord(zhMobile, 'not-detected')).not.toBe(
      zhSessionPage[readingLabelKey('detected-but-broken')]
    );
  });

  it('每一态都有词,一格不缺', () => {
    const all: InstallationReading[] = [
      'installed',
      'detected-but-broken',
      'missing',
      'not-detected',
    ];
    for (const reading of all) {
      expect(zhSessionPage[readingLabelKey(reading)]).toBeTruthy();
      expect(enSessionPage[readingLabelKey(reading)]).toBeTruthy();
    }
  });
});
