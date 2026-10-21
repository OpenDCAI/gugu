/**
 * #7333 登录页按母版角色落到真实计算值,且只保留真实的邮箱验证码流程(母版补页 05 的八种状态)。
 *
 * 渲染的是真 LoginPage;只换掉两样:`authService`(不连库)与 `sessionCoordinator`(不接真会话)—— 两者都由用例
 * 手里的 promise 驱动,「正在发送 / 验证中」是请求真的还没回来,❌ 定时器假装。
 * 判的是 getComputedStyle 与真实键鼠:主按钮在明暗两侧都是墨底 + 反相前景(暗色下不是白字,也不是卡片面色)。
 */
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cdp, page, userEvent } from 'vitest/browser';
import { until, untilStable } from '../../../../../../../tests/support/awaitCondition';
import { i18n } from '@/i18n';
import '@/i18n/registerMainCatalog';
import '@/styles/tokens.css';

type AuthResult = { success: boolean; error?: string; session?: unknown };
const auth = vi.hoisted(() => ({
  requestLoginOtp: vi.fn<(email: string) => Promise<AuthResult>>(),
  verifyLoginOtp: vi.fn<(email: string, token: string) => Promise<AuthResult>>(),
}));
const coordinator = vi.hoisted(() => ({
  beginInteractiveLogin: vi.fn(() => 7),
  acceptInteractiveSession: vi.fn(async (_attempt: number, _session: unknown) => undefined),
}));
vi.mock('@/lib/auth', () => ({ authService: auth }));
vi.mock('@/lib/sessionCoordinator', () => ({ sessionCoordinator: coordinator }));

const { LoginPage } = await import('@/pages/LoginPage');

/** A request the test answers when it chooses: the page's loading state is the real one, waiting on it. */
function pending() {
  let answer!: (result: AuthResult) => void;
  const promise = new Promise<AuthResult>((resolve) => (answer = resolve));
  return { promise, answer: (result: AuthResult) => answer(result) };
}

const t = (key: string, options?: Record<string, unknown>) => i18n.t(key, { ns: 'main', ...options });
const css = (element: Element, property: string) => getComputedStyle(element).getPropertyValue(property).trim();
/** What a token resolves to right now, read off an element with no transition. */
const token = (name: string, property: 'background-color' | 'color' | 'font-family' = 'color') => {
  const probe = document.createElement('i');
  probe.style.cssText = `position:absolute;transition:none;${property}:var(${name})`;
  document.body.append(probe);
  const value = css(probe, property);
  probe.remove();
  return value;
};
const box = (element: Element) => {
  const rect = element.getBoundingClientRect();
  return { width: Math.round(rect.width), height: Math.round(rect.height) };
};
const type = (element: Element) => {
  const style = getComputedStyle(element);
  return { size: Number.parseFloat(style.fontSize), leading: Math.round(Number.parseFloat(style.lineHeight)), weight: Number(style.fontWeight) };
};

let host: HTMLElement;
let root: Root;
const q = <T extends Element = HTMLElement>(selector: string) => host.querySelector<T>(selector);
const submit = () => q<HTMLButtonElement>('button[type="submit"]')!;
const email = () => q<HTMLInputElement>('input[type="email"]')!;
const otp = () => q<HTMLInputElement>('input[autocomplete="one-time-code"]')!;
const alertText = () => q('[role="alert"]')?.textContent ?? null;
const buttonNamed = (name: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === name) ?? null;

async function mount() {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  root.render(<LoginPage />);
  await until('the email step is up', () => email() !== null);
}

/** Through a successful send to the code step. */
async function toCodeStep(address = 'lin@example.com') {
  auth.requestLoginOtp.mockResolvedValueOnce({ success: true });
  await userEvent.fill(email(), address);
  await userEvent.click(submit());
  await until('the code step is up', () => otp() !== null && email() === null);
}

beforeAll(async () => {
  await i18n.changeLanguage('zh-CN');
  // Every label below is compared with t(); without the page's catalog both sides would be the bare key and agree.
  expect(t('auth.continue'), 'the main catalog is not registered: every label check would pass on the key').not.toBe('auth.continue');
  await page.viewport(1080, 760);
});
beforeEach(async () => {
  vi.clearAllMocks();
  document.documentElement.removeAttribute('data-theme');
  await mount();
});
type Cdp = { send: (method: string, params: object) => Promise<unknown> };
/** The real media feature, set on the browser (CDP), as the OS setting would: the page's matchMedia answers it. */
async function emulateReducedMotion(value: 'reduce' | 'no-preference' | null) {
  await (cdp() as unknown as Cdp).send('Emulation.setEmulatedMedia', { features: value ? [{ name: 'prefers-reduced-motion', value }] : [] });
  if (value) await until(`the page reads prefers-reduced-motion: ${value}`, () => matchMedia(`(prefers-reduced-motion: ${value})`).matches);
}

