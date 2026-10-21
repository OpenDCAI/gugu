import { describe, expect, it } from 'vitest';
import { redactRpcArgs } from './rpc-logging';

// 开发日志记每个 rpc 的参数;回答 ssh 提问的那一个参数里是密码,❌ 进日志。
describe('redactRpcArgs', () => {
  it('回答 ssh 提问的调用只记通道名;别的原样', () => {
    const secret = [{ ptySessionId: 'direct:d:c', promptId: 'p', value: 's3cret' }];
    expect(redactRpcArgs('directTerminal.answerPrompt', secret)).toEqual(['[redacted]']);
    expect(JSON.stringify(redactRpcArgs('directTerminal.answerPrompt', secret))).not.toContain('s3cret');
    expect(redactRpcArgs('directTerminal.status', ['direct:d:c'])).toEqual(['direct:d:c']);
  });
});
