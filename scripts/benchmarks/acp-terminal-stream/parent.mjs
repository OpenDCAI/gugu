import { spawnRuntime } from '../../../packages/session-wire/src/util/process-runtime/process-runtime.ts'
import { childProcessHost } from '../../../packages/session-wire/src/process/node/child-process-host.ts'
import { createScope } from '../../../packages/session-wire/src/util/scope.ts'
import { acpRuntimeApiContract } from '../../../packages/session-core/src/acp/api/runtime-contract.ts'
import { applyPatches } from '../../../packages/session-wire/src/live/state/immer-setup.ts'
import { writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
;(async () => {
  const dir = process.argv[2]
  const mode = process.argv[3]
  const scope = createScope({ label: 'memory-benchmark' })
  let measured
  let received = 0
  let data = []
  let doneResolve
  const done = new Promise((r) => (doneResolve = r))
  let pid
  const worker = await spawnRuntime({
    host: childProcessHost(),
    contract: acpRuntimeApiContract,
    scope,
    spec: {
      entry: dir + '/acp-runtime.' + mode + '.mjs',
      env: {
        GUGU_HOME: dir + '/home-' + mode,
        GUGU_USER_DATA_DIR: dir + '/profile-' + mode,
        GUGU_ACP_ATTACHMENTS_DIR: dir + '/archive-' + mode,
        BENCH_PROVIDER: dir + '/provider.mjs',
        NODE_OPTIONS: '--max-old-space-size=768'
      },
      supervision: { restart: 'never' }
    },
    onProcess: (process) => {
      pid = process.pid
      process.onMessage((m) => {
        if (m?.kind === 'benchmark-result') measured = m
      })
      process.onStdio((stream, chunk) => {
        if (stream === 'stderr' && /error|failed/i.test(chunk)) console.error(chunk.slice(0, 600))
      })
    }
  })
  let stopForMemory
  const memoryLimit = new Promise((_, reject) => {
    stopForMemory = setInterval(() => {
      try {
        const rss = Number(
          execFileSync('ps', ['-p', String(pid), '-o', 'rss='], { encoding: 'utf8' }).trim()
        )
        if (rss > 3 * 1024 * 1024) reject(new Error('Owned benchmark worker exceeded 3 GiB RSS'))
      } catch (error) {
        reject(error)
      }
    }, 500)
  })
  try {
    const started = await worker.client.startSession({
      input: {
        sessionId: 's',
        projectId: 'p',
        providerId: 'codex',
        workspaceId: 'w',
        cwd: dir,
        providerSessionId: null,
        model: null,
        runContext: {
          cli: { kind: 'resolved', path: process.execPath },
          env: { HOME: dir + '/home-' + mode, PATH: process.env.PATH },
          configRootEnv: {},
          selfUpdateEnv: {},
          extraArgs: []
        }
      }
    })
    if (!started.success) throw new Error(JSON.stringify(started))
    const model = worker.client.session.state(
      { sessionId: 's' },
      mode === 'after' ? 'terminalChunks' : 'terminals'
    )
    const first = await model.snapshot()
    data = first.data
    const unsub = await model.attach((update) => {
      received += Buffer.byteLength(JSON.stringify(update))
      data = applyPatches(data, update.delta)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 120)
      if (data[0]?.exitStatus) doneResolve()
    })
    await Promise.race([
      done,
      memoryLimit,
      new Promise((_, reject) => setTimeout(() => reject(new Error('benchmark timeout')), 60000))
    ])
    unsub()
    if (mode === 'after') {
      const expected = createHash('sha256'),
        actual = createHash('sha256')
      const chunk = Buffer.alloc(65536, 65)
      for (let n = 0; n < 400; n++) expected.update(chunk)
      let offset = 0
      while (offset < 25 * 1024 * 1024) {
        const page = await worker.client.readTerminalOutput({
          sessionId: 's',
          terminalId: data[0].terminalId,
          offset,
          limit: 65536
        })
        actual.update(Buffer.from(page.data, 'base64'))
        if (page.nextOffset <= offset) throw new Error('Archive stopped before all input bytes')
        offset = page.nextOffset
      }
      if (actual.digest('hex') !== expected.digest('hex'))
        throw new Error('Archive digest does not match 25 MiB input')
    }
    worker.process.send({ kind: 'benchmark-measure' })
    const until = Date.now() + 5000
    while (!measured && Date.now() < until) await new Promise((r) => setTimeout(r, 20))
    if (!measured) throw new Error('missing worker measurement')
    const result = {
      mode,
      pid,
      source: process.env.BENCH_SOURCE,
      inputBytes: 25 * 1024 * 1024,
      wireBytes: received,
      terminalBytes: data[0]?.outputBytes,
      liveBytes: Buffer.byteLength(
        data[0]?.output || Object.values(data[0]?.outputChunks || {}).join('')
      ),
      truncated: data[0]?.truncated,
      ...measured
    }
    writeFileSync(dir + '/' + mode + '.json', JSON.stringify(result, null, 2))
    console.log(JSON.stringify(result))
  } finally {
    clearInterval(stopForMemory)
    await scope.dispose()
  }
})().then(
  () => process.exit(0),
  (e) => {
    console.error(e)
    process.exit(1)
  }
)
