import { FilePlus2, FileText, Globe, Link2, ListChecks } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import { useQuery } from '@tanstack/react-query';
import { useContext, useEffect, useRef, useState } from 'react';
import { PageShownContext } from '@renderer/app/recent-session-pages';
import { findAcpChatStore } from '@renderer/features/sessions/acp/acp-chat-resource-manager';
import { rpc, rpcOn } from '@renderer/lib/ipc';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { log } from '@renderer/utils/logger';
import { Button } from '@renderer/lib/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/lib/ui/popover';
import { Separator } from '@renderer/lib/ui/separator';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { basenameFromAnyPath } from '@shared/path-name';
import { fileUrlToMachinePath } from '@shared/preview/remote-page-url';
import type { OpenedOutput } from '@gugu/session-chat-ui/opened-outputs';
import {
  collectSubagents,
  SessionSubagentsSection,
  useProgressTick,
} from './session-subagents-section';
import {
  collectBackgroundCommands,
  SessionBackgroundCommandsSection,
} from './session-background-commands-section';
import { dismissSubagent } from './subagent-dismissals';
import { useWorkspaceViewModel } from '../session-view-context';
import {
  INITIAL_OUTPUTS_PANEL,
  isOutputsPanelOpen,
  outputsPanelEventFor,
  reduceOutputsPanel,
  type OutputsPanelEvent,
} from './outputs-panel-state';

/**
 * @@@sessionpage layout — 输出/来源 panel (spec session-page 会话页): chat
 * header entry opening a popover with two sections — 输出 (files/sites the
 * agent opened for the person with `open_in_tab`, clickable to reopen after the
 * tab is closed) and 来源 (links referenced in the transcript, extracted from
 * message text; capped list with 查看全部 expansion).
 */

const VISIBLE_SOURCES = 4;
const URL_RE = /https?:\/\/[^\s)>"'\]]+/g;

