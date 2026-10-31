import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { runtimeAuthFromSupabaseTokens } from '@gugu/core/cloud/runtimeAuthProvider';
import { createProjectionDeviceRuntime } from '../../../../apps/desktop/electron/projection-device-runtime';
import { projectionControlKey, projectionControlSigner } from '../../../../apps/desktop/electron/projection-control-auth';

const source = ts.createSourceFile('main.ts', readFileSync(resolve('apps/desktop/electron/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const changed = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'onHumanAuthSessionChanged');
function handler(channel: string, context: Record<string, unknown>) {
  const statement = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === 'ipcMain.handle'
    && ts.isStringLiteral(node.expression.arguments[0]!) && node.expression.arguments[0].text === channel);
  if (!changed || !statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) throw new Error('Actual auth IPC is missing');
  // Execute the actual callback and auth-change notifier without booting Electron main.
  const code = `${changed.getText(source)}\n(${statement.expression.arguments[1]!.getText(source)})`;
  return runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    context) as (event: unknown, input: unknown) => Promise<unknown>;
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
      deviceRuntimeHost: null, deviceProjectsPublisher: null, localDeviceId() {}, handOffWechatIfAny() {}, refreshPlatformCredentials() {},
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
