import fs from 'node:fs';
import path from 'node:path';
import type { CdpHub } from './cdp-hub';

/**
 * #7199 「密码保险箱」:agent 要登录某个网站时请人填账号密码,密码只交给浏览器。
 *
 * - 人在桌面的保险箱里填,经远程隧道(SSH 端到端加密,中转只见密文)直送这台云电脑的咕咕 server;
 *   ❌ 进聊天记录、❌ 进 agent 的工具结果 —— agent 只拿到「填好了 / 人没填」。
 * - 由这里把它写进页面的输入框(cdp 直接设值),❌ 经键盘逐字打(画面帧和输入事件里都看得见)。
 * - 「保存密码,下次免输入」:按站点(协议 + 主机)存进账号数据目录里的一个加密文件。⚠️ 云电脑上的「加密」
 *   用的是咕咕 server 自己的密钥文件(与密文同盘,headless/electron-shim.ts 的 safeStorage 替身),防的是
 *   存档 / 文件被顺手拷走后直接读出,❌ 防不住在同一台机器上有 shell 的程序 —— agent 有 shell,它的 cookie 也在这台机器上。
 */
export type Credential = { username: string; password: string };

export type SecretBox = {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
};

/** 站点 = 协议 + 主机(+ 非默认端口);❌ 带路径:同一个站点不同的登录页共用一份。 */
export function siteOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

export class CredentialStore {
  constructor(
    private readonly file: string,
    private readonly box: () => SecretBox
  ) {}

  private readAll(): Record<string, Credential> {
    let raw: Buffer;
    try {
      raw = fs.readFileSync(this.file);
    } catch {
      return {};
    }
    const parsed = JSON.parse(this.box().decryptString(raw)) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, Credential> = {};
    for (const [site, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as Partial<Credential> | null;
      if (entry && typeof entry.username === 'string' && typeof entry.password === 'string') out[site] = { username: entry.username, password: entry.password };
    }
    return out;
  }

  get(site: string): Credential | null {
    return this.readAll()[site] ?? null;
  }

  save(site: string, credential: Credential): void {
    const box = this.box();
    if (!box.isEncryptionAvailable()) throw new Error('this machine cannot encrypt saved passwords');
    const all = { ...this.readAll(), [site]: credential };
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const temp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temp, box.encryptString(JSON.stringify(all)), { mode: 0o600 });
    fs.renameSync(temp, this.file);
  }
}

/**
 * 在页面里找登录框并填上(每个同进程的框架都找一遍:不少登录框在 iframe 里)。返回填了哪几格。
 * 用户名 = 密码框前面最近的那个可见的文本 / 邮箱 / 电话框;只有用户名框(先填账号、下一步才要密码的那种)也填。
 * 值经 callFunctionOn 的参数传进去,❌ 拼进脚本字符串。设值走原生 setter 并发 input/change —— React 这类框架才认。
 */
export const FILL_LOGIN_FUNCTION = `function (username, password) {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && !el.disabled && !el.readOnly; };
  const setValue = (el, value) => {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set ?? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    el.focus();
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const inputs = [...document.querySelectorAll('input')].filter(visible);
  const isUser = (el) => ['text', 'email', 'tel', ''].includes((el.getAttribute('type') || '').toLowerCase()) || /user|login|account|email|phone|mobile|name/i.test(el.name + ' ' + el.id + ' ' + (el.autocomplete || ''));
  const passwordField = inputs.find((el) => (el.type || '').toLowerCase() === 'password');
  let userField = null;
  if (passwordField) {
    const before = inputs.slice(0, inputs.indexOf(passwordField)).filter((el) => (el.type || '').toLowerCase() !== 'password' && (el.type || '').toLowerCase() !== 'hidden' && (el.type || '').toLowerCase() !== 'checkbox' && (el.type || '').toLowerCase() !== 'radio' && isUser(el));
    userField = before[before.length - 1] ?? null;
  } else {
    userField = inputs.find((el) => /username|email|tel|webauthn/.test(el.autocomplete || '') ) ?? inputs.find((el) => ['email', 'tel'].includes((el.type || '').toLowerCase())) ?? inputs.find((el) => (el.type || 'text').toLowerCase() === 'text' && isUser(el)) ?? null;
  }
  const filled = [];
  if (userField && username) { setValue(userField, username); filled.push('username'); }
  if (passwordField && password) { setValue(passwordField, password); filled.push('password'); }
  if (passwordField) passwordField.focus();
  return filled;
}`;

export type FillResult = { username: boolean; password: boolean };

/** 页签里每个同进程框架的 document(在隔离环境里拿,页面自己的脚本看不见);跨进程的框架(另一个 target)够不着,跳过。 */
async function* frameDocuments(hub: CdpHub, sessionId: string): AsyncGenerator<string> {
  await hub.send('Page.enable', {}, sessionId);
  const { frameTree } = await hub.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, sessionId);
  const frames: string[] = [];
  const walk = (node: FrameTree) => {
    frames.push(node.frame.id);
    for (const child of node.childFrames ?? []) walk(child);
  };
  walk(frameTree);
  for (const frameId of frames) {
    let contextId: number;
    try {
      ({ executionContextId: contextId } = await hub.send<{ executionContextId: number }>(
        'Page.createIsolatedWorld',
        { frameId, worldName: 'gugu-vault', grantUniveralAccess: false },
        sessionId
      ));
    } catch {
      continue;
    }
    const { result: documentRef } = await hub.send<{ result: { objectId?: string } }>('Runtime.evaluate', { expression: 'document', contextId }, sessionId);
    if (documentRef.objectId) yield documentRef.objectId;
  }
}

/**
 * 页面上所有密码框里现在的值。人接管时自己敲的密码 / 验证码:交还前读出来登记进脱敏名单 ——
 * agent 之后的页面快照会把密码框的值原样写出来。
 */
export async function readPasswordValues(hub: CdpHub, sessionId: string): Promise<string[]> {
  const values: string[] = [];
  for await (const objectId of frameDocuments(hub, sessionId)) {
    const { result } = await hub.send<{ result: { value?: unknown } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: "function () { return [...this.querySelectorAll('input[type=password]')].map((el) => el.value).filter(Boolean); }",
        returnByValue: true,
      },
      sessionId
    );
    if (Array.isArray(result.value)) for (const value of result.value) if (typeof value === 'string') values.push(value);
  }
  return values;
}

/** 在 `sessionId`(那个页签上的一条 flatten 会话)里填登录框。 */
export async function fillLogin(hub: CdpHub, sessionId: string, credential: Credential): Promise<FillResult> {
  const result: FillResult = { username: false, password: false };
  for await (const objectId of frameDocuments(hub, sessionId)) {
    const { result: filled } = await hub.send<{ result: { value?: unknown } }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: FILL_LOGIN_FUNCTION,
        arguments: [{ value: result.username ? '' : credential.username }, { value: result.password ? '' : credential.password }],
        returnByValue: true,
      },
      sessionId
    );
    const names = Array.isArray(filled.value) ? filled.value : [];
    if (names.includes('username')) result.username = true;
    if (names.includes('password')) result.password = true;
    if (result.password) break;
  }
  return result;
}

type FrameTree = { frame: { id: string }; childFrames?: FrameTree[] };
