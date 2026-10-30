import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { runtimeAuthFromSupabaseTokens } from '@gugu/core/cloud/runtimeAuthProvider';

// The actual auth IPC handlers and their auth-change fan-out, run without booting Electron main (as in #1059).
const source = ts.createSourceFile('main.ts', readFileSync(resolve('apps/desktop/electron/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const changed = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'onHumanAuthSessionChanged');
function handler(channel: string, context: Record<string, unknown>) {
  const statement = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === 'ipcMain.handle'
    && ts.isStringLiteral(node.expression.arguments[0]!) && node.expression.arguments[0].text === channel);
  if (!changed || !statement || !ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) throw new Error('Actual auth IPC is missing');
  const code = `${changed.getText(source)}\n(${statement.expression.arguments[1]!.getText(source)})`;
  return runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText,
    context) as (event: unknown, input: unknown) => Promise<unknown>;
}

describe('the local message search index follows the signed-in account', () => {
  it.each([
    ['write', 'new-owner'],
    ['clear', null],
  ] as const)('auth %s tells search the account only after persistence finished, and never waits on it', async (mode, expected) => {
    const disk = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
    const searchAccounts: (string | null)[] = [];
    const context: Record<string, unknown> = {
      pushedHumanAuth: { userId: 'owner', accessToken: 'fixture' }, runtimeAuthFromSupabaseTokens,
      projectionDeviceRuntime: { invalidate() {} },
      writeHumanAuthSession: async () => { entered.resolve(); await disk.promise; },
      clearHumanAuthSession: async () => { entered.resolve(); await disk.promise; },
      messageSearchAccountChanged: (accountId: string | null) => { searchAccounts.push(accountId); },
      nativeFiles: { ownerChanged: async () => {} }, refreshElectronSupabaseAuth: async () => {},
      deviceRuntimeHost: null, deviceProjectsPublisher: null, localDeviceId() {}, handOffWechatIfAny() {}, refreshPlatformCredentials() {},
    };
    const token = `fixture.${Buffer.from(JSON.stringify({ sub: 'new-owner' })).toString('base64url')}.fixture`;
    const running = handler(`human-auth-session:${mode}`, context)(null, mode === 'clear' ? 'lost' : { access_token: token });
    await Promise.race([entered.promise, running]);
    expect(searchAccounts).toEqual([]);
    disk.resolve();
    await running;
    expect(searchAccounts).toEqual([expected]);
  });
});
