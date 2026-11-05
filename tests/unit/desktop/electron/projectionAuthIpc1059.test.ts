import { describe, expect, it } from 'vitest';
import { runtimeAuthFromSupabaseTokens } from '@gugu/core/cloud/runtimeAuthProvider';
import { createProjectionDeviceRuntime } from '../../../../apps/desktop/electron/projection-device-runtime';
import { projectionControlKey, projectionControlSigner } from '../../../../apps/desktop/electron/projection-control-auth';
import { createHumanAuthSessionIpc } from '../../../../apps/desktop/electron/runtime-auth-provider';

// The handlers main registers for human-auth-session:write / :clear (createHumanAuthSessionIpc), wired to the same
// globals main gives them; the auth-change notifier and session-life are the context's stubs.
function handler(channel: string, context: Record<string, unknown>) {
  const fn = (name: string) => context[name] as (...args: unknown[]) => Promise<unknown>
  const ipc = createHumanAuthSessionIpc({
    toAuth: context.runtimeAuthFromSupabaseTokens as typeof runtimeAuthFromSupabaseTokens,
    set: (auth) => { context.pushedHumanAuth = auth },
    revoke: () => (context.projectionDeviceRuntime as { invalidate(): void }).invalidate(),
    persist: (mirror) => fn('writeHumanAuthSession')(mirror),
    erase: () => fn('clearHumanAuthSession')(),
    leaveIfChanging: (next) => fn('sessionLifeLeaveIfChanging')(next) as Promise<void>,
    enter: () => fn('sessionLifeEnter')() as Promise<void>,
    changed: () => (context.projectionDeviceRuntime as { invalidate(): void }).invalidate(),
  })
  if (channel === 'human-auth-session:write') return (_event: unknown, input: unknown) => ipc.write(input as { access_token: string })
  if (channel === 'human-auth-session:clear') return (_event: unknown, input: unknown) => ipc.clear(input)
  throw new Error('Actual auth IPC is missing')
}

describe('actual auth IPC revokes projection before persistence', () => {
  it.each(['clear', 'write'] as const)('%s rejects the old signer while auth disk IO is still pending', async mode => {
    const disk = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const old = { userId: 'owner', accessToken: 'fixture' };
    const context: Record<string, unknown> = { pushedHumanAuth: old };
    const runtime = createProjectionDeviceRuntime({ auth: async () => context.pushedHumanAuth === old ? old : null,
      runtime: () => ({ ownerId: 'owner', deviceId: 'device', runtimeInstanceId: 'instance' }),
      resources: () => '', report() {}, capturePage: async () => { throw new Error('Unexpected page'); },
      openPipe: async () => { throw new Error('Unexpected pipe'); } });
    Object.assign(context, { projectionDeviceRuntime: runtime, runtimeAuthFromSupabaseTokens,
      writeHumanAuthSession: async () => { entered.resolve(); await disk.promise; },
      clearHumanAuthSession: async () => { entered.resolve(); await disk.promise; },
      nativeFiles: { ownerChanged: async () => {} }, refreshElectronSupabaseAuth: async () => {},
      deviceRuntimeHost: null, deviceProjectsPublisher: null, emdashBridgeModule: null,
      humanAuthUserId: () => (typeof context.pushedHumanAuth === 'object' ? (context.pushedHumanAuth as { userId?: string } | null)?.userId ?? null : null), localDeviceId() {}, handOffWechatIfAny() {}, refreshPlatformCredentials() {},
      // session-life's account transition around the credential change (its own ordering is the owner's tests).
      sessionLifeLeaveIfChanging: async () => {}, sessionLifeEnter: async () => {},
    });
    const lease = await runtime.options.identity.capture(new AbortController().signal);
    const sign = projectionControlSigner(projectionControlKey(), 'binding', 'source', lease.assertCurrent);
    expect(sign('old packet')).toContain('mac');
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'new-owner' })).toString('base64url')}.fixture`;
    const running = handler(`human-auth-session:${mode}`, context)(null, mode === 'clear' ? 'lost' : { access_token: token });
    try {
      await entered.promise;
      if (mode === 'clear') expect(context.pushedHumanAuth).toBe('lost');
      else expect(context.pushedHumanAuth).toMatchObject({ userId: 'new-owner' });
      expect(lease.signal.aborted).toBe(true);
      expect(() => sign('late input')).toThrow(/authentication changed/);
    } finally { disk.resolve(); await running; await runtime.dispose(); }
  });
});
