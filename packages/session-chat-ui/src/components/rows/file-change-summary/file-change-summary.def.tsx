/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js'
import { defineUnit } from '@session-chat/core/units'
import type { MeasureCtx } from '@session-chat/core/define'
import { useCommands } from '@session-chat/components/contexts/CommandsContext'
import { IconChevronDown, IconDocument, IconImage } from '@session-chat/components/primitives/icons'
import { useChatTranslator } from '@session-chat/localization'
import { basename } from '@session-chat/lib/path'
import type { FileChangeSummaryItem } from '@session-chat/model'
import { openedOutputLook } from '@session-chat/state/opened-outputs'
import { accentOf, OPENED_OUTPUT_ROW_H, outputControlWidth, OutputRowEnd } from '../opened-output/opened-output.def'
import { chevron, detail, nameRow, text, tile } from '../opened-output/opened-output.css'
import { readableLabel, rowTranslator } from '../readable-label'
import * as css from './file-change-summary.css'

/**
 * 一轮改完之后的「已编辑」卡(owner 11-06 选的方案 A):每个文件就是一行附件卡(opened-output)的样子 ——
 * 类型色图标格、文件名、「已编辑 · +3 −0 · …/所在两层」、行尾 ›;**整行**是一个按钮,点了在对话旁边打开那个文件
 * (宿主的 `onOpenFile`,和输出卡、文件链接走同一个打开动作)。完整路径在悬停提示里;卡上只给最后两层文件夹。
 *
 * ❌ 卡里不铺逐行改动。对话里的这张卡只列文件和增删数,改动去右侧看(点文件在旁边打开)—— 把每个文件的 `+edited` `+two` 摊在对话里,一轮改十个文件就是一整屏 diff(owner 10-17)。
 *
 * 一个文件:就是那一行,没有标题,也没有展开 / 收起。多个文件:顶上一行「已编辑 3 个文件 +54 −19」,点它展开 / 收起清单(默认收起)。
 */
const HEAD = 52
const BORDER = 2
const isSingle = (item: FileChangeSummaryItem) => item.files.length === 1
type File = FileChangeSummaryItem['files'][number]

/** The folder a file sits in, as its last two levels: 「…/task-home/notes」; the whole path is the row's tooltip. */
export function lastTwoFolders(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean).slice(0, -1)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/')
}
type Counts = { adds: number | null; dels: number | null }
const hasStats = (counts: Counts) => counts.adds !== null && counts.dels !== null
const statsText = (counts: Counts) => (hasStats(counts) ? `+${counts.adds} −${counts.dels}` : '')
/** The head: 「已编辑 3 个文件」, its totals and its ⌄ (16) inside the row's padding 12 + 12 and gaps 12 + 12. */
function headLayout(item: FileChangeSummaryItem, ctx: MeasureCtx) {
  const stats = statsText(item) ? readableLabel(statsText(item), ctx).width + 12 : 0
  const label = readableLabel(rowTranslator(ctx)('transcript.editedFiles', { count: item.files.length }), ctx, ctx.width - BORDER - 24 - 12 - 16 - stats, 14, 20, 500)
  return { label, rowHeight: Math.max(HEAD, label.height + 32) }
}
/** Tile 40, the gaps around the text 12 + 12, the row's end, the row's padding 12 + 12. */
const textWidth = (file: File, ctx: MeasureCtx) => ctx.width - BORDER - 24 - 40 - 24 - outputControlWidth({ kind: 'file', path: file.path }, ctx, !!ctx.commands?.onOpenFile)
/** Name, then 「已编辑 · +3 −0 · …/a/b」: both wrap where they must (never hidden), the row grows with them. */
function fileLayout(file: File, ctx: MeasureCtx) {
  const name = readableLabel(basename(file.path), ctx, textWidth(file, ctx), 14, 20, 500)
  const detailText = [rowTranslator(ctx)('transcript.edited'), statsText(file), lastTwoFolders(file.path)].filter(Boolean).join(' · ')
  const description = readableLabel(detailText, ctx, textWidth(file, ctx), 12, 18)
  return { name, description, rowHeight: Math.max(OPENED_OUTPUT_ROW_H, name.height + description.height + 24) }
}
function height(item: FileChangeSummaryItem, ctx: MeasureCtx): number {
  const rows = isSingle(item) || ctx.expanded(item.id) ? item.files.reduce((sum, file) => sum + fileLayout(file, ctx).rowHeight, 0) : 0
  return BORDER + (isSingle(item) ? 0 : headLayout(item, ctx).rowHeight) + rows
}
/** The measured detail with its breaks, the counts in the diff colours. */
function Detail(props: { text: string; counts: Counts }) {
  const parts = () => {
    const add = `+${props.counts.adds}`, del = `−${props.counts.dels}`
    const a = hasStats(props.counts) ? props.text.indexOf(add) : -1
    const d = a < 0 ? -1 : props.text.indexOf(del, a + add.length)
    return d < 0 ? null : { before: props.text.slice(0, a), between: props.text.slice(a + add.length, d), after: props.text.slice(d + del.length), add, del }
  }
  return (
    <Show when={parts()} fallback={props.text}>
      {(p) => <>{p().before}<span class={css.adds}>{p().add}</span>{p().between}<span class={css.dels}>{p().del}</span>{p().after}</>}
    </Show>
  )
}

