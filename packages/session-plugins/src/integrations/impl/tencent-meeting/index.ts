import { summary } from './summary';
import { icon } from './icon';
import { verifyCliConnectionRecord } from '../../helpers/cli-connection';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';

const plugin = defineIntegrationPlugin({
  id: 'tencent-meeting', name: summary.name['zh-CN'], websiteUrl: 'https://meeting.tencent.com',
  description: summary.description,
  abilities: [
    { en: 'Find and manage your meetings', 'zh-CN': '查询和管理你的会议' },
    { en: 'Read recordings and meeting notes', 'zh-CN': '读取录制和会议纪要' },
  ],
  playbooks: [{ title: { en: 'Upcoming meetings', 'zh-CN': '近期会议' }, prompt: { en: 'List my upcoming Tencent Meeting meetings.', 'zh-CN': '列出我在腾讯会议上的近期会议。' } }],
}, { auth: { methods: [{ kind: 'cli', tool: 'tmeet', login: 'device-link' }] } }, { icon });

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: { verify: (_host, credentials) => Promise.resolve(verifyCliConnectionRecord('腾讯会议', 'tmeet', credentials)) },
});
