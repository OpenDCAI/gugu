#!/usr/bin/env node
// @@@storybook-gate (#3076, 扩于 #3526) — 对一份已构建的 storybook 产物读两种独立读数。
//
// 两条子命令守的是**两种不同形状的坏**,这不是冗余:
//
//   coverage — 产物 index.json 里每个跟踪中的 story 源文件都至少登记一次。
//              别名表漂移这类「模块解析不到」的坏由 `storybook build` 自己红,rollup 遇第一个
//              未解析 import 就停,所以 exit code 分不出「报错换了一条」和「修好了」;登记覆盖面
//              才能说出构建是否完整。
//
//   render   — 真开一个 chromium,逐个打开抽样 story 的 iframe,读 `#storybook-root` 的子节点数。
//              这一条不能由 coverage 代替:#3526 实测过一个 exit=0 且 173 条 story 全部登记、
//              而每个 story 的预览 iframe 都是空的树 —— vanilla-extract 插件缺席时 `.css.ts`
//              被当普通 TS 编译,`style()` 在浏览器里抛「Styles were unable to be assigned to
//              a file」,构建那侧一个字都不会红。⇒ 「构建绿」与「故事真的渲染」是两个读数。
//
// 用法:
//   node scripts/storybook-gate.mjs coverage --static <dir> --story-root <git pathspec>
//   node scripts/storybook-gate.mjs render   --static <dir> [--sample N]
import { execFileSync } from 'node:child_process'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'

const argv = process.argv.slice(2)
const command = argv[0]
const flag = (name, fallback = undefined) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

const staticDir = flag('static', 'storybook-static')

function readIndex() {
  const indexPath = path.join(staticDir, 'index.json')
  if (!existsSync(indexPath)) throw new Error(`${indexPath} does not exist — did the build run?`)
  const index = JSON.parse(readFileSync(indexPath, 'utf8'))
  if (!index.entries || typeof index.entries !== 'object' || Array.isArray(index.entries)) {
    throw new Error(`${indexPath} has no entries object`)
  }
  return index
}

function verifyCoverage() {
  const storyRoot = flag('story-root')
  if (!storyRoot) throw new Error('coverage needs --story-root <git pathspec>')

  const sourceStoryFiles = execFileSync('git', ['ls-files', '-z', '--', storyRoot])
    .toString('utf8')
    .split('\0')
    .filter((file) => file.endsWith('.stories.tsx') || file.endsWith('.stories.ts') || file.endsWith('.mdx'))
    .sort()

  const index = readIndex()
  const entries = Object.values(index.entries)
  const storyEntries = entries.filter((entry) => entry?.type === 'story')

  // index.json `importPath` is relative to whichever cwd the build ran from; normalise against the
  // handful of plausible bases rather than guessing one.
  const bases = ['', storyRoot.split('/').slice(0, 2).join('/')]
  const indexedPaths = new Set()
  for (const entry of entries) {
    if (typeof entry?.importPath !== 'string') continue
    for (const base of bases) {
      indexedPaths.add(path.posix.normalize(path.posix.join(base, entry.importPath)))
    }
  }

  const indexedSourceStoryFiles = sourceStoryFiles.filter((file) => indexedPaths.has(file))
  const missingSourceStoryFiles = sourceStoryFiles.filter((file) => !indexedPaths.has(file))
  console.log(
    JSON.stringify(
      {
        storyRoot,
        sourceStoryFileCount: sourceStoryFiles.length,
        storyEntryCount: storyEntries.length,
        sourceStoryFiles,
        indexedSourceStoryFiles,
        missingSourceStoryFiles,
      },
      null,
      2,
    ),
  )

  if (sourceStoryFiles.length === 0) throw new Error(`tracked story source list under ${storyRoot} is empty`)
  if (storyEntries.length === 0) throw new Error('Storybook index contains zero story entries')
  if (missingSourceStoryFiles.length > 0) {
    throw new Error(`Storybook index omitted ${missingSourceStoryFiles.length} tracked story source file(s)`)
  }
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.map': 'application/json',
}

async function serveStatic() {
  const server = createServer((req, res) => {
    let target = path.join(staticDir, path.normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)))
    if (existsSync(target) && statSync(target).isDirectory()) target = path.join(target, 'index.html')
    if (!existsSync(target)) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(target)] ?? 'application/octet-stream' })
    createReadStream(target).pipe(res)
  })
  // On the shared CI pool each runner owns a port range; binding inside it keeps this server from
  // squatting a port another slot reserved. Locally (no slot bound) an ephemeral port is fine.
  const slotPort = process.env.GUGU_CI_PORT_START ? Number(process.env.GUGU_CI_PORT_START) + 7 : 0
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(slotPort, '127.0.0.1', resolve)
  })
  return { server, base: `http://127.0.0.1:${server.address().port}` }
}

