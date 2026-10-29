import { createPluginRegistry } from '@gugu/session-shared/plugins';
import { provider as amap } from './impl/amap';
import { provider as asana } from './impl/asana';
import { provider as dida } from './impl/dida';
import { provider as didi } from './impl/didi';
import { provider as dingtalk } from './impl/dingtalk';
import { provider as enterpriseMail } from './impl/enterprise-mail';
import { provider as featurebase } from './impl/featurebase';
import { provider as feishu } from './impl/feishu';
import { provider as forgejo } from './impl/forgejo';
import { provider as github } from './impl/github';
import { provider as gitlab } from './impl/gitlab';
import { provider as jira } from './impl/jira';
import { provider as linear } from './impl/linear';
import { provider as luckin } from './impl/luckin';
import { provider as monday } from './impl/monday';
import { provider as notion } from './impl/notion';
import { provider as plain } from './impl/plain';
import { provider as plane } from './impl/plane';
import { provider as tencentDocs } from './impl/tencent-docs';
import { provider as tencentMeeting } from './impl/tencent-meeting';
import { provider as tencentMobility } from './impl/tencent-mobility';
import { provider as trello } from './impl/trello';
import { provider as wecom } from './impl/wecom';
import { provider as neteaseMail } from './impl/netease-mail';
import { provider as qqMail } from './impl/qq-mail';
import type { IntegrationPluginProvider } from './plugin';

export const integrationPluginRegistry = createPluginRegistry<IntegrationPluginProvider>();

for (const provider of [
  github,
  linear,
  jira,
  gitlab,
  plane,
  forgejo,
  trello,
  asana,
  monday,
  notion,
  featurebase,
  plain,
  // 国产平台的官方云端 MCP(#7210):只给 agent 用,不是 issue 系统。
  feishu,
  tencentDocs,
  tencentMeeting,
  dida,
  // 用户自己的 Key 拼进地址的托管 MCP。
  amap,
  // 用户自己填的 Key / 令牌、由平台保管(#921):出行与点单。
  didi,
  tencentMobility,
  luckin,
  // 国产平台的官方命令行(#7210 第二批):咕咕装好工具、调起它自带的登录,把工具与它的 skills 交给会话。
  dingtalk,
  wecom,
  // 邮箱(#7240):IMAP / SMTP + 授权码,收发由咕咕在连着的那台机器上做,以工具的形式交给会话。
  qqMail,
  neteaseMail,
  enterpriseMail,
]) {
  integrationPluginRegistry.register(provider);
}
