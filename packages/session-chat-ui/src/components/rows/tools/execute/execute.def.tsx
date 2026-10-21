/** @jsxImportSource solid-js */
import { ROW_H } from '@session-chat/components/engine/row-metrics';
import { CollapseHeader } from '@session-chat/components/primitives/CollapseHeader';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import { defineUnit } from '@session-chat/core/units';
import { pxTokens } from '@session-chat/styles/px-tokens';
import { assignInlineVars } from '@vanilla-extract/dynamic';
import { Show, createMemo } from 'solid-js';
import type { ChatExecute } from '@session-chat/model';
import { ExecuteBody } from './Execute';
import { ToolPayloadPanel } from '../tool/Tool';
import { toolPayloadFor } from '../tool/tool.def';
import { hasToolPayload } from '../tool/tool.layout';
import {
  executeCardVars,
  executeCommandChip,
  executeExitStatus,
  executeExitStatusFailed,
  executeRoot,
  type ExecuteStyleVars,
} from './execute.css';
import { useChatTranslator } from '@session-chat/localization';
import {
  EXECUTE_SCROLLBAR_GUTTER_X,
  createExecuteLines,
  executeBodyGeometry,
  executeCommandChipText,
  executeHidesContent,
  layoutExecuteLines,
} from './execute.layout';

export { executeFromItem } from './execute.presenter';

export type ExecuteVars = {
  /** Fixed height (px) of the header row. */
  rowH: number;
  /** Max lines shown in the collapsed (preview) state. */
  collapsedMaxLines: number;
  /** Max lines shown / scrollable in the expanded state. */
  expandedMaxLines: number;
};

/**
 * ⚠️ `collapsedMaxLines: 0` —— 折叠档 body 一行不出(#4981)。
 *
 * 原来是 2:表头写着干巴巴一句「执行」,底下再摊开两行 bash 高亮的原始命令,整行满宽。
 * owner 的原话是「一些 CLI 的参数(比如 shell 的参数)特别裸露地暴露出来了」,指的正是
 * 这个形状 —— 它和 agent 自己说的话一样重、一样宽,读者一眼扫过去分不清哪句是人话。
 *
 * 现在命令挪进表头那颗片里(见 `executeCommandChip`),一行、等宽、淡底、超长省略号收尾,
 * 和 `搜索 req.session` 是同一颗片。**信息一个字没少**:完整命令连同输出都在 `›` 里,
 * 而且片本身就显示命令,不是把它藏起来。
 */
const EXECUTE_VARS: ExecuteVars = {
  rowH: ROW_H,
  collapsedMaxLines: 0,
  expandedMaxLines: 16,
};

/**
 * Width a command line actually gets to fill, and therefore the width its wrap is
 * measured against. Since #3419 removed the card there is no border and no inset
 * left to subtract — the body spans the row — so the reserved scrollbar gutter is
 * the whole difference. It is subtracted in both states because the gutter is
 * reserved in both (see execute.css).
 */
function executeContentWidth(ctx: MeasureCtx): number {
  return Math.max(1, ctx.width - EXECUTE_SCROLLBAR_GUTTER_X);
}

function executeUnitH(item: ChatExecute, ctx: MeasureCtx, vars: ExecuteVars): number {
  const isExpanded = ctx.expanded(item.id);
  const lines = layoutExecuteLines(item, executeContentWidth(ctx), ctx.theme.fonts);
  const { bodyH } = executeBodyGeometry(
    lines,
    ctx.theme.fonts.code.lineHeight,
    isExpanded,
    vars.collapsedMaxLines,
    vars.expandedMaxLines,
  );
  return vars.rowH + bodyH + (toolPayloadFor(item, ctx)?.panelH ?? 0);
}

/**
 * How the command ended, as one short phrase — or nothing at all.
 *
 * Nothing is the honest answer whenever the exit is not known: the command is
 * still running, the agent ran its own shell instead of asking the client for a
 * terminal, or the process ended in a way that carried neither a code nor a
 * signal. An absent reading is never dressed up as a clean exit; a row that
 * claims "exit 0" for a command nobody watched is worse than a row that says
 * nothing, because the reader would have no way to tell the two apart.
 */
function exitStatusPhrase(
  item: ChatExecute,
  translate: ReturnType<typeof useChatTranslator>
): { text: string; failed: boolean } | null {
  const status = item.exitStatus;
  if (!status) return null;
  // Signal first, and not merely as a fallback: a process killed by a signal can
  // still carry a zero code, and reporting that as "exit 0" would print the word
  // for success in the failure colour while the thing that actually killed it
  // goes unmentioned. What ended the process is the more specific fact.
  if (status.signal !== null) {
    return { text: translate('transcript.exitSignal', { signal: status.signal }), failed: true };
  }
  if (status.exitCode !== null) {
    return {
      text: translate('transcript.exitCode', { code: status.exitCode }),
      failed: status.exitCode !== 0,
    };
  }
  return null;
}