/** 文件与本机网页写文件名;网址写去掉协议的全址(与来源一节同一个写法)。 */
function outputLabel(output: OpenedOutput): string {
  if (output.kind === 'file') return basenameFromAnyPath(output.path);
  const filePath = fileUrlToMachinePath(output.url);
  return filePath ? basenameFromAnyPath(filePath) : output.url.replace(/^https?:\/\//, '');
}

/**
 * Must run inside a mobx `observer`: the store is read imperatively, so the
 * one mobx dependency (`messageCount`) is read explicitly. Session-page stores live in
 * `AcpChatResourceManager`.
 */
function collectSources(sessionId: string | undefined): string[] {
  if (!sessionId) return [];
  const store = findAcpChatStore(sessionId);
  if (!store) return [];
  void store.messageCount;
  const urls: string[] = [];
  const seen = new Set<string>();
  for (const turn of store.chatState.transcript.state.committedTurns) {
    for (const item of turn.items) {
      if (item.kind !== 'message') continue;
      for (const match of item.text.matchAll(URL_RE)) {
        const url = match[0].replace(/[.,;:!?]+$/, '');
        if (seen.has(url)) continue;
        seen.add(url);
        urls.push(url);
      }
    }
  }
  return urls;
}

/**
 * 「输出」读会话所在那台机器上的那一份记录(宿主 `session-outputs.ts`),❌ 这台桌面自己记:那样重启、换一台电脑、
 * 没人看着时攒下的都对不上。面板开着时页签每变一次读一次 —— agent 打开东西,这一页就多一个页签。
 */
function useSessionOutputs(sessionId: string | undefined, open: boolean, tabCount: number) {
  return useQuery({
    queryKey: ['session-outputs', sessionId, tabCount],
    enabled: open && !!sessionId,
    retry: false,
    queryFn: async () => {
      const result = await rpcOn(machineRegistry.machineOf(sessionId!))
        .sessionTimeline.sessionOutputs({ conversationId: sessionId! })
        .catch((error: unknown) => ({ ok: false as const, error: String(error) }));
      if (result.ok) return result.value;
      log.warn('[outputs] reading the session outputs failed', { sessionId, error: result.error });
      throw new Error('session outputs unreadable');
    },
  });
}

export const SessionOutputsPopover = observer(function SessionOutputsPopover({
  sessionId,
}: {
  sessionId: string | undefined;
}) {
  const { translate } = useSessionMessages();
  const [showAll, setShowAll] = useState(false);
  // Recomputed per render; the popover content only mounts while open.
  const sources = collectSources(sessionId);
  const visible = showAll ? sources : sources.slice(0, VISIBLE_SOURCES);
  const viewModel = useWorkspaceViewModel();
  const panel = viewModel.outputsPanel;
  const stored = sessionId ? panel.stateOf(sessionId) : INITIAL_OUTPUTS_PANEL;
  /**
   * 这一页藏着(@@@retained-session-pages:切走的任务页留着、只是藏起来)⇒ 面板不画。
   * 页是靠 `visibility:hidden` 藏的,面板却 portal 到页外的浮层层上,藏不住;而它又会因为这条任务起了
   * 后台命令 / 子智能体自己弹出来 —— 于是别的任务的输出面板盖在眼前这页上(#7067)。
   * 开合状态照记不误:切回来时还该开着就还开着。
   */
  const pageShown = useContext(PageShownContext);
  // 心跳只是重绘信号:进度算在条目自己的 `startedAt` 上,漏几拍只会慢一拍、不会错位。
  // 只在面板开着时跑 —— 面板关着,屏上没有一个跟着时间走的数。从前只要有会话就跑:每条开着的会话每秒
  // 重排、重绘一次整页,还把整份转录扫一遍(上面的 collectSources)。
  const now = useProgressTick(pageShown && isOutputsPanelOpen(stored));
  const subagents = collectSubagents(
    sessionId,
    translate('transcript.subagent'),
    now
  );
  // 主智能体自己起的后台命令 —— 它不挂住这一轮,轮收口了还在跑(#5117)。
  const backgroundCommands = collectBackgroundCommands(
    sessionId,
    translate('task.backgroundCommand')
  );
  const store = sessionId ? findAcpChatStore(sessionId) : undefined;

  /**
   * 开还是收:规则全在 `outputs-panel-state.ts`(#6572),这里只负责把「此刻屏上在跑的」和人的动作报过去。
   *
   * 派出去一个新的子智能体 / 起了一条后台命令,面板自己弹出来(owner 2026-09-06:「创建智能体之后我发现你得
   * 手动点,其实你可以让他这个输出卡片自动弹」;后台命令更需要:它不挂住这一轮,不弹一下的话「有东西还在跑」
   * 在屏幕上根本没有出现过,#5117)。屏上还有在跑的就常驻,在跑的一条不剩,自己弹出来的面板就自己收。
   */
  // 屏上在跑的 = 两个 collect 的结果(已按过 × 的已经滤掉)。
  // 没有 ACP store 时是「不知道」,❌ 当成「空」报上去 —— 那会把自动弹出的面板误收。
  const running = store ? [...backgroundCommands, ...subagents].map((entry) => entry.id) : null;
  const runningKey = running ? JSON.stringify(running) : null;
  // 这一帧就按「此刻在跑的」算,❌ 等下面的 effect 写回之后再算:切回来时命令已经全部结束的那一格,
  // 否则会先亮一帧再收。
  const current = running ? reduceOutputsPanel(stored, { type: 'running', ids: running }) : stored;
  useEffect(() => {
    if (!sessionId || runningKey === null) return;
    panel.dispatch(sessionId, { type: 'running', ids: JSON.parse(runningKey) as string[] });
  }, [panel, sessionId, runningKey]);
  const act = (event: OutputsPanelEvent): void => {
    if (!sessionId) return;
    // 人看到的是 `current`,动作要落在它上面 ⇒ 先按此刻在跑的对齐一次。
    if (running) panel.dispatch(sessionId, { type: 'running', ids: running });
    panel.dispatch(sessionId, event);
  };
  /**
   * 只有人点 Outputs 打开时焦点才进面板。自己弹出来、切回来重新出现 ⇒ ❌ 动焦点:Base UI 默认把焦点挪到
   * 面板里第一个可聚焦的东西 —— 第一张卡的「停止」键 —— 正在输入框 / 终端里打字的人下一下回车就把命令停了。
   */
  const focusOnOpen = useRef(false);
  const panelOpen = pageShown && isOutputsPanelOpen(current);
  const tabCount = viewModel.paneLayout.groups.reduce((count, group) => count + group.pane.resolvedTabs.length, 0);
  const outputs = useSessionOutputs(sessionId, panelOpen, tabCount);

  return (
    <Popover
      open={panelOpen}
      onOpenChange={(nextOpen, details) => {
        // 规则见 outputsPanelEventFor。「这次 Esc 是不是发自面板里」看这次按键自己的来路(composedPath)。
        const event = outputsPanelEventFor(nextOpen, details.reason, {
          fromPanel:
            details.reason === 'escape-key'
            && details.event
              .composedPath()
              .some((node) => node instanceof Element && node.hasAttribute('data-outputs-panel')),
          state: current,
        });
        if (!event) {
          // 不收,也别让 Base UI 照旧处理这次按键:它对 Esc 默认 preventDefault + stopPropagation,
          // 面板常驻之后那就是终端 / 输入框里的 Esc 被它截走。
          details.cancel();
          details.allowPropagation();
          return;
        }
        if (event.type === 'open') focusOnOpen.current = true;
        act(event);
      }}
    >
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={!sessionId}
            aria-label={translate('task.outputsAndSources')}
          />
        }
      >
        {/* 尺寸由消息栏动作组容器规定,见 index.css 的 @@@titlebar-action-icons。 */}
        <ListChecks />
      </PopoverTrigger>
      {/* owner 2026-09-06:「这个面板有点太宽了」。先前为「别把子智能体的名字挤没」
          放宽到 w-96,放过头了 —— 名字那一行是 flex-1 truncate,窄一档照样读得全,
          真正挤名字的是把时长/模型写死成不可压缩的宽度,那已经用 shrink-0 收住了。 */}
      <PopoverContent
        align="end"
        className="flex w-80 flex-col gap-1 p-2"
        data-outputs-panel=""
        initialFocus={() => {
          const focus = focusOnOpen.current;
          focusOnOpen.current = false;
          return focus;
        }}
      >
        <div className="px-2 pt-1 text-xs font-medium text-foreground-muted">
          {translate('task.outputs')}
        </div>
        {outputs.isError ? (
          <div className="px-2 py-1 text-sm text-foreground-passive">{translate('task.outputsUnreadable')}</div>
        ) : (outputs.data ?? []).length === 0 ? (
          <div className="flex items-center gap-2 px-2 py-1 text-sm text-foreground-passive">
            <FilePlus2 className="size-3.5 shrink-0" />
            {translate('task.outputsHint')}
          </div>
        ) : (
          <div className="flex max-h-56 flex-col overflow-y-auto">
            {outputs.data?.map((output) => {
              const target = output.kind === 'file' ? output.path : output.url;
              const Icon = output.kind === 'file' ? FileText : Globe;
              return (
                <button
                  key={target}
                  type="button"
                  title={target}
                  className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-row-hover active:bg-row-press"
                  onClick={() => viewModel.reopenOutput(output)}
                >
                  <Icon className="size-3.5 shrink-0 text-foreground-muted" />
                  <span className="truncate">{outputLabel(output)}</span>
                </button>
              );
            })}
          </div>
        )}
        {backgroundCommands.length > 0 && (
          <SessionBackgroundCommandsSection
            commands={backgroundCommands}
            onDismiss={(entryId) => {
              if (!sessionId) return;
              act({ type: 'dismiss', id: entryId });
              dismissSubagent(sessionId, entryId);
            }}
            onStop={(launchToolCallId) => {
              if (!sessionId) return;
              findAcpChatStore(sessionId)?.stopSubagent(launchToolCallId);
            }}
          />
        )}
        {subagents.length > 0 && (
          <SessionSubagentsSection
            agents={subagents}
            onDismiss={(entryId) => {
              // conversationId 在这儿必非空:`subagents` 只有拿到它才收得出东西。
              if (!sessionId) return;
              act({ type: 'dismiss', id: entryId });
              dismissSubagent(sessionId, entryId);
            }}
            onStop={(launchToolCallId) => {
              if (!sessionId) return;
              findAcpChatStore(sessionId)?.stopSubagent(launchToolCallId);
            }}
          />
        )}
        {/* 弹层自己的环(PopoverContent)是最外那条规则,里面最多再留一条分隔线 ——
            design.md:「Never nest rules three levels deep.」这一条把「输出」(含后台命令
            /子智能体)与「来源」分开,不为两节内部再各画一条。 */}
        <Separator className="my-1" />
        <div className="px-2 text-xs font-medium text-foreground-muted">
          {translate('task.sources')}
        </div>
        {visible.length === 0 && (
          <div className="px-2 py-1 text-sm text-foreground-passive">
            {translate('task.sourcesEmpty')}
          </div>
        )}
        <div className="flex max-h-56 flex-col overflow-y-auto">
          {visible.map((url) => (
            <button
              key={url}
              type="button"
              className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-row-hover active:bg-row-press"
              onClick={() => void rpc.app.openExternal(url)}
            >
              <Link2 className="size-3.5 shrink-0 text-foreground-muted" />
              {/* 来源 URL 走 mono(design.md,2026-09-22 补上)。 */}
              <span className="truncate font-mono">{url.replace(/^https?:\/\//, '')}</span>
            </button>
          ))}
        </div>
        {!showAll && sources.length > VISIBLE_SOURCES && (
          <button
            type="button"
            className="rounded-md px-2 py-1 text-left text-sm text-foreground-muted hover:bg-row-hover active:bg-row-press"
            onClick={() => setShowAll(true)}
          >
            {translate('task.viewAll', { count: sources.length })}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
});
