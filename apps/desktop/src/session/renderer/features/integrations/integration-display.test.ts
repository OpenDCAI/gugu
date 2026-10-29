import { describe, expect, it } from 'vitest';
import { enUSCapabilityMessages, zhCNCapabilityMessages } from '@renderer/localization/messages-capabilities';
import { integrationErrorText } from './integration-display';

const translateWith = (messages: Record<string, string>) =>
  ((key: string, values?: Record<string, string>) =>
    messages[key]!.replace(/\{(\w+)\}/g, (_match, name: string) => values?.[name] ?? '')) as Parameters<typeof integrationErrorText>[0];

describe('integration error text', () => {
  it('#921 a #649 key the provider rejected on its way to the platform: enter it again, named by the provider', () => {
    const failure = { connected: false, error: '高德地图 rejected this key; enter it again.', errorType: 'key_rejected' as const };
    expect(integrationErrorText(translateWith(enUSCapabilityMessages), 'AMap', failure)).toBe('AMap rejected this key; enter it again.');
    expect(integrationErrorText(translateWith(zhCNCapabilityMessages), '高德地图', failure)).toBe('高德地图 拒绝了这个 Key，重新填一下。');
  });

  it('#921 not open: it is Gugu that has not opened the connection to you, not the provider refusing', () => {
    const failure = { connected: false, errorType: 'not_open' as const };
    expect(integrationErrorText(translateWith(enUSCapabilityMessages), 'AMap', failure)).toBe("Gugu hasn't opened the AMap connection to you yet.");
    expect(integrationErrorText(translateWith(zhCNCapabilityMessages), '高德地图', failure)).toBe('咕咕还没对你开放 高德地图 连接。');
  });

  it('#921 timed out (408): your request did not reach Gugu in time; the provider is not the slow one', () => {
    const failure = { connected: false, errorType: 'timed_out' as const };
    expect(integrationErrorText(translateWith(enUSCapabilityMessages), 'AMap', failure)).toBe("Your request didn't reach Gugu in time. Try again.");
    expect(integrationErrorText(translateWith(zhCNCapabilityMessages), '高德地图', failure)).toBe('你的请求没及时送到咕咕，再试一次。');
  });
});