export const fileChangeSummaryUnitDef = defineUnit<FileChangeSummaryItem, Record<string, never>>({
  kind: 'file-change-summary',
  margin: { top: 8, bottom: 8 },
  vars: {},
  measure: (item, ctx) => height(item, ctx),
  Render(props) {
    const t = useChatTranslator()
    const commands = useCommands()
    const single = () => isSingle(props.data)
    const open = () => single() || props.ctx.viewState.isCollapsed(props.data.id)
    return (
      <div data-slot="file-change-summary" data-turn-id={props.data.turnId} class={css.card}>
        <Show when={!single()}>
          <button
            type="button"
            class={css.head}
            style={{ height: `${headLayout(props.data, props.ctx.measureCtx!()).rowHeight}px` }}
            data-collapse-id={props.data.id}
            aria-expanded={open()}
            aria-label={t(open() ? 'transcript.collapseFiles' : 'transcript.expandFiles')}
          >
            <span class={css.headLabel}>{headLayout(props.data, props.ctx.measureCtx!()).label.text}</span>
            <span class={css.stats}><Detail text={statsText(props.data)} counts={props.data} /></span>
            <span class={`${chevron} ${css.turn}`} data-open={open() ? '' : undefined}><IconChevronDown /></span>
          </button>
        </Show>
        <Show when={open()}>
          <For each={props.data.files}>
            {(file) => {
              const look = () => openedOutputLook({ kind: 'file', path: file.path })
              const openFile = () => commands().onOpenFile?.({ path: file.path, itemId: file.diffs[0].id, source: 'diff' })
              return (
                <div
                  class={css.file}
                  style={{ height: `${fileLayout(file, props.ctx.measureCtx!()).rowHeight}px` }}
                  title={file.path}
                  role={commands().onOpenFile ? 'button' : undefined}
                  tabIndex={commands().onOpenFile ? 0 : undefined}
                  aria-disabled={commands().onOpenFile ? undefined : true}
                  onClick={openFile}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault()
                      openFile()
                    }
                  }}
                >
                  <span class={tile} style={{ color: accentOf(look()), background: `color-mix(in srgb, ${accentOf(look())} 12%, transparent)` }}>
                    <Show when={look().kind === 'image'} fallback={<IconDocument />}><IconImage /></Show>
                  </span>
                  <span class={text}>
                    <span class={nameRow}>{fileLayout(file, props.ctx.measureCtx!()).name.text}</span>
                    <span class={detail}><Detail text={fileLayout(file, props.ctx.measureCtx!()).description.text} counts={file} /></span>
                  </span>
                  <OutputRowEnd output={{ kind: 'file', path: file.path }} itemId={file.diffs[0].id} name={look().name} canOpen={!!commands().onOpenFile} />
                </div>
              )
            }}
          </For>
        </Show>
      </div>
    )
  }
})
