import { describe, expect, it } from 'vitest';
import { connectorOrder } from './assistant-connector-order';

// 目录原来的先后(packages/session-plugins/src/integrations/registry.ts):国外的在前。
const catalog = ['github', 'linear', 'jira', 'notion', 'feishu', 'tencent-docs', 'dida', 'amap', 'dingtalk', 'wecom', 'qq-mail', 'netease-mail', 'enterprise-mail'].map((id) => ({ id }));

describe('connectorOrder', () => {
  it('中文:飞书、钉钉、企业微信、腾讯文档、滴答、高德地图、邮箱在前,国外的照原来的先后排在后面', () => {
    expect(connectorOrder(catalog, 'zh-CN').map((i) => i.id)).toEqual([
      'feishu', 'dingtalk', 'wecom', 'tencent-docs', 'dida', 'amap', 'qq-mail', 'netease-mail', 'enterprise-mail',
      'github', 'linear', 'jira', 'notion',
    ]);
  });
  it('别的语言照目录原来的先后', () => {
    expect(connectorOrder(catalog, 'en-US').map((i) => i.id)).toEqual(catalog.map((i) => i.id));
  });
});
