/** @jsxImportSource solid-js */
/**
 * opened-output —— agent 打开给人看的一份文件 / 网页,挂在这一轮最后那条回复下面的附件卡(#7193)。
 *
 * owner 2026-10-15:「用 open_in_tab 打开的文件或网页……做成类似于附件的形式」,样子是一张文件卡:
 * 图标格、文件名、「Document · PDF」一行、右边「Open」。点整张卡重新打开,
 * 与对话顶部「输出」里点那一条是同一个动作(宿主的 `onOpenOutput`)。宿主没接这个口子就只是一张看的卡,
 * ❌ 摆一枚点了没反应的「打开」。
 *
 * 哪些调用算产出、挂在哪一轮、同一份只挂一张:`state/opened-outputs.ts`(手机会话页读同一份)。
 */
import type { MeasureCtx } from '@session-chat/core/define';
import { readableLabel, rowTranslator } from '../readable-label';
import { useCommands } from '@session-chat/components/contexts/CommandsContext';
import { IconChevronDown, IconChevronRight, IconDocument, IconGlobe, IconImage } from '@session-chat/components/primitives/icons';
import { defineUnit } from '@session-chat/core/units';
import { useChatTranslator } from '@session-chat/localization';
import type { OpenedOutputItem } from '@session-chat/model';
import { openedOutputLook } from '@session-chat/state/opened-outputs';
import { Match, Show, Switch } from 'solid-js';
import { vars } from '@session-chat/styles/theme.css';
import { card, cardClickable, chevron, detail, modeButton, modeLabel, nameRow, slot, text, tile } from './opened-output.css';

/** 一行高(px,含下边那条线)。⚠️ 改它要同时核 `opened-output.css.ts` 里的格子都还装得下。 */
export const OPENED_OUTPUT_ROW_H = 72;
/** 一组卡与上面回复、下面内容之间各一档。 */
export const OPENED_OUTPUT_GAP = 8;

/**
 * 类型色:一眼分出是什么(Codex 的 PDF 红、Slack / 微信文件的类型色块同一个意思)。只用主题里已有的几格色,
 * 底是同色 12% 叠在卡底上。
 */
function accentOf(look: ReturnType<typeof openedOutputLook>): string {
  if (look.kind === 'page') return vars.link;
  if (look.kind === 'image') return vars.diffAdded;
  if (look.extension === 'PDF' || look.extension === 'PPT' || look.extension === 'PPTX') return vars.fgError;
  if (look.extension === 'HTML' || look.extension === 'HTM') return vars.fgPermission;
  return vars.fgMuted;
}

/**
 * 名字拆成「可省略的主干」和「留着的尾巴」:文件留扩展名连同它前面两个字(「…截图.png」),
 * 窄的时候省略落在中间。网页地址没有这层意思,整串从尾巴省略。
 */
export function splitOutputName(name: string, isFile: boolean): { stem: string; tail: string } {
  const dot = isFile ? name.lastIndexOf('.') : -1;
  if (dot <= 0) return { stem: name, tail: '' };
  const keep = dot - 2;
  // 名字本来就短(「周报.md」):不拆,❌ 拆出一个空主干在前面空一截。
  if (keep <= 0) return { stem: name, tail: '' };
  return { stem: name.slice(0, keep), tail: name.slice(keep) };
}

function outputLayout(data: OpenedOutputItem, ctx: MeasureCtx) {
  const t = rowTranslator(ctx), look = openedOutputLook(data.output), commands = ctx.commands;
  const kind = t(look.kind === 'page' ? 'transcript.outputPage' : look.kind === 'image' ? 'transcript.outputImage' : 'transcript.outputDocument');
  const reason = commands?.outputUnavailable?.(data.output);
  const open = !reason && commands?.onOpenOutput;
  const mode = open && commands?.onOutputMenu ? commands.outputOpenMode?.(data.output) : null;
  const control = mode ? ctx.width - 26 <= 260 ? 26 : readableLabel(mode, ctx, ctx.width, 14, 20).width + 32 : open ? 16 : 0;
  const width = ctx.width - 26 - 40 - 12 - (control ? control + 12 : 0);
  const ext = look.extension;
  const format = ext === 'PPTX' || ext === 'PPT' ? 'PowerPoint' : ext === 'DOCX' || ext === 'DOC' ? 'Word' : ext === 'XLSX' || ext === 'XLS' ? 'Excel' : null;
  const detail = reason ? `${kind} · ${reason}` : look.kind === 'page' ? t('transcript.outputWebsite') : format ?? (ext ? `${kind} · ${ext}` : kind);
  const name = readableLabel(look.kind === 'page' ? t('transcript.outputWebPreview') : look.name, ctx, width, 14, 20, 500);
  const description = readableLabel(detail, ctx, width, 12, 18);
  return { name, description, rowHeight: Math.max(OPENED_OUTPUT_ROW_H, name.height + description.height + 24) };
}

