import { summary } from './summary';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { icon } from './icon';

/**
 * 腾讯出行服务官方的托管 MCP(地点推荐、附近车辆、价格与路线预估、打车二维码 / 微信短链)。
 * 它只认用户在腾讯出行服务开放平台创建「MCP 应用」后拿到的 Key,放在请求头 `Authorization` 里、不带 Bearer;
 * Key 由平台保管(#921)。四个工具都是只读或生成链接,最后跳进微信小程序叫车。
 */
export const TENCENT_MOBILITY_KEY_GUIDE_URL = 'https://open.go.qq.com/api/18-doc-mcp-guide.html';

const plugin = defineIntegrationPlugin(
  {
    id: 'tencent-mobility',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://open.go.qq.com',
    abilities: [
      { en: 'Suggest places for pick-up and drop-off', 'zh-CN': '推荐上下车地点' },
      { en: 'See nearby available cars', 'zh-CN': '查附近可用车辆' },
      { en: 'Estimate fares and the route', 'zh-CN': '预估打车价格和路线' },
      { en: 'Get a ride QR code or WeChat link to call the car', 'zh-CN': '生成叫车二维码或微信链接' },
    ],
    playbooks: [
      {
        title: { en: 'How much is a ride', 'zh-CN': '打车多少钱' },
        prompt: {
          en: 'How much is a taxi from Wuhan University to Hankou Railway Station?',
          'zh-CN': '从武汉大学到汉口火车站打车多少钱？',
        },
      },
      {
        title: { en: 'Get a ride QR code', 'zh-CN': '生成叫车二维码' },
        prompt: {
          en: 'Make me a ride QR code from Shenzhen North Station to Tianhong Mall Longhua.',
          'zh-CN': '帮我生成从深圳北站到天虹购物中心龙华店的打车二维码。',
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
              label: { en: 'Tencent Mobility MCP key', 'zh-CN': '腾讯出行 MCP Key' },
              secret: true,
              required: true,
              placeholder: { en: 'Paste your Tencent Mobility MCP key', 'zh-CN': '粘贴你的腾讯出行 MCP Key' },
            },
          ],
          help: {
            en: 'Sign in to the Tencent Mobility open platform, create an “MCP app”, then paste the key from its details page.',
            'zh-CN': '登录腾讯出行服务开放平台，创建「MCP 应用」，把应用详情里的 Key 粘贴到这里。',
          },
          helpUrl: TENCENT_MOBILITY_KEY_GUIDE_URL,
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
      throw new Error('Tencent Mobility is connected through the platform-held credential path (#921).');
    },
  },
});
