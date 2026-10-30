import { describe, expect, it } from 'vitest';
import { enUSCapabilityMessages, zhCNCapabilityMessages } from '@renderer/localization/messages-capabilities';
import zhAssistant from '../../../../i18n/locales/zh-CN/assistant';
import { integrationErrorText } from './integration-display';

const translateWith = (messages: Record<string, string>) =>
  ((key: string, values?: Record<string, string>) =>
    messages[key]!.replace(/\{(\w+)\}/g, (_match, name: string) => values?.[name] ?? '')) as Parameters<typeof integrationErrorText>[0];

describe('integration error text', () => {
  it('#921 a #649 key the provider rejected on its way to the platform: enter it again, named by the provider', () => {
    const failure = { connected: false, error: '高德地图 rejected this key; enter it again.', errorType: 'key_rejected' as const };
    expect(integrationErrorText(translateWith(enUSCapabilityMessages), 'AMap', failure)).toBe('AMap rejected this key; enter it again.');
    expect(integrationErrorText(translateWith(zhCNCapabilityMessages), '高德地图', failure)).toBe('高德地图拒绝了这个 Key，重新填一下。');
  });

  it('uses localized service-failure copy without server diagnostics', () => {
    const failure = { connected: false, error: '平台凭据服务缺少加密密钥配置: INTEGRATION_CREDENTIALS_KEY', errorType: 'service_unavailable' as const };
    expect(integrationErrorText(translateWith(enUSCapabilityMessages), 'AMap', failure)).toBe("Gugu's AMap connection service is unavailable. Try again later.");
    expect(integrationErrorText(translateWith(zhCNCapabilityMessages), '高德地图', failure)).toBe('咕咕的高德地图连接服务出了问题，请稍后重试。');
  });

  it('#921 the provider answered but cannot be used right now (quota, QPS, temporary): try again later, not "check the address"', () => {
    const failure = { connected: false, errorType: 'provider_unavailable' as const };
    expect(integrationErrorText(translateWith(enUSCapabilityMessages), 'AMap', failure)).toBe("AMap isn't available right now. Try again later.");
    expect(integrationErrorText(translateWith(zhCNCapabilityMessages), '高德地图', failure)).toBe('高德地图这会儿用不了，稍后再试。');
  });

  it('#921 timed out (408, already sent twice by the device): your request did not reach Gugu in time; never "try again"', () => {
    const failure = { connected: false, errorType: 'timed_out' as const };
    expect(integrationErrorText(translateWith(enUSCapabilityMessages), 'AMap', failure)).toBe("Your request didn't reach Gugu in time. Your network may be unstable.");
    expect(integrationErrorText(translateWith(zhCNCapabilityMessages), '高德地图', failure)).toBe('你的请求没及时送到咕咕，可能是网络不稳。');
  });

  it('#921 network: this device cannot reach Gugu, said in both languages', () => {
    const failure = { connected: false, errorType: 'network' as const };
    expect(integrationErrorText(translateWith(enUSCapabilityMessages), 'AMap', failure)).toBe("Can't reach Gugu. Check your network.");
    expect(integrationErrorText(translateWith(zhCNCapabilityMessages), '高德地图', failure)).toBe('连不上咕咕，检查一下网络。');
  });

  it('no zh integration string puts a space between the name and a Chinese character', () => {
    const cjk = '[\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef]';
    const spaced = new RegExp(`\\{name\\} ${cjk}|${cjk} \\{name\\}`);
    const offenders = Object.entries(zhCNCapabilityMessages).filter(([key, text]) => key.startsWith('integrations.') && spaced.test(text));
    expect(offenders).toEqual([]);
    // The phone's connector strings too ({{name}} there).
    const phoneSpaced = new RegExp(`\\{\\{name\\}\\} ${cjk}|${cjk} \\{\\{name\\}\\}`);
    const strings = (value: unknown): string[] =>
      typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    expect(strings(zhAssistant.connectors).filter((text) => phoneSpaced.test(text))).toEqual([]);
  });
});
