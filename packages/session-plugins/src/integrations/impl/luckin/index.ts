import { summary } from './summary';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { icon } from './icon';

/**
 * 瑞幸官方的托管 MCP(门店、商品、订单预览 / 下单 / 查单 / 取消)。
 * 它只认用户在瑞幸开放平台登录后拿到的 Bearer 令牌,约一个月过期、不能续;令牌由平台保管(#921)。
 * 下单只生成待付款订单和付款二维码,钱由本人扫码付。
 */
export const LUCKIN_TOKEN_GUIDE_URL = 'https://open.lkcoffee.com/mcp';

const plugin = defineIntegrationPlugin(
  {
    id: 'luckin',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://open.lkcoffee.com',
    abilities: [
      { en: 'Find nearby stores', 'zh-CN': '找附近的门店' },
      { en: 'Search drinks, with options and prices', 'zh-CN': '搜饮品，看规格和价格' },
      { en: 'Preview and place an order, then pay by QR code', 'zh-CN': '预览订单、下单，扫码付款' },
      { en: 'Check or cancel an order', 'zh-CN': '查订单、取消订单' },
    ],
    playbooks: [
      {
        title: { en: 'Order a coffee', 'zh-CN': '点一杯咖啡' },
        prompt: {
          en: 'Order an iced Americano at the Luckin nearest to Beijing South Railway Station and show me the pay QR code.',
          'zh-CN': '在北京南站最近的瑞幸点一杯冰美式，把付款二维码给我。',
        },
      },
      {
        title: { en: 'Find a lighter drink', 'zh-CN': '找一杯清淡的' },
        prompt: {
          en: 'At the Luckin near Shanghai Jing\'an Temple, find a few iced drinks with less sugar.',
          'zh-CN': '在上海静安寺附近的瑞幸，找几款少糖的冰饮。',
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
              id: 'token',
              label: { en: 'Luckin token', 'zh-CN': '瑞幸令牌' },
              secret: true,
              required: true,
              placeholder: { en: 'Paste your Luckin token', 'zh-CN': '粘贴你的瑞幸令牌' },
            },
          ],
          help: {
            en: 'Log in to the Luckin open platform with your phone number and copy the token on the page. It lasts about a month; copy a new one then.',
            'zh-CN': '在瑞幸开放平台用手机号登录，复制页面上的令牌粘贴到这里。约一个月过期，到时重新复制。',
          },
          helpUrl: LUCKIN_TOKEN_GUIDE_URL,
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
      throw new Error('Luckin is connected through the platform-held credential path (#921).');
    },
  },
});
