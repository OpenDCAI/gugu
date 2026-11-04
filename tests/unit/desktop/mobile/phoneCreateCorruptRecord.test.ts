import { describe, expect, it } from 'vitest';
import { readPhoneAgentCreateAttempt } from '../../../../apps/desktop/src/mobile/local-agent/phoneAgentCreate';
import { readPhoneSessionCreate } from '../../../../apps/desktop/src/mobile/local-agent/phoneSessionCreate';

const storage = (value: string) => ({
  getItem: () => value,
  setItem: () => {},
  removeItem: () => {},
});

describe('corrupt phone create records', () => {
  it('坏记录报既定的「记录不完整」错误，而不是裸 SyntaxError', () => {
    expect(() => readPhoneSessionCreate('owner', 'device', storage('{not json'))).toThrowError(
      '上次创建记录不完整，请保留记录后重试'
    );
    expect(() => readPhoneAgentCreateAttempt('owner', 'device', storage('{"version":'))).toThrowError(
      '这台手机的创建记录不完整，请保留记录后重试'
    );
  });
});
