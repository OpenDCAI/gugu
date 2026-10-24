/** @jsxImportSource solid-js */
/**
 * link-sim 契约测试:用产品自己的渲染链(remark 解析 → 消毒后的 html 块锚点 →
 * 真实 classifyLink → onOpenFile)把「路径 → 锚点? → 分类 → 打开路由」整张表在真
 * Chromium 里跑一遍并真点击。它起源于 2026-09-17 的链接审计(双平台 A/B 读数与过程
 * 证据归档在 spex issue `acp-c-finder-explorer-win-posix-loading`),现在作为守门判据
 * 入库:改分类或路由,这张表先红。预测列用的路径判定从 workspace-path 导入同一份,
 * ❌ 不复刻(两份今天一致,改一边就分岔)。
 */
import { describe, expect, it } from 'vitest'
import { parseMarkdownToBlocks } from '../core/markdown/parse'
import { classifyFileLink } from '@gugu/core/shared/ui/guguLink'
import {
  isAbsolutePath,
  isPathInsideWorkspace,
  resolveWorkspacePath,
} from '@/session/renderer/features/sessions/stores/workspace-path'
import { getFileKind } from '@/session/renderer/lib/editor/fileKind'
import { attachmentOpenTarget } from '@/session/renderer/features/sessions/stores/attachment-open-target'
import { htmlBlockDef } from '@session-chat/components/rows/markdown/html/html.def'
import { makeContractCtx } from './contract'
import { CommandsContext } from '@session-chat/components/contexts/CommandsContext'
import { CachesContext } from '@session-chat/components/contexts/CachesContext'
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext'
import type { ChatCommands } from '@session-chat/commands'
import type { HtmlBlock } from '@session-chat/core/markdown/document'
import { render } from 'solid-js/web'
import type { JSX } from 'solid-js'

