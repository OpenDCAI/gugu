import { summary } from './summary';
import { verifyKeyedMcpCredentials } from '../../helpers/keyed-mcp';
import { defineIntegrationPlugin, registerIntegrationPluginBehavior } from '../../plugin';
import { icon } from './icon';

/**
 * 高德官方的托管 MCP(地点搜索、周边、路线规划、距离、天气、地理编码…),只认用户自己在高德开放平台申请的 Web 服务 Key。
 * Key 由平台代为保管(owner 2026-10-28 定:用户填自己的 Key,平台替他存,#921):填一次,他的每台设备(含云电脑)
 * 都经平台的 MCP 转发口用;Key ❌ 回到任何设备、❌ 进仓库。平台那边有高德的地址、Key 放在哪(`?key=`)和验 Key 的那次调用。
 * 下面的 `mcp` 只给压根没有这项平台服务的安装(社区自托管)用:那里 Key 存在这台电脑的加密凭据库里,由它自己拼地址。
 */
export const AMAP_MCP_URL = 'https://mcp.amap.com/mcp';
export const AMAP_KEY_GUIDE_URL = 'https://lbs.amap.com/api/mcp-server/create-project-and-key';

// 高德对任何格式对的 key 都列工具,真调用才报 INVALID_USER_KEY:连接时查一次北京天气(只读、最便宜)。
const mcp = {
  serverUrl: AMAP_MCP_URL,
  keyField: 'apiKey',
  keyQueryParam: 'key',
  probe: { tool: 'maps_weather', arguments: { city: '北京' } },
};

const plugin = defineIntegrationPlugin(
  {
    id: 'amap',
    name: summary.name['zh-CN'],
    description: summary.description,
    websiteUrl: 'https://lbs.amap.com',
    abilities: [
      { en: 'Search places and what is nearby', 'zh-CN': '搜地点、搜周边' },
      { en: 'Plan driving, transit, walking and cycling routes', 'zh-CN': '规划驾车、公交、步行、骑行路线' },
      { en: 'Check distance, travel time and weather', 'zh-CN': '查距离、耗时和天气' },
    ],
    playbooks: [
      {
        title: { en: 'How long to get there', 'zh-CN': '过去要多久' },
        prompt: {
          en: 'How long does it take from Beijing South Railway Station to the Forbidden City by subway and by car right now?',
          'zh-CN': '从北京南站到故宫，坐地铁和打车现在各要多久？',
        },
      },
      {
        title: { en: 'Find somewhere nearby', 'zh-CN': '附近找个地方' },
        prompt: {
          en: 'Find three well-rated coffee shops within 1 km of Shanghai Jing\'an Temple and tell me how to walk there.',
          'zh-CN': '在上海静安寺附近一公里内找三家评价好的咖啡店，告诉我怎么走过去。',
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
              label: { en: 'AMap Web service key', 'zh-CN': '高德 Web 服务 Key' },
              secret: true,
              required: true,
              placeholder: { en: 'Paste your AMap key', 'zh-CN': '粘贴你的高德 Key' },
            },
          ],
          help: {
            en: 'Free: sign in to the AMap open platform, create an app and add a key with the service type “Web 服务”, then paste it here.',
            'zh-CN': '免费申请：登录高德开放平台，创建应用并添加 Key，服务平台选「Web 服务」，把 Key 粘贴到这里。',
          },
          helpUrl: AMAP_KEY_GUIDE_URL,
          custody: 'platform',
          mcp,
        },
      ],
    },
  },
  { icon }
);

// 只在没有平台服务的安装上跑(Key 存在这台电脑上时);平台保管时由平台在存之前验。
export const provider = registerIntegrationPluginBehavior(plugin, {
  auth: {
    verify: (_host, credentials) => verifyKeyedMcpCredentials(plugin.metadata.name, mcp, credentials),
  },
});
