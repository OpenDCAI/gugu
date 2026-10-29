// No provider behavior, SDKs or host APIs enter the renderer through this module.
import type { LocalizedText } from './localized-text';
import { summary as amap } from './impl/amap/summary';
import { summary as asana } from './impl/asana/summary';
import { summary as dida } from './impl/dida/summary';
import { summary as didi } from './impl/didi/summary';
import { summary as dingtalk } from './impl/dingtalk/summary';
import { summary as enterprise_mail } from './impl/enterprise-mail/summary';
import { summary as featurebase } from './impl/featurebase/summary';
import { summary as feishu } from './impl/feishu/summary';
import { summary as forgejo } from './impl/forgejo/summary';
import { summary as github } from './impl/github/summary';
import { summary as gitlab } from './impl/gitlab/summary';
import { summary as jira } from './impl/jira/summary';
import { summary as linear } from './impl/linear/summary';
import { summary as luckin } from './impl/luckin/summary';
import { summary as monday } from './impl/monday/summary';
import { summary as netease_mail } from './impl/netease-mail/summary';
import { summary as notion } from './impl/notion/summary';
import { summary as plain } from './impl/plain/summary';
import { summary as plane } from './impl/plane/summary';
import { summary as qq_mail } from './impl/qq-mail/summary';
import { summary as tencent_docs } from './impl/tencent-docs/summary';
import { summary as tencent_meeting } from './impl/tencent-meeting/summary';
import { summary as tencent_mobility } from './impl/tencent-mobility/summary';
import { summary as trello } from './impl/trello/summary';
import { summary as wecom } from './impl/wecom/summary';

export const builtinIntegrationSummaries: Readonly<Record<string,{ name: LocalizedText; description: LocalizedText }>> = {
  'amap': amap,
  'asana': asana,
  'dida': dida,
  'didi': didi,
  'dingtalk': dingtalk,
  'enterprise-mail': enterprise_mail,
  'featurebase': featurebase,
  'feishu': feishu,
  'forgejo': forgejo,
  'github': github,
  'gitlab': gitlab,
  'jira': jira,
  'linear': linear,
  'luckin': luckin,
  'monday': monday,
  'netease-mail': netease_mail,
  'notion': notion,
  'plain': plain,
  'plane': plane,
  'qq-mail': qq_mail,
  'tencent-docs': tencent_docs,
  'tencent-meeting': tencent_meeting,
  'tencent-mobility': tencent_mobility,
  'trello': trello,
  'wecom': wecom,
};

export function builtinIntegrationSummary(id: string,locale: string) {
  if (!Object.hasOwn(builtinIntegrationSummaries,id)) return undefined;
  const summary = builtinIntegrationSummaries[id]!;
  const language = locale === 'zh-CN' ? 'zh-CN' : 'en';
  return { name: summary.name[language],description: summary.description[language] };
}
