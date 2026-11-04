import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import ts from 'typescript'
import { createUpdateState, createUpdateStateReceiver } from '../../../../apps/desktop/shared/update-state'

describe('#1342 host update revisions', () => {
  it('increments for every published state and preserves the revision of a captured reply', () => {
    const host = createUpdateState({ status: 'idle', percent: undefined as number | undefined })
    expect(host.current.revision).toBe(0)
    const reply = host.publish({ status: 'downloaded', percent: undefined })!
    expect(reply.revision).toBe(1)
    expect(host.publish({ status: 'downloading', percent: 12.3 })?.revision).toBe(2)
    expect(host.publish({ status: 'downloading', percent: 78.9 })?.revision).toBe(3)
    expect(reply).toEqual({ status: 'downloaded', percent: undefined, revision: 1 })
    expect(host.current.percent).toBe(78.9)
  })

  it('does not allocate a revision to a state the host does not publish', () => {
    const host = createUpdateState({ status: 'downloaded' })
    expect(host.publish({ status: 'not-available' })).toBeNull()
    expect(host.current).toEqual({ status: 'downloaded', revision: 0 })
  })

  it('accepts strictly higher revisions, including a live event before an older snapshot', () => {
    const receive = createUpdateStateReceiver()
    expect(receive({ revision: 0 })).toBe(true)
    expect(receive({ revision: 3 })).toBe(true)
    expect(receive({ revision: 1 })).toBe(false)
    expect(receive({ revision: 3 })).toBe(false)
    expect(receive({ revision: 4 })).toBe(true)
  })

  it.each([undefined, null, {}, { revision: -1 }, { revision: NaN }, { revision: '3' }])(
    'does not treat an unstamped or invalid state as newer: %s', (state) => {
      expect(createUpdateStateReceiver()(state)).toBe(false)
    },
  )
})

function actualCheckOutcome(mode: 'automatic' | 'manual') {
  const source = ts.createSourceFile('main.ts', readFileSync(resolve('apps/desktop/electron/main.ts'), 'utf8'), ts.ScriptTarget.Latest, true)
  const functions = ['checkForUpdates', 'startAutoUpdateChecks'].map(name => {
    const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
    if (!declaration) throw new Error(`Missing actual ${name}`)
    return declaration.getText(source)
  })
  const ipc = source.statements.find(node => ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)
    && node.expression.expression.getText(source) === 'ipcMain.handle'
    && ts.isStringLiteral(node.expression.arguments[0]!) && node.expression.arguments[0].text === 'updates:check')
  if (!ipc || !ts.isExpressionStatement(ipc) || !ts.isCallExpression(ipc.expression)) throw new Error('Missing actual updates:check RPC')
  const compiled = ts.transpileModule(`${functions.join('\n')}\nconst manual = ${ipc.expression.arguments[1]!.getText(source)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText
  // A separate real Node event loop observes detached rejections without masking Vitest's handler.
  const child = spawnSync(process.execPath, ['-e', `
    const offline = new Error('Network offline'), warnings = [], unhandled = [], timers = [];
    const updaterPolicy = { enabled: true }, IS_TEST_MODE = false;
    const AUTO_UPDATE_INITIAL_DELAY_MS = 10000, AUTO_UPDATE_INTERVAL_MS = 1800000;
    const updaterState = { current: { revision: 7, status: 'downloading', percent: 42 } };
    const originalState = updaterState.current;
    const autoUpdater = { checkForUpdates: () => Promise.reject(offline) };
    const emitUpdateStatus = () => { throw new Error('A failed query must not publish state'); };
    const console = { warn: (...args) => warnings.push(args) };
    const setTimeout = callback => timers.push(callback), setInterval = callback => timers.push(callback);
    process.on('unhandledRejection', error => unhandled.push(error.message));
    ${compiled}
    (async () => {
      let rejectedWithOriginalError = false;
      if (${JSON.stringify(mode)} === 'automatic') {
        startAutoUpdateChecks();
        for (const callback of timers) callback();
        await new Promise(setImmediate);
        await new Promise(setImmediate);
      } else {
        try { await manual(); } catch (error) { rejectedWithOriginalError = error === offline; }
      }
      process.stdout.write(JSON.stringify({ timerCount: timers.length, warnings, unhandled,
        rejectedWithOriginalError, stateUnchanged: updaterState.current === originalState }));
    })().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
  `], { encoding: 'utf8', timeout: 10000 })
  if (child.status !== 0) throw new Error(`Actual update check child failed: ${child.stderr}`)
  return JSON.parse(child.stdout) as {
    timerCount: number; warnings: unknown[][]; unhandled: string[]; rejectedWithOriginalError: boolean; stateUnchanged: boolean
  }
}

describe('#1342 actual update check entry points', () => {
  it('both automatic timers warn on network failure without an unhandled rejection or state change', () => {
    const outcome = actualCheckOutcome('automatic')
    expect(outcome.timerCount).toBe(2)
    expect(outcome.warnings).toEqual([
      ['[updater] check failed:', 'Network offline'],
      ['[updater] check failed:', 'Network offline'],
    ])
    expect(outcome.unhandled).toEqual([])
    expect(outcome.stateUnchanged).toBe(true)
  })

  it('manual RPC still rejects with the original network error and preserves live progress', () => {
    const outcome = actualCheckOutcome('manual')
    expect(outcome.rejectedWithOriginalError).toBe(true)
    expect(outcome.warnings).toEqual([['[updater] check failed:', 'Network offline']])
    expect(outcome.unhandled).toEqual([])
    expect(outcome.stateUnchanged).toBe(true)
  })
})
