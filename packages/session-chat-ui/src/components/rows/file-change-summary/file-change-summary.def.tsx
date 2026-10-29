/** @jsxImportSource solid-js */
import { For, Show } from 'solid-js'
import { defineUnit } from '@session-chat/core/units'
import type { MeasureCtx } from '@session-chat/core/define'
import { useCommands } from '@session-chat/components/contexts/CommandsContext'
import { GenericFileIcon, IconChevronDown } from '@session-chat/components/primitives/icons'
import { useChatTranslator } from '@session-chat/localization'
import { basename } from '@session-chat/lib/path'
import type { FileChangeSummaryItem } from '@session-chat/model'
import * as css from './file-change-summary.css'

/**
 * 一轮改完之后的「已编辑 N 个文件」卡:标题 + 总增删,下面是文件清单(每行完整路径 + 增删),点一行在对话旁边打开那个文件。
 *
 * ❌ 卡里不铺逐行改动。对话里的这张卡只列文件和增删数,改动去右侧看(点文件在旁边打开)—— 把每个文件的 `+edited` `+two` 摊在对话里,一轮改十个文件就是一整屏 diff(owner 10-17)。
 *
 * 一个文件:清单就是那一行,直接显示,没有展开 / 收起。多个文件:默认收起,标题右侧展开,清单底下收起。
 */
const HEADER = 72
const ROW = 32
const FOOTER = 32
const BORDER = 2
const isSingle = (item: FileChangeSummaryItem) => item.files.length === 1
function height(item: FileChangeSummaryItem, ctx: MeasureCtx): number {
  if (isSingle(item)) return BORDER + HEADER + ROW
  return BORDER + HEADER + (ctx.expanded(item.id) ? item.files.length * ROW + FOOTER : 0)
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
    const files = () => single() || props.ctx.viewState.isCollapsed(props.data.id)
    const totals = () => ({ adds: props.data.adds, dels: props.data.dels })
    const label = () =>
      props.data.files.length === 1
        ? t('transcript.editedFile', { name: basename(props.data.files[0].path) })
        : t('transcript.editedFiles', { count: props.data.files.length })
    return (
      <div data-slot="file-change-summary" data-turn-id={props.data.turnId} class={css.card}>
        <div class={css.header} style={{ height: `${HEADER}px` }}>
          <span class={css.tile}>
            <GenericFileIcon />
          </span>
          <div class={css.title}>
            <div class={css.ellipsis} title={label()}>
              {label()}
            </div>
            <Show when={totals().adds !== null && totals().dels !== null}><div class={css.stats}>
              <span class={css.adds}>+{totals().adds}</span>
              <span class={css.dels}>−{totals().dels}</span>
            </div></Show>
          </div>
          <Show when={!single() && !files()}>
            <button
              type="button"
              class={css.button}
              data-collapse-id={props.data.id}
              aria-expanded={false}
              aria-label={t('transcript.expandFiles')}
            >
              <IconChevronDown />
            </button>
          </Show>
        </div>
        <Show when={files()}>
          <For each={props.data.files}>
            {(file) => (
                <div class={css.row} style={{ height: `${ROW}px` }}>
                  <button
                    type="button"
                    class={css.path}
                    title={file.path}
                    disabled={!commands().onOpenFile}
                    onClick={() =>
                      commands().onOpenFile?.({
                        path: file.path,
                        itemId: file.diffs[0].id,
                        source: 'diff'
                      })
                    }
                  >
                    {file.path}
                  </button>
                  <Show when={file.adds !== null && file.dels !== null}><span class={css.stats}>
                    <span class={css.adds}>+{file.adds}</span>
                    <span class={css.dels}>−{file.dels}</span>
                  </span></Show>
                </div>
            )}
          </For>
          <Show when={!single()}>
            <div class={css.footer} style={{ height: `${FOOTER}px` }}>
              <button type="button" class={css.button} data-collapse-id={props.data.id}>
                {t('transcript.collapseFiles')}
              </button>
            </div>
          </Show>
        </Show>
      </div>
    )
  }
})