async function verifyRender() {
  const sampleSize = Number(flag('sample', '6'))
  const index = readIndex()
  const storyEntries = Object.values(index.entries).filter((entry) => entry?.type === 'story')
  if (storyEntries.length === 0) throw new Error('Storybook index contains zero story entries')

  // Deterministic breadth sample: one story per source file, files in sorted order. Sampling across
  // files rather than taking the first N ids keeps a single component's variants from standing in
  // for the whole preview.
  const firstPerFile = new Map()
  for (const entry of [...storyEntries].sort((a, b) => a.id.localeCompare(b.id))) {
    if (!firstPerFile.has(entry.importPath)) firstPerFile.set(entry.importPath, entry)
  }
  const sample = [...firstPerFile.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, sampleSize)
    .map(([, entry]) => entry)

  const { chromium } = await import('playwright')
  const { server, base } = await serveStatic()
  // @@@render-settle (#4357) — 这一格不设墙钟预算:浏览器起来、页面加载、story 渲染完,等的都是事实。
  // 真挂住由 workflow job 的 timeout-minutes 收场,stderr 最后一行 `storybook-gate step=` 就是卡住的位置。
  const step = (name) => process.stderr.write(`storybook-gate step=${name}\n`)
  step('launch-chromium')
  const browser = await chromium.launch({ timeout: 0 })
  const results = []
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
    // Freeze CSS motion before the first story mounts so animation phase cannot become a pixel
    // difference between otherwise identical visual evidence captures.
    await page.emulateMedia({ reducedMotion: 'reduce' })
    for (const entry of sample) {
      const problems = []
      page.removeAllListeners('pageerror')
      page.on('pageerror', (error) => problems.push(`pageerror: ${error.message.split('\n')[0]}`))
      step(`load ${entry.id}`)
      await page.goto(`${base}/iframe.html?viewMode=story&id=${entry.id}`, {
        waitUntil: 'load',
        timeout: 0,
      })
      // The preview mounts asynchronously. Wait for Storybook itself to say the render settled —
      // the current render reached a terminal phase, or the preview switched to its error / no-preview
      // display — and only then read the root. An empty story settles like any other, so it is read
      // as empty instead of being guessed empty after some number of seconds.
      step(`render ${entry.id} (waiting for Storybook to settle the render)`)
      await page.waitForFunction(
        () => {
          const phase = window.__STORYBOOK_PREVIEW__?.currentRender?.phase
          const body = document.body.classList
          return ['finished', 'errored', 'aborted'].includes(phase)
            || body.contains('sb-show-errordisplay')
            || body.contains('sb-show-nopreview')
        },
        undefined,
        { timeout: 0, polling: 100 },
      )
      const reading = await page.evaluate(() => {
        const root = document.querySelector('#storybook-root')
        return {
          renderPhase: window.__STORYBOOK_PREVIEW__?.currentRender?.phase ?? null,
          rootPresent: Boolean(root),
          rootChildElementCount: root ? root.childElementCount : null,
          styleSheetCount: document.styleSheets.length,
        }
      })
      results.push({ id: entry.id, importPath: entry.importPath, ...reading, problems })
    }
  } finally {
    await browser.close()
    server.close()
  }

  const empty = results.filter((r) => !r.rootPresent || !(r.rootChildElementCount > 0))
  console.log(
    JSON.stringify(
      { storyEntryCount: storyEntries.length, sampledStoryCount: results.length, results, emptyCount: empty.length },
      null,
      2,
    ),
  )
  if (empty.length > 0) {
    throw new Error(
      `${empty.length}/${results.length} sampled stories rendered nothing into #storybook-root: ${empty
        .map((r) => r.id)
        .join(', ')}`,
    )
  }
  // 结论必须自带可见域。这一步看的是 N 条抽样,不是全部 story —— 写成「所有 story 都渲染」
  // 不需要说一句假话就把主语放大了,而没看的那些会被默默当成「没问题」。每个数字都来自上面的
  // 读数,不是一句无条件的标签。
  console.log(
    `PASS: 0/${results.length} sampled stories empty. Sample = the first story of each of ` +
      `${results.length} story source files, files sorted by path. ` +
      `NOT covered by this reading: the other ${storyEntries.length - results.length} indexed stories.`,
  )
}

if (command === 'coverage') verifyCoverage()
else if (command === 'render') await verifyRender()
else {
  console.error('usage: storybook-gate.mjs <coverage|render> --static <dir> [--story-root <pathspec>] [--sample N]')
  process.exit(2)
}