afterEach(async () => {
  await emulateReducedMotion(null);
  vi.useRealTimers();
  root.unmount();
  host.remove();
});
afterAll(() => document.documentElement.removeAttribute('data-theme'));

describe('the login page in the master\'s roles (#7333)', () => {
  for (const theme of ['dark', 'light'] as const) {
    it(`paints the primary button ink with the inverted foreground — ${theme}`, async () => {
      if (theme === 'light') document.documentElement.setAttribute('data-theme', 'light');
      const button = submit();
      const ink = { background: token('--primary', 'background-color'), color: token('--primary-fg') };
      // Empty email: disabled, still ink and its inverse, at the host's .58.
      expect(button.disabled).toBe(true);
      await untilStable(`disabled primary settles (${theme})`, () => [css(button, 'background-color'), css(button, 'color'), css(button, 'opacity')]);
      expect({ background: css(button, 'background-color'), color: css(button, 'color'), opacity: css(button, 'opacity') }).toEqual({ ...ink, opacity: '0.58' });
      if (theme === 'dark') {
        // The old label was --surface-white = the card face; the master's is the inverse ink (the page surface).
        expect(ink.color, 'dark --primary-fg and the card face are one colour: this reading cannot tell them apart').not.toBe(token('--card'));
      }
      await userEvent.fill(email(), 'lin@example.com');
      await until('the primary enables', () => !button.disabled);
      await untilStable(`enabled primary settles (${theme})`, () => [css(button, 'background-color'), css(button, 'color'), css(button, 'opacity')]);
      expect({ background: css(button, 'background-color'), color: css(button, 'color'), opacity: css(button, 'opacity') }).toEqual({ ...ink, opacity: '1' });
      await userEvent.hover(button);
      await untilStable(`hovered primary settles (${theme})`, () => css(button, 'opacity'));
      expect({ background: css(button, 'background-color'), color: css(button, 'color'), opacity: css(button, 'opacity') }).toEqual({ ...ink, opacity: '0.88' });
      await userEvent.hover(q('.gugu-auth-headline')!);
      // Keyboard focus: the ring (Tab from the email field lands on the button).
      email().focus();
      await userEvent.tab();
      expect(document.activeElement).toBe(button);
      expect(button.matches(':focus-visible')).toBe(true);
      expect({ style: css(button, 'outline-style'), width: css(button, 'outline-width') }).toEqual({ style: 'solid', width: '2px' });
    });
  }

  it('sets the page in the ladder: headline 24/32, wordmark 20/28, field and button 40 high, control text 14, legal 12/18', () => {
    expect(type(q('.gugu-auth-headline')!)).toEqual({ size: 24, leading: 32, weight: 600 });
    const wordmark = [...host.querySelectorAll('span')].find((s) => s.textContent === t('brand.name'))!;
    expect(type(wordmark)).toMatchObject({ size: 20, leading: 28 });
    expect(box(email()).height).toBe(40);
    expect(box(submit()).height).toBe(40);
    expect(type(submit()).size).toBe(14);
    const legal = q('a[href$="/terms.html"]')!.closest('p')!;
    expect(type(legal)).toMatchObject({ size: 12, leading: 18 });
  });

  it('gives the field and the button the touch size under the phone width', async () => {
    await page.viewport(412, 800);
    try {
      await until('the touch size applies', () => box(submit()).height === 44);
      expect(box(email()).height).toBe(44);
    } finally {
      await page.viewport(1080, 760);
    }
  });
});

