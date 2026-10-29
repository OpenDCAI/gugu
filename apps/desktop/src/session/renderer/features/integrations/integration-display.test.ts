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
});
