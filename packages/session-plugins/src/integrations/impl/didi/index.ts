import { summary } from './summary';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { icon } from './icon';

/**
 * 滴滴官方的托管 MCP(车型与价格预估、叫车链接、下单、查单、取消、司机位置,外加地图)。
 * 它只认用户自己在滴滴 MCP 控制台激活的个人 Key,没有浏览器授权;Key 由平台保管(#921)。
 * 第一版只给估价、路线、叫车链接:下单那几个工具不交给会话,下单要 Pro 档,真实扣费,留到以后。
 */
export const DIDI_KEY_GUIDE_URL = 'https://mcp.didichuxing.com/';

const plugin = defineIntegrationPlugin(
  {
    id: 'didi',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://mcp.didichuxing.com',
    abilities: [
      { en: 'Check taxi prices and car types', 'zh-CN': '查打车价格和车型' },
      { en: 'Plan driving, transit, walking and cycling routes', 'zh-CN': '规划驾车、公交、步行、骑行路线' },
      { en: 'Get a DiDi ride link to confirm in the app', 'zh-CN': '生成滴滴叫车链接，到 App 里确认' },
    ],
    playbooks: [
      {
        title: { en: 'How much is a ride', 'zh-CN': '打车多少钱' },
        prompt: {
          en: 'How much would a taxi from Guomao to Sanlitun cost right now, for an economy car and a premium one?',
          'zh-CN': '从国贸到三里屯打车，快车和专车现在各大概多少钱？',
        },
      },
      {
        title: { en: 'Get a ride link', 'zh-CN': '生成叫车链接' },
        prompt: {
          en: 'Make me a DiDi link for an economy car from Beijing South Railway Station to the airport.',
          'zh-CN': '帮我生成从北京南站到首都机场的快车叫车链接。',
        },
      },
    ],
  },
  {
    auth: {
      methods: [
        {
          kind: 'form',
          fields: [
            {
              id: 'apiKey',
              label: { en: 'DiDi MCP key', 'zh-CN': '滴滴 MCP Key' },
              secret: true,
              required: true,
              placeholder: { en: 'Paste your DiDi MCP key', 'zh-CN': '粘贴你的滴滴 MCP Key' },
            },
          ],
          help: {
            en: 'Sign in to the DiDi MCP console with your DiDi account, activate your personal key, then paste it here.',
            'zh-CN': '登录滴滴 MCP 控制台，用你的滴滴账号激活个人 Key，粘贴到这里。',
          },
          helpUrl: DIDI_KEY_GUIDE_URL,
        },
      ],
    },
  },
  { icon }
);

export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    // 凭据只在平台那边验(#921);这一家没有本机校验。
    verify: async () => {
      throw new Error('DiDi is connected through the platform-held credential path (#921).');
    },
  },
});