describe('the login page keeps its real flow (母版补页 05: eight states)', () => {
  it('填邮箱: an empty or malformed email does not submit; the legal links open as before', async () => {
    expect(submit().disabled).toBe(true);
    await userEvent.fill(email(), 'not-an-email');
    expect(submit().disabled).toBe(false);
    await userEvent.click(submit());
    expect(email().validity.valid, 'the email type check is gone').toBe(false);
    expect(auth.requestLoginOtp).not.toHaveBeenCalled();
    for (const name of ['terms', 'privacy']) {
      const link = q<HTMLAnchorElement>(`a[href="https://gugu.nextmind.space/zh/${name}.html"]`)!;
      expect({ target: link.target, rel: link.rel }).toEqual({ target: '_blank', rel: 'noreferrer' });
    }
  });

  it('正在发送 → 发送失败: the button waits on the real request, then the error stays in the form and offers a retry', async () => {
    const send = pending();
    auth.requestLoginOtp.mockReturnValueOnce(send.promise);
    await userEvent.fill(email(), 'lin@example.com');
    await userEvent.click(submit());
    expect(auth.requestLoginOtp).toHaveBeenCalledWith('lin@example.com');
    await until('the button shows the loading state', () => submit().querySelector('[data-gg-loading="inline"]') !== null);
    expect(submit().disabled).toBe(true);
    expect(submit().querySelector('[data-gg-loading]')!.getAttribute('aria-label')).toBe(t('auth.continue'));
    send.answer({ success: false, error: '发送太频繁' });
    await until('the error is in the form', () => alertText() === '发送太频繁');
    expect(email(), 'a failed send left the email step').not.toBeNull();
    expect(submit().textContent).toBe(t('auth.retry'));
    // Typing clears the error, as before.
    await userEvent.fill(email(), 'lin@example.org');
    await until('the error clears on input', () => alertText() === null);
    expect(submit().textContent).toBe(t('auth.continue'));
  });

  it('填验证码: names the address, takes six digits only, and does not submit short', async () => {
    await toCodeStep();
    expect(host.textContent).toContain(t('auth.otpSent', { email: 'lin@example.com' }));
    expect(getComputedStyle(otp()).fontFamily).toBe(token('--font-family-mono', 'font-family'));
    // Typed key by key, as a person does: letters are dropped on each keystroke, and the field stops at six.
    await userEvent.type(otp(), 'ab12cd345678');
    await until('only six digits are kept', () => otp().value === '123456');
    await userEvent.fill(otp(), '12345');
    await until('five digits are kept', () => otp().value === '12345');
    expect(submit().disabled).toBe(true);
    await userEvent.fill(otp(), '123456');
    await until('six digits enable the login', () => !submit().disabled);
    expect(submit().textContent).toBe(t('auth.login'));
    // The two text buttons are the host's ghost buttons: secondary text, 32 high on the desktop.
    const change = buttonNamed(t('auth.changeEmail'))!;
    expect({ color: css(change, 'color'), height: box(change).height }).toEqual({ color: token('--text-secondary'), height: 32 });
  });

  it('验证中 → 验证失败 → 成功: the coordinator\'s attempt carries the session; a failure keeps the code and offers a retry', async () => {
    await toCodeStep();
    await userEvent.fill(otp(), '123456');
    const verify = pending();
    auth.verifyLoginOtp.mockReturnValueOnce(verify.promise);
    await userEvent.click(submit());
    expect(coordinator.beginInteractiveLogin).toHaveBeenCalledTimes(1);
    expect(auth.verifyLoginOtp).toHaveBeenCalledWith('lin@example.com', '123456');
    await until('the button shows the loading state', () => submit().querySelector('[data-gg-loading="inline"]') !== null);
    expect(submit().disabled).toBe(true);
    verify.answer({ success: false, error: '验证码错误' });
    await until('the error is in the form', () => alertText() === '验证码错误');
    expect(otp().value, 'a failed verify cleared the code').toBe('123456');
    expect(submit().textContent).toBe(t('auth.retry'));
    expect(coordinator.acceptInteractiveSession).not.toHaveBeenCalled();
    const session = { access_token: 'token' };
    auth.verifyLoginOtp.mockResolvedValueOnce({ success: true, session });
    await userEvent.click(submit());
    await until('the session reaches the coordinator', () => coordinator.acceptInteractiveSession.mock.calls.length === 1);
    expect(coordinator.acceptInteractiveSession).toHaveBeenCalledWith(7, session);
  });

  it('重发等待: 60 seconds after a successful send, no resend while waiting; a failed resend starts no countdown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await toCodeStep();
    const resend = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.startsWith(t('auth.resend')))!;
    expect(resend().textContent).toBe(t('auth.resendCountdown', { seconds: 60 }));
    expect(resend().disabled).toBe(true);
    await untilStable('the waiting resend settles', () => css(resend(), 'opacity'));
    expect(css(resend(), 'opacity')).toBe('0.58');
    for (let left = 59; left >= 0; left -= 1) {
      // The next tick is scheduled by an effect after the render: advance only once it is there.
      await until(`the tick before ${left} is scheduled`, () => vi.getTimerCount() > 0);
      vi.advanceTimersByTime(1000);
      const label = left > 0 ? t('auth.resendCountdown', { seconds: left }) : t('auth.resend');
      await until(`the countdown reads ${left}`, () => resend().textContent === label);
    }
    expect(resend().disabled).toBe(false);
    auth.requestLoginOtp.mockResolvedValueOnce({ success: false, error: '发送失败' });
    await userEvent.click(resend());
    await until('the resend error shows', () => alertText() === '发送失败');
    expect(resend().textContent, 'a failed resend started the countdown').toBe(t('auth.resend'));
    expect(resend().disabled).toBe(false);
    auth.requestLoginOtp.mockResolvedValueOnce({ success: true });
    await userEvent.click(resend());
    await until('a successful resend restarts at 60', () => resend().textContent === t('auth.resendCountdown', { seconds: 60 }));
    expect(alertText()).toBeNull();
    expect(auth.requestLoginOtp).toHaveBeenLastCalledWith('lin@example.com');
  });

  it('换邮箱: back to the email step with the address kept, the code and the error cleared, no confirmation', async () => {
    await toCodeStep();
    await userEvent.fill(otp(), '123456');
    auth.verifyLoginOtp.mockResolvedValueOnce({ success: false, error: '验证码错误' });
    await userEvent.click(submit());
    await until('the error is in the form', () => alertText() === '验证码错误');
    await userEvent.click(buttonNamed(t('auth.changeEmail'))!);
    await until('the email step is back', () => email() !== null && otp() === null);
    expect(email().value).toBe('lin@example.com');
    expect(alertText()).toBeNull();
    expect(submit().textContent).toBe(t('auth.continue'));
    expect(host.querySelector('[role="dialog"], [role="alertdialog"]')).toBeNull();
    await toCodeStep();
    expect(otp().value, 'the old code came back').toBe('');
  });
});

