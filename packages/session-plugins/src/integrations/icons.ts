// Browser-safe built-in assets; provider runtime code stays on the host.
import type { PluginIconAsset } from '@gugu/session-shared/plugins';
import { icon as icon_asana } from './impl/asana/icon';
import { icon as icon_dida } from './impl/dida/icon';
import { icon as icon_dingtalk } from './impl/dingtalk/icon';
import { icon as icon_enterprise_mail } from './impl/enterprise-mail/icon';
import { icon as icon_featurebase } from './impl/featurebase/icon';
import { icon as icon_feishu } from './impl/feishu/icon';
import { icon as icon_forgejo } from './impl/forgejo/icon';
import { icon as icon_github } from './impl/github/icon';
import { icon as icon_gitlab } from './impl/gitlab/icon';
import { icon as icon_jira } from './impl/jira/icon';
import { icon as icon_linear } from './impl/linear/icon';
import { icon as icon_monday } from './impl/monday/icon';
import { icon as icon_netease_mail } from './impl/netease-mail/icon';
import { icon as icon_notion } from './impl/notion/icon';
import { icon as icon_plain } from './impl/plain/icon';
import { icon as icon_plane } from './impl/plane/icon';
import { icon as icon_qq_mail } from './impl/qq-mail/icon';
import { icon as icon_tencent_docs } from './impl/tencent-docs/icon';
import { icon as icon_tencent_meeting } from './impl/tencent-meeting/icon';
import { icon as icon_trello } from './impl/trello/icon';
import { icon as icon_wecom } from './impl/wecom/icon';

export const integrationIcons: Readonly<Record<string,PluginIconAsset>> = {
  'asana': icon_asana,
  'dida': icon_dida,
  'dingtalk': icon_dingtalk,
  'enterprise-mail': icon_enterprise_mail,
  'featurebase': icon_featurebase,
  'feishu': icon_feishu,
  'forgejo': icon_forgejo,
  'github': icon_github,
  'gitlab': icon_gitlab,
  'jira': icon_jira,
  'linear': icon_linear,
  'monday': icon_monday,
  'netease-mail': icon_netease_mail,
  'notion': icon_notion,
  'plain': icon_plain,
  'plane': icon_plane,
  'qq-mail': icon_qq_mail,
  'tencent-docs': icon_tencent_docs,
  'tencent-meeting': icon_tencent_meeting,
  'trello': icon_trello,
  'wecom': icon_wecom,
};