function ExecuteUnitRender(props: { data: ChatExecute; ctx: RenderCtx; vars: ExecuteVars }) {
  const translate = useChatTranslator();
  const mCtx = () => props.ctx.measureCtx?.();
  // Inverted semantics: stored "collapsed" bool = "expanded".
  const isExpanded = () => props.ctx.viewState.isCollapsed(props.data.id);

  const lines = createMemo(() => {
    const ctx = mCtx();
    if (!ctx) return createExecuteLines(props.data);
    return layoutExecuteLines(props.data, executeContentWidth(ctx), ctx.theme.fonts);
  });
  const codeLineH = createMemo(() => mCtx()?.theme.fonts.code.lineHeight ?? 0);
  const payload = createMemo(() => {
    const ctx = mCtx();
    return ctx ? toolPayloadFor(props.data, ctx) : null;
  });

  const bodyGeometry = createMemo(() => {
    const lineH = codeLineH();
    if (!lineH) return { bodyH: 0, contentH: 0 };
    return executeBodyGeometry(
      lines(),
      lineH,
      isExpanded(),
      props.vars.collapsedMaxLines,
      props.vars.expandedMaxLines,
    );
  });

  // Derived from the same memo the body renders from, not from a second call to
  // executeUnitH: two independent computations of the same height are exactly the
  // desync `executeRoot { overflow: hidden }` exists to survive.
  const totalH = createMemo(() => {
    if (!mCtx()) return props.vars.rowH;
    return props.vars.rowH + bodyGeometry().bodyH + (payload()?.panelH ?? 0);
  });

  // Either the terminal body or the shared payload can make disclosure useful.
  const collapsible = createMemo(() =>
    executeHidesContent(lines(), codeLineH(), props.vars.collapsedMaxLines) || hasToolPayload(props.data),
  );

  const styleVars = (): ExecuteStyleVars => ({ height: totalH() });

  return (
    <div class={executeRoot} style={assignInlineVars(executeCardVars, pxTokens(styleVars()))}>
      <CollapseHeader
        id={props.data.id}
        collapsible={collapsible()}
        expanded={isExpanded()}
        active={props.data.status === 'running' && !props.data.awaitingPermission}
        error={props.data.status === 'error'}
        errorTitle={props.data.error}
        awaitingPermission={props.data.awaitingPermission}
        height={props.vars.rowH}
        trailing={
          <>
            {/* 片走 trailing 而不是 children:children 是**一个** flex item,片塞进去会跟着
                标签一起换行,而表头是固定高度且 clip —— 换下去的那半行就永远看不见了
                (CollapseHeader 的 trailing 注释里记着 320px 实测)。 */}
            <Show when={executeCommandChipText(props.data)}>
              {(command) => (
                <span class={executeCommandChip} data-slot="tool-call-query" title={command()}>
                  {command()}
                </span>
              )}
            </Show>
            <Show when={exitStatusPhrase(props.data, translate)}>
            {(phrase) => (
              <span
                data-slot="execute-exit-status"
                class={executeExitStatus}
                classList={{ [executeExitStatusFailed]: phrase().failed }}
              >
                {phrase().text}
              </span>
            )}
            </Show>
          </>
        }
      >
        {props.data.inputSummary || translate('transcript.execute')}
      </CollapseHeader>
      <Show when={codeLineH() > 0}>
        <ExecuteBody
          lines={lines()}
          bodyH={bodyGeometry().bodyH}
          contentH={bodyGeometry().contentH}
          codeLineH={codeLineH()}
          expanded={isExpanded()}
        />
      </Show>
      <Show when={payload()}>
        {(value) => <ToolPayloadPanel payload={value()} codeLineH={codeLineH()} />}
      </Show>
    </div>
  );
}

export const executeUnitDef = defineUnit<ChatExecute, ExecuteVars>({
  kind: 'execute',
  margin: { top: 2, bottom: 6 },
  vars: EXECUTE_VARS,

  estimate(item, _ctx, vars): number {
    // O(1) cheap estimate: use collapsedMaxLines cap (default state). No width is
    // available here, so this counts source lines, not wrapped visual lines — the
    // estimate is a placeholder the virtualizer replaces with measure().
    const lines = createExecuteLines(item);
    // Approximate code line height — use a fixed fallback of 20px for estimate.
    const approxLineH = 20;
    const { bodyH } = executeBodyGeometry(
      lines,
      approxLineH,
      false,
      vars.collapsedMaxLines,
      vars.expandedMaxLines,
    );
    return vars.rowH + bodyH;
  },

  measure(item, ctx, vars): number {
    return executeUnitH(item, ctx, vars);
  },

  Render: ExecuteUnitRender,
});