/**
 * product spec:「系统开启「减弱动态」时,全部动效降级为即时。」The step switch is framer-motion's JS
 * (a 10px slide and a fade), which the CSS rule in tokens.css cannot reach. Every animation frame across both switches
 * (email → code, code → email) is read: under reduce no form is ever drawn moved or faded. The same reading under
 * no-preference must see the motion — the probe can see it, and the ordinary switch is kept.
 */
describe('the login step switch under the reduced-motion setting', () => {
  type Frame = { opacity: number; x: number }[];
  /** Every frame from the action until the target step has stood still for a few frames: each form's opacity and x offset. */
  async function framesAcross(action: () => Promise<void>, arrived: () => boolean) {
    const frames: Frame[] = [];
    let sampling = true;
    const sample = () => {
      frames.push([...host.querySelectorAll('form')].map((form) => {
        const style = getComputedStyle(form);
        const matrix = style.transform === 'none' ? null : new DOMMatrixReadOnly(style.transform);
        return { opacity: Number(style.opacity), x: matrix ? matrix.m41 : 0 };
      }));
      if (sampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    await action();
    await until('the step arrived', arrived);
    await untilStable('the step stands still', () => [...host.querySelectorAll('form')].map((form) => [getComputedStyle(form).opacity, getComputedStyle(form).transform]));
    sampling = false;
    return frames;
  }
  const moved = (frames: Frame[]) => frames.filter((frame) => frame.some((form) => form.opacity < 1 || Math.abs(form.x) > 0.01)).length;
  const toCode = () => framesAcross(async () => {
    auth.requestLoginOtp.mockResolvedValueOnce({ success: true });
    await userEvent.fill(email(), 'lin@example.com');
    await userEvent.click(submit());
  }, () => otp() !== null && email() === null);
  const backToEmail = () => framesAcross(async () => {
    await userEvent.click(buttonNamed(t('auth.changeEmail'))!);
  }, () => email() !== null && otp() === null);

  it('switches instantly, with nothing moved or faded, when the setting is on — and follows the setting turned on while the page is open', async () => {
    await emulateReducedMotion('reduce');
    const forward = await toCode();
    const back = await backToEmail();
    expect(forward.length, 'the sampler read no frames').toBeGreaterThan(0);
    expect(moved(forward), 'a frame drew a form moved or faded on the way to the code step').toBe(0);
    expect(moved(back), 'a frame drew a form moved or faded on the way back to the email step').toBe(0);
  });

  it('keeps the ordinary slide and fade when the setting is off (and the sampler can see it)', async () => {
    await emulateReducedMotion('no-preference');
    expect(moved(await toCode()), 'no frame showed the switch moving: this sampler cannot see motion').toBeGreaterThan(0);
    expect(moved(await backToEmail())).toBeGreaterThan(0);
  });
});