export const openedOutputUnitDef = defineUnit<OpenedOutputItem, { rowH: number; gap: number }>({
  kind: 'opened-output',
  // 一组卡连成一块,行与行之间不留缝;与上下的间距算在组首 / 组末那一行自己里面(`slot` 的上下留白)。
  margin: { top: 0, bottom: 0 },
  vars: { rowH: OPENED_OUTPUT_ROW_H, gap: OPENED_OUTPUT_GAP },

  measure(data, ctx, vars_) {
    return outputLayout(data, ctx).rowHeight + (data.index === 0 ? vars_.gap : 0) + (data.index === data.count - 1 ? vars_.gap : 0);
  },

  Render(props) {
    const translate = useChatTranslator();
    const layout = () => outputLayout(props.data, props.ctx.measureCtx!());
    const commands = useCommands();
    // 行按下标复用:读 props 一律在 accessor 里,❌ 一次性取出来。
    const look = () => openedOutputLook(props.data.output);
    const unavailable = () => commands().outputUnavailable?.(props.data.output) ?? null;
    const open = () => (unavailable() ? undefined : commands().onOpenOutput);
    const handleClick = () => open()?.({ output: props.data.output, itemId: props.data.id });
    // 「侧边栏 ▾」:宿主说得出默认怎么打开、也接了菜单才摆;打不开的那行不摆。
    const mode = () => (open() && commands().onOutputMenu ? commands().outputOpenMode?.(props.data.output) ?? null : null);

    const first = () => props.data.index === 0;
    const last = () => props.data.index === props.data.count - 1;

    return (
      <div
        class={slot}
        style={{
          height: `${layout().rowHeight + (first() ? props.vars.gap : 0) + (last() ? props.vars.gap : 0)}px`,
          'padding-top': `${first() ? props.vars.gap : 0}px`,
          'padding-bottom': `${last() ? props.vars.gap : 0}px`,
        }}
      >
      <div
        data-slot="opened-output"
        data-output-kind={look().kind}
        class={open() ? cardClickable : card}
        data-first={first() ? '' : undefined}
        data-last={last() ? '' : undefined}
        role={open() ? 'button' : undefined}
        tabIndex={open() ? 0 : undefined}
        aria-label={open() ? translate('transcript.outputOpenLabel', { name: look().name }) : undefined}
        title={props.data.output.kind === 'file' ? props.data.output.path : props.data.output.url}
        onClick={() => handleClick()}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleClick();
          }
        }}
      >
        <span
          class={tile}
          style={{ color: accentOf(look()), background: `color-mix(in srgb, ${accentOf(look())} 12%, transparent)` }}
        >
          <Switch fallback={<IconDocument />}>
            <Match when={look().kind === 'page'}>
              <IconGlobe />
            </Match>
            <Match when={look().kind === 'image'}>
              <IconImage />
            </Match>
          </Switch>
        </span>
        <span class={text}>
          <span data-slot="opened-output-name" class={nameRow}>{layout().name.text}</span>
          <span data-slot="opened-output-detail" class={detail}>{layout().description.text}</span>
        </span>
        <Show
          when={mode()}
          fallback={
            <Show when={open()}>
              <span data-slot="opened-output-open" class={chevron} aria-hidden="true">
                <IconChevronRight />
              </span>
            </Show>
          }
        >
          {(label) => (
            <button
              type="button"
              data-slot="opened-output-mode"
              class={modeButton}
              aria-haspopup="menu"
              aria-label={translate('transcript.outputOpenWith', { name: look().name })}
              onClick={(event) => {
                // 只弹菜单,❌ 再冒泡成「点整行」按默认方式打开。
                event.stopPropagation();
                commands().onOutputMenu?.({ output: props.data.output, itemId: props.data.id, anchor: event.currentTarget });
              }}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <span class={modeLabel}>{label()}</span>
              <IconChevronDown />
            </button>
          )}
        </Show>
      </div>
      </div>
    );
  },
});
