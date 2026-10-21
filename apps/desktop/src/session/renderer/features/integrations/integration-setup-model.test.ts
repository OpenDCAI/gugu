import { describe, expect, it } from 'vitest';
import {
  canSubmitForm,
  cliMethodOf,
  formInputOf,
  formMethodOf,
  initialFormValues,
  mcpOAuthServerUrlOf,
  usesBrowserAuthorization,
} from './integration-setup-model';

// 连接弹窗(桌面)与手机连接页共用的纯判断:走哪条路、表单怎么填。
const field = (id: string, extra: Record<string, unknown> = {}) => ({ id, label: id, secret: false, required: true, ...extra });
const form = (...fields: ReturnType<typeof field>[]) => ({ kind: 'form' as const, fields });

describe('连接方式', () => {
  it('认出表单 / 命令行 / 浏览器授权', () => {
    const mail = { auth: { methods: [form(field('email'))] } };
    const dws = { auth: { methods: [{ kind: 'cli' as const, tool: 'dws' as const, login: 'device-link' as const }] } };
    const feishu = { auth: { methods: [{ kind: 'mcp-oauth' as const, serverUrl: 'https://mcp.feishu.cn/mcp' }] } };
    expect(formMethodOf(mail as never)?.fields[0]?.id).toBe('email');
    expect(formMethodOf(dws as never)).toBeUndefined();
    expect(cliMethodOf(dws as never)?.tool).toBe('dws');
    expect(cliMethodOf(mail as never)).toBeUndefined();
    expect(usesBrowserAuthorization(feishu)).toBe(true);
    expect(usesBrowserAuthorization(mail)).toBe(false);
    expect(mcpOAuthServerUrlOf(feishu)).toBe('https://mcp.feishu.cn/mcp');
    expect(mcpOAuthServerUrlOf(mail)).toBeNull();
    expect(formMethodOf(undefined)).toBeUndefined();
  });
});

describe('表单', () => {
  const fields = [field('email'), field('password', { secret: true }), field('server', { required: false, defaultValue: 'imap.qq.com' })];

  it('初值:编辑时预填存着的不保密项,没有就用默认值', () => {
    expect(initialFormValues(fields as never)).toEqual({ email: '', password: '', server: 'imap.qq.com' });
    expect(initialFormValues(fields as never, { email: 'me@qq.com', server: 'imap.exmail.qq.com' })).toEqual({
      email: 'me@qq.com',
      password: '',
      server: 'imap.exmail.qq.com',
    });
  });

  it('必填的填了才能提交;编辑时保密项留空 = 沿用存着的', () => {
    expect(canSubmitForm(fields as never, { email: 'me@qq.com', password: '', server: '' }, false)).toBe(false);
    expect(canSubmitForm(fields as never, { email: 'me@qq.com', password: ' code ', server: '' }, false)).toBe(true);
    expect(canSubmitForm(fields as never, { email: 'me@qq.com', password: '', server: '' }, true)).toBe(true);
    expect(canSubmitForm(fields as never, { email: '  ', password: '', server: '' }, true)).toBe(false);
  });

  it('交给 connect 的输入:每格去首尾空白', () => {
    expect(formInputOf(fields as never, { email: ' me@qq.com ', password: ' code ', server: '' })).toEqual({
      email: 'me@qq.com',
      password: 'code',
      server: '',
    });
  });
});
