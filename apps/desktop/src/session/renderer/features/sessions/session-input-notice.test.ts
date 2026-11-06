import { describe, expect, it, vi } from 'vitest';
import { createSessionInputNotices } from './session-input-notice';
import { creationFailureCopy, sessionStartupFailureCopy } from './session-input-failure-copy';
import { translateSessionMessage } from '@renderer/localization/locale-store';

vi.mock('@renderer/utils/logger', () => ({ log: { error: vi.fn() } }));
const raw = '本机 Codex 无法启动 app-server；请升级 Codex 后重试。原始错误：local Codex app-server exited (code=1 signal=null)';
function setup() {
  const outlet = { notify: vi.fn(), dismiss: vi.fn(), diagnostic: vi.fn() };
  return { ...outlet, notices: createSessionInputNotices(outlet) };
}

describe('session input failure notices', () => {
  it('shows safe repair copy while preserving the entire diagnostic in the existing log sink', () => {
    const h = setup(), owner = Symbol();
    h.notices.attach('catalog:codex', owner);
    h.notices.update('catalog:codex', owner, { title: sessionStartupFailureCopy(raw, translateSessionMessage), diagnostic: raw });
    expect(h.notify).toHaveBeenCalledTimes(1);
    const shown = h.notify.mock.calls[0]![0];
    expect(shown.title).toMatch(/Codex/);
    expect(shown.title).toMatch(/升级|Update/);
    expect(JSON.stringify(shown)).not.toMatch(/app-server|code=|signal=|原始错误/);
    expect(h.diagnostic).toHaveBeenCalledWith('catalog:codex', raw);
  });

  it('updates one notice, retains user dismissal across retries and remounts, and resets only after recovery', () => {
    const h = setup(), owner = Symbol(), spec = { title: 'Read failed. Retry.', diagnostic: raw };
    const detach = h.notices.attach('catalog', owner);
    h.notices.update('catalog', owner, spec);
    h.notices.update('catalog', owner, { ...spec });
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.notify.mock.calls[0]![0].onDismiss!();
    h.notices.update('catalog', owner, undefined);
    h.notices.update('catalog', owner, { ...spec, diagnostic: `${raw}\nsecond attempt` });
    expect(h.notify).toHaveBeenCalledTimes(1);
    expect(h.diagnostic).toHaveBeenCalledTimes(2);
    detach();
    const secondOwner = Symbol();
    h.notices.attach('catalog', secondOwner);
    h.notices.update('catalog', secondOwner, spec);
    expect(h.notify).toHaveBeenCalledTimes(1);
    h.notices.update('catalog', secondOwner, null);
    expect(h.dismiss).toHaveBeenCalledWith('catalog');
    h.notices.update('catalog', secondOwner, spec);
    expect(h.notify).toHaveBeenCalledTimes(2);
  });

  it('keeps the shared failure when one of two composers recovers and executes a current live action', () => {
    const h = setup(), a = Symbol(), b = Symbol(), runA = vi.fn(), runB = vi.fn();
    const detach = h.notices.attach('catalog', a);
    h.notices.attach('catalog', b);
    h.notices.update('catalog', a, { title: 'Read failed', action: { label: 'Retry', onClick: runA } });
    h.notices.update('catalog', b, { title: 'Read failed', action: { label: 'Retry', onClick: runB } });
    detach();
    h.notify.mock.calls[0]![0].action!.onClick();
    expect(runA).not.toHaveBeenCalled();
    expect(runB).toHaveBeenCalledTimes(1);
    h.notices.update('catalog', a, null);
    expect(h.dismiss).not.toHaveBeenCalled();
    h.notices.update('catalog', b, null);
    expect(h.dismiss).toHaveBeenCalledTimes(1);
  });

  it('never renders unknown creation/setup diagnostic fields as product copy', () => {
    for (const failure of [{ kind: 'raw', detail: raw }, { kind: 'setup-step-failed', stepKind: 'spawn-process', stepErrorType: 'ENOENT', detail: raw }] as const) {
      const text = creationFailureCopy(failure, translateSessionMessage);
      expect(text).not.toMatch(/app-server|ENOENT|spawn-process|code=|signal=|taskError\./);
      expect(text.trim()).not.toBe('');
    }
  });
});
