import { describe, expect, it } from 'vitest';
import { upstreamSaid } from './upstream-said';

describe('upstreamSaid: one reader for every harness\'s failure text', () => {
  // codex 0.156.1 的状态行拼法(`codex-rs/protocol/src/error.rs` 的 UnexpectedStatus):`unexpected status <码> <原因>: <体>`,
  // 体是带 `error.message` 的 JSON 时 codex 已经取成纯文本;后面依次可能跟 url、cf-ray、request id、auth error 几段。
  const RELAY = 'http://127.0.0.1:50057/gugu-platform-relay/0b7d/v1/responses';
  const QUOTA = '用户额度不足, 剩余额度: 积分 0.000000 (request id: 20261011abc)';

  it('codex 的状态行:去掉状态行与本机中转地址,留下网关那句;请求号是网关自己写进那句话里的,留着', () => {
    expect(upstreamSaid(`unexpected status 403 Forbidden: ${QUOTA}, url: ${RELAY}`)).toBe(QUOTA);
    expect(upstreamSaid(`unexpected status 503 Service Unavailable: upstream is down, url: ${RELAY}`)).toBe('upstream is down');
  });

  it('url 后面还跟着 codex 自己附上的几段:从第一个 url 起整段去掉', () => {
    expect(upstreamSaid(`unexpected status 403 Forbidden: ${QUOTA}, url: ${RELAY}, cf-ray: 8c1f2a3b4c5d6e7f-SJC`)).toBe(QUOTA);
    expect(upstreamSaid(`unexpected status 403 Forbidden: ${QUOTA}, url: ${RELAY}, request id: req_7f3a9c`)).toBe(QUOTA);
    expect(upstreamSaid(`unexpected status 401 Unauthorized: ${QUOTA}, url: ${RELAY}, auth error: invalid_token, auth error code: token_expired`)).toBe(QUOTA);
  });

  it('网关前面的 nginx 回了 HTML 错误页:那一行不说 <html>,照旧「回合未能完成」', () => {
    const nginx502 = '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';
    expect(upstreamSaid(`unexpected status 502 Bad Gateway: ${nginx502}, url: ${RELAY}`)).toBeUndefined();
  });

  it('认不出的形状说不出话(那一行照旧「回合未能完成」);多行只取第一行;令牌、IP、本机路径去掉', () => {
    expect(upstreamSaid('{"not":"an error body"}')).toBeUndefined();
    expect(upstreamSaid('{"error":{"message":"first line\\nsecond line"}}')).toBe('first line');
    expect(upstreamSaid('{"error":{"message":"bad key sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"}}')).not.toContain('abcdefghijklmnopqrstuvwxyz');
    const dial = upstreamSaid(`unexpected status 502 Bad Gateway: Post "http://10.0.3.7:3000/v1/responses": dial tcp 10.0.3.7:3000: connect: connection refused, url: ${RELAY}`);
    expect(dial).toContain('dial tcp');
    expect(dial).not.toContain('10.0.3.7');
    expect(upstreamSaid('{"error":{"message":"cannot read /Users/alice/.codex/auth.json"}}')).not.toContain('alice');
  });

  it('限长按码点截:不会切在 emoji 的半个字符上', () => {
    const said = upstreamSaid(`{"error":{"message":"${'a'.repeat(279)}😀😀"}}`);
    expect(Array.from(said ?? '')).toHaveLength(280);
    expect(said?.endsWith('😀')).toBe(true);
    expect(said).not.toMatch(/[\uD800-\uDBFF]$/);
  });

  it('claude record errorDetails: bare status + body, the gateway\'s sentence (mac1 2026-11-05)', () => {
    const recorded = '400 {"error":{"type":"<nil>","message":"prompt is too long: 2160124 tokens > 1000000 maximum (request id: 20261105224416563700283vK56PuJA)"},"type":"error"}';
    expect(upstreamSaid(recorded)).toBe('prompt is too long: 2160124 tokens > 1000000 maximum (request id: 20261105224416563700283vK56PuJA)');
  });

  it('JSON-RPC internal error: the SDK prefix is not the provider\'s words', () => {
    expect(upstreamSaid('Internal error: Prompt is too long')).toBe('Prompt is too long');
  });
});