// createContractHost/nextPaint 是 contract.tsx 私有,这里按原文复刻(同文件 225-243 行)
function simHost(width: number): HTMLDivElement {
  const host = document.createElement('div')
  host.dataset.contractHost = ''
  host.style.width = `${width}px`
  host.style.position = 'relative'
  return host
}
async function simNextPaint(): Promise<void> {
  await document.fonts.ready
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

// 自己的挂载(renderAndMeasureBlock 不带 CommandsContext;这里要真点击,必须挂上)
async function mountHtmlAndInspect(
  block: HtmlBlock,
  commands: ChatCommands,
  inspect: (host: HTMLElement) => void
): Promise<void> {
  const ctx = SIM_CTX
  const measured = htmlBlockDef.measure(block, ctx)
  const host = simHost(ctx.width)
  document.body.appendChild(host)
  let dispose: (() => void) | undefined
  try {
    const Comp = htmlBlockDef.Render as (props: { node: typeof measured }) => JSX.Element
    dispose = render(
      () => (
        <ThemeContext.Provider value={() => ctx.theme}>
          <CachesContext.Provider value={ctx.caches}>
            <CommandsContext.Provider value={() => commands}>
              <Comp node={measured} />
            </CommandsContext.Provider>
          </CachesContext.Provider>
        </ThemeContext.Provider>
      ),
      host
    )
    await simNextPaint()
    inspect(host)
  } finally {
    dispose?.()
    document.body.removeChild(host)
  }
}

// ── 桌面侧路由的判定规则:与 store 同一份(workspace-path.ts 导出)──
// 三行组合方式与 open-file-in-file-editor.ts 的 resolveEditorFilePath 一致;规则本身
// (绝对/盘符、工作区内)全部来自共享实现,这里不复刻。
function resolveEditorFilePathSim(workspacePath: string, filePath: string): string | null {
  const resolvedPath = resolveWorkspacePath(workspacePath, filePath)
  if (isAbsolutePath(filePath) && !isPathInsideWorkspace(workspacePath, resolvedPath)) {
    return null
  }
  return resolvedPath
}

const WS_ROOT = '/Users/mac1/Documents/linkproj' // mac 有项目腿的真实 workspace(实测读数参照)
const HOME = '/Users/mac1' // openPath 的 home jail 边界

function predictOutcome(href: string): string {
  const cls = classifyFileLink(href)
  if (cls.kind === 'external') {
    if (/^https?:/i.test(href)) return 'external→默认浏览器打开(实测 mac/win ✅)'
    if (/^file:/i.test(href)) return 'external→Chromium 拒本地导航,静默(实测 ❌)'
    return 'external→默认导航'
  }
  if (cls.kind === 'group-file') return 'group-file→onOpenGroupFile,在它的群里打开(摩擦单 F10)'
  // `~/` 先展开成家目录绝对路径(语义与主进程同一份),❌ 不当工作区相对路径拼接
  const path = cls.path.startsWith('~/') ? `${HOME}/${cls.path.slice(2)}` : cls.path
  const resolved = resolveEditorFilePathSim(WS_ROOT, path)
  if (resolved === null) {
    // 工作区外 → statExternalFile 先问存在性,再由 attachmentOpenTarget 定去留
    const target = attachmentOpenTarget(path.replace(/\\/g, '/'))
    const inHome = isPathInsideWorkspace(HOME, path.replace(/\\/g, '/'))
    if (target === 'system') {
      return inHome
        ? '工作区外·二进制→openPath=系统默认程序打开文件本身(不是文件夹)'
        : '工作区外·二进制→openPath 在 home 外被 jail 拒→toast openFileFailed'
    }
    return inHome
      ? '工作区外·非二进制→stat:缺失 toast / 目录 Finder / 存在开 external 页签'
      : '工作区外·非二进制→stat:缺失 toast / 目录 Finder / 存在开 external 页签(home 外读取以真机为准)'
  }
  const kind = getFileKind(resolved)
  if (kind === 'binary') return '工作区内·binary→查看面板「不支持的文件格式」占位页签(不交给系统、不开文件夹)'
  return `工作区内·${kind}→查看面板对应渲染器(${kind === 'text' ? 'monaco 文本' : kind})(缺文件→toast Could not find;目录→Finder/Explorer)`
}

type Row = { id: string; md: string }

const MATRIX: Row[] = [
  // 显式 markdown 链接(能成为锚点的形态)
  { id: 'rel-md-exists', md: '[rel a.md](linktest/a.md)' },
  { id: 'rel-md-missing', md: '[rel missing](linktest/missing.md)' },
  { id: 'rel-folder', md: '[rel folder](linktest/folder)' },
  { id: 'rel-zip', md: '[rel blob.zip](linktest/blob.zip)' },
  { id: 'rel-blob', md: '[rel data.blob](linktest/data.blob)' },
  { id: 'rel-noext', md: '[rel plainfile](linktest/plainfile)' },
  { id: 'rel-png', md: '[rel shot.png](linktest/shot.png)' },
  { id: 'posix-abs-file', md: '[posix b.md](/Users/mac1/gugu-linktest-home/b.md)' },
  { id: 'posix-abs-folder', md: '[posix folder](/Users/mac1/gugu-linktest-home/folder)' },
  { id: 'posix-abs-zip', md: '[posix blob.zip](/Users/mac1/gugu-linktest-home/blob.zip)' },
  { id: 'win-bs-file', md: '[win b.md](C:\\Users\\Jeffry\\gugu-linktest\\b.md)' },
  {
    id: 'win-bs-file-space',
    md: String.raw`[pelican.html](C:\Users\Jeffry\AppData\Roaming\咕咕 Beta\task-home\pelican.html)`,
  },
  {
    // #5902:agent 写 Windows 链接常用的 URL 拼法 —— `<…>` 目的地 + 前导斜杠 + 盘符。
    // 前导斜杠不属于路径,分类时必须还原成盘符路径,否则点了什么都不会发生。
    id: 'win-url-style-drive',
    md: String.raw`[鹈鹕 SVG](</C:/Users/Jeffry/AppData/Roaming/咕咕 Beta/task-home/pelican.svg>)`,
  },
  { id: 'win-bs-folder', md: '[win folder](C:\\Users\\Jeffry\\gugu-linktest\\folder)' },
  { id: 'win-fs-file', md: '[win b.md fwd](C:/Users/Jeffry/gugu-linktest/b.md)' },
  { id: 'win-dot-escape', md: '[win dot](C:\\Users\\Jeffry\\.hidden\\a.md)' },
  { id: 'tilde-file', md: '[tilde b.md](~/gugu-linktest/b.md)' },
  { id: 'file-url', md: '[file url](file:///Users/mac1/gugu-linktest-home/b.md)' },
  { id: 'https', md: '[http ctrl](https://example.com)' },
  { id: 'rel-dotdot-escape', md: '[escape](../outside/a.md)' },
  // 裸文本(没有 [label](target) 语法)— 是否根本不渲染为锚点?
  { id: 'bare-posix', md: 'see /Users/mac1/gugu-linktest-home/b.md for details' },
  { id: 'bare-win', md: 'see C:\\Users\\Jeffry\\gugu-linktest\\b.md for details' },
  { id: 'bare-rel', md: 'see linktest/a.md for details' },
  { id: 'autolink-angle', md: 'see <https://example.com> and </Users/mac1/x.md>' },
  { id: 'inline-code', md: 'run `linktest/a.md` to see' },
  { id: 'bare-url', md: 'see https://example.com/x for details' },
]

const SIM_CTX = makeContractCtx({ width: 640 })

describe('link-sim', () => {
  it('renders the full path matrix through the real parser/renderer and clicks real anchors', async () => {
    const opened: Array<{ path: string; source: string; itemId: string }> = []
    const commands: ChatCommands = {
      classifyLink: (href: string) => classifyFileLink(href),
      onOpenFile: (arg: { path: string; source: string; itemId: string }) => {
        opened.push({ path: arg.path, source: arg.source, itemId: arg.itemId })
      },
    }

    const table: Array<Record<string, string | number>> = []
    let clicked = 0

    for (const row of MATRIX) {
      const blocks = parseMarkdownToBlocks('sim', row.md)
      // 收集这行里带 href 的锚点:parser 出口(块里的 html)与渲染出口(DOM)
      const htmlBlock = blocks.find((b): b is HtmlBlock => b.kind === 'html')
      const parsed = document.createElement('div')
      parsed.innerHTML = htmlBlock?.html ?? ''
      const hrefsFromParser = [...parsed.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '')
      let anchorHrefs: string[] = []
      let domAnchors = 0
      if (htmlBlock) {
        await mountHtmlAndInspect(htmlBlock, commands, (host) => {
          const anchors = [...host.querySelectorAll('a[href]')]
          domAnchors = anchors.length
          anchorHrefs = anchors.map((a) => a.getAttribute('href') ?? '')
          // 只点分类为 workspace-file 的锚点(external 的默认导航留给真机实测;https 点击
          // 在无头浏览器里开新页签会干扰 harness)。点击本身是 sim 的阳控:证明
          // parser→锚点→块的 onClick→commands().onOpenFile 整条链在这张桌上是通的。
          for (const a of anchors) {
            const href = a.getAttribute('href') ?? ''
            if (classifyFileLink(href).kind === 'workspace-file') {
              (a as HTMLAnchorElement).click()
              clicked++
            }
          }
        })
      }
      const href = anchorHrefs[0] ?? hrefsFromParser[0] ?? ''
      table.push({
        id: row.id,
        anchors: domAnchors,
        hrefAfterParse: href || '(none)',
        classification: href ? classifyFileLink(href).kind : '(not a link)',
        predicted: href ? predictOutcome(href) : '不渲染为锚点 → 无从点起',
      })
    }

    console.log('LINK-SIM-TABLE ' + JSON.stringify({ clicked, opened: opened.length, table }))

    // ── 判据自证(双向控)──
    // 阳控:真点击至少命中一个 workspace-file,且走的是 prose-link 源
    expect(opened.length).toBeGreaterThan(0)
    expect(opened[0].source).toBe('prose-link')
    // 裸文件路径/行内代码:根本不是锚点(bare-url 除外:GFM 会把裸 https 自动链化)
    const byId = new Map(table.map((r) => [r.id, r]))
    for (const id of ['bare-posix', 'bare-win', 'bare-rel', 'inline-code']) {
      expect(byId.get(id)?.anchors, `${id} should not be an anchor`).toBe(0)
    }
    expect(byId.get('bare-url')?.anchors, 'bare https IS autolinked by gfm').toBe(1)
    // C:\ 盘符:渲染成锚点,分类必须是 workspace-file —— 修前被单字母 scheme 正则吞成
    // external,默认导航又被 Electron 拦下,链接静默死掉(主 bug 细胞,此为 B 面)。
    for (const id of ['win-bs-file', 'win-bs-file-space', 'win-fs-file']) {
      const row = table.find((r) => r.id === id)
      expect(row?.anchors, `${id} should be an anchor`).toBe(1)
      expect(row?.classification, `${id} must classify as a file path`).toBe('workspace-file')
    }
    // href 经 remark-rehype 百分号编码(与 React 面同一条出口);点开的路径必须还原出空格与中文
    expect(opened.map((o) => o.path)).toContainEqual(expect.stringContaining('咕咕 Beta'))
  })

  it('hands a prose link\'s place to onOpenFile: `path#k=v&…` opens the path, the place beside it', async () => {
    const opened: Array<{ path: string; at?: Record<string, string> }> = []
    const commands: ChatCommands = {
      classifyLink: (href: string) => classifyFileLink(href),
      onOpenFile: (arg) => {
        opened.push({ path: arg.path, ...(arg.at ? { at: arg.at } : {}) })
      },
    }
    const md = '[Paper · p.4](论文/Paper.pdf#page=4&h=dc61c666d06d) and [a.ts](src/a.ts#L10) and [issue](notes/issue#12.md)'
    const htmlBlock = parseMarkdownToBlocks('sim', md).find((b): b is HtmlBlock => b.kind === 'html')!
    await mountHtmlAndInspect(htmlBlock, commands, (host) => {
      for (const a of host.querySelectorAll('a[href]')) (a as HTMLAnchorElement).click()
    })
    expect(opened).toEqual([
      { path: '论文/Paper.pdf', at: { page: '4', h: 'dc61c666d06d' } },
      { path: 'src/a.ts', at: { L10: '' } },
      { path: 'notes/issue#12.md' },
    ])
  })
})
