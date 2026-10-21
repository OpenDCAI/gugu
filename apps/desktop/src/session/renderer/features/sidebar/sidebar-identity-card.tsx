import { PreviewCard as PreviewCardPrimitive } from '@base-ui/react/preview-card';
import { Check, Copy } from '@/lib/icons';
import { makeAutoObservable } from 'mobx';
import { observer } from 'mobx-react-lite';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { sessionAgentNames } from '@renderer/features/sessions/stores/session-agent-names';
import { getPortalContainer } from '@renderer/lib/portal-container';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';

/**
 * 侧栏会话行的**身份卡**(#6092,取代 #5818 的「标题就地翻成 agent 名」)。
 *
 * 行上只写得下标题;指针停在行上,行右侧弹出一张卡回答「这一行是谁」:**任务名、agent 名**两行,
 * **整行点一下就复制这一行**。#7334 起卡上不再摆会话 ID 与 agent ID —— 平时拿名字的人用不上两串 ID,
 * 摆着只是多一层要读的东西;要会话 ID 的人主动去拿(行的右键「复制会话 ID」)。
 * 复制出去的是**带标签的这一对**(「任务名：X」「Agent 名：Y」)—— 单个值离开了标签,粘到哪都读不出它是什么
 * (owner 2026-10-16)。两行各复制各的,❌ 合成一次复制(owner 同日:「复制任务名就是复制任务名」)。
 *
 * 形状(assistant-ui design.md 的浮层与行规):
 *  · 浮层是**举起来的物件**:圆角 --radius-surface(10px)+ **一层 lift 影,没有环也没有边**。
 *    ⚠️ 2026-09-22 裁决(Refs #6104):原配方在这一行写的是「+ 一圈 ring-foreground/10」,而下一行
 *    自己就写着「❌ 边框、ring、影三样叠在一条边上」—— 自述与配方互相打脸,代码照着配方写了环。
 *    design.md:「Do not stack a border, a ring, and a shadow on one edge.」浮起来这件事由 lift
 *    一个人说完。底色走仓里 popover 同一格 background-quaternary。
 *  · 行之间**没有分隔线**:行靠节奏与 hover 底(row-hover)呼吸。
 *  · 标签与值都是正文字(sans),标签 muted;卡上没有标识符,所以没有 mono。
 *  · 复制图标只在行 hover 时露出;复制成功就地换成 ✓ + 「已复制」,1.6s 后收回,❌ 飞到角上的 toast。
 *  · 单一点缀色:没有。卡上没有任何一处是「活的」,所以没有蓝。
 *
 * 开合:
 *  · **只认指针**。指针在行上停够 OPEN_DELAY_MS 才开(扫过一列行时不闪);键盘焦点、选中态都不开 ——
 *    与行尾那两枚钮同一条纪律(#5818:点一行就成了键盘光标,认它等于选中的行常驻一张卡)。
 *  · 已经有一张卡开着时,指针换到另一行**立即**换卡(warm swap),不再重等一遍。
 *  · **点击不是悬浮**:在行上按下 = 收卡(连同还没到点的倒计时),并且指针离开这一行之前不再开。
 *    原来点击不碰卡,指针停在被点的行上倒计时照跑 —— 进行后 400ms 内点的,卡在点完之后弹出来;
 *    停够了才点的,卡点完还挂着 —— 同一个点击时弹时不弹(owner 2026-09-24:「点击这个动作没必要触发悬浮」)。
 *  · 收:指针离开就收,不等(owner 2026-10-08:「应该是立即消失,而不是过一会儿才消失」)。
 *    行与卡在命中上**贴着**(卡左侧那 8px 间隙是卡自己的透明边),所以「走进卡里」就是离开行的那一下
 *    直接落进卡 —— 判 pointerleave 的去向(`staysOnCard`)就够,❌ 安全三角、❌ 宽限计时器。
 *    点外 / Esc 由 Base UI 出。
 *  · 右键菜单开了、行开始被拖了,卡当场收:那两件事都是「不在看这张卡了」。
 *
 * 值的显示与复制**同一个真源**:卡上显示的就是复制出去的那两个值。❌ 不挂原生 title:一个飘在别处的
 * 浏览器 tooltip 只会打断排版(owner 2026-09-21 实机)。
 * 没有咕咕身份的会话,agent 那一行写「未分配」且不可复制 —— ❌ 不拿标题冒充人名、❌ 把「未分配」当成一个值
 * 粘出去。
 */

const OPEN_DELAY_MS = 400;
const COPIED_MS = 1600;

/**
 * 全侧栏同一时刻只有一张卡。行自己不记「我开着」——它只问这张表「现在开的是不是我」,
 * 于是换行时旧卡关、新卡开是同一次赋值,❌ 换行那一下两张卡叠在一起。
 */
class SidebarIdentityCardStore {
  activeSessionId: string | null = null;
  /**
   * 刚被点过、指针还没离开的那一行:它的悬浮不开卡。记在全局而不是行的 ref 上 —— 点开会话会让侧栏
   * 重渲,行节点可能换掉,新节点在指针下一动就收到一次 pointerenter,ref 记的会跟着旧节点丢掉。
   * 单格:进了别的行就作废,所以滚走、卸载都不会留下一条永远不弹的行。
   */
  suppressedSessionId: string | null = null;

  constructor() {
    makeAutoObservable(this);
  }

  get isWarm(): boolean {
    return this.activeSessionId !== null;
  }

  open(sessionId: string): void {
    this.activeSessionId = sessionId;
  }

  suppress(sessionId: string): void {
    this.suppressedSessionId = sessionId;
    this.close(sessionId);
  }

  /** 进了别的行:上一条「点过」作废。 */
  releaseOthers(sessionId: string): void {
    if (this.suppressedSessionId !== sessionId) this.suppressedSessionId = null;
  }

  release(sessionId: string): void {
    if (this.suppressedSessionId === sessionId) this.suppressedSessionId = null;
  }

  /** 只收自己那张:A 行卸载、开关被关掉或点按收卡时,开着的可能已经是 B 行的卡,❌ 把 B 的关掉。 */
  close(sessionId: string): void {
    if (this.activeSessionId === sessionId) this.activeSessionId = null;
  }
}

export const sidebarIdentityCard = new SidebarIdentityCardStore();

/**
 * 指针离开行或卡时,去的地方还算不算「在看卡」:进了卡、回到行、或者走到另一条会话行(那一行进来就换卡)。
 * 去向为 null(指针出了窗口)或别处 ⇒ 收。
 */
function staysOnCard(event: ReactPointerEvent): boolean {
  const target = event.relatedTarget;
  return target instanceof Element && target.closest('[data-sidebar-identity-card], [role="treeitem"][data-session-id]') !== null;
}

/**
 * 行侧的触发:指针停够时长才开,已有卡开着时换行即开。
 * 返回挂到行上的那几个 handler;开关状态在 store 上,行通过 `sidebarIdentityCard.activeSessionId` 读。
 */
export function useSidebarIdentityCardTrigger(sessionId: string, enabled: boolean) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancel = useCallback(() => {
    if (timer.current === null) return;
    clearTimeout(timer.current);
    timer.current = null;
  }, []);

  useEffect(() => cancel, [cancel]);
  // 设置里关掉时,开着的那张也得收 —— 开关是真的接着这一行的,不是只拦下一次。
  useEffect(() => {
    if (!enabled) sidebarIdentityCard.close(sessionId);
  }, [enabled, sessionId]);
  // 行卸载(虚拟列表滚出窗口 / 项目折叠)时也收:store 里那格 id 是全侧栏共享的,不收就悬着,
  // 行一重新挂载,卡会在指针从没碰过它的情况下自己弹出来。
  useEffect(() => () => sidebarIdentityCard.close(sessionId), [sessionId]);

  const onPointerEnter = useCallback(
    (event: React.PointerEvent) => {
      if (!enabled || event.pointerType === 'touch') return;
      cancel();
      if (sidebarIdentityCard.suppressedSessionId === sessionId) return;
      sidebarIdentityCard.releaseOthers(sessionId);
      if (sidebarIdentityCard.isWarm) {
        sidebarIdentityCard.open(sessionId);
        return;
      }
      timer.current = setTimeout(() => {
        timer.current = null;
        sidebarIdentityCard.open(sessionId);
      }, OPEN_DELAY_MS);
    },
    [enabled, sessionId, cancel]
  );

  // 离开:没开的倒计时作废;开着的卡,除非指针正落进卡里(或换到别的会话行),当场收。
  // 离开也是「点过」的终点:下一次进来才算重新悬浮。
  const onPointerLeave = useCallback(
    (event: ReactPointerEvent) => {
      cancel();
      sidebarIdentityCard.release(sessionId);
      if (!staysOnCard(event)) sidebarIdentityCard.close(sessionId);
    },
    [cancel, sessionId]
  );
  // 按下(鼠标任一键、笔)= 在操作这一行,不是在看它是谁。
  const onPointerDown = useCallback(
    (event: React.PointerEvent) => {
      if (event.pointerType === 'touch') return;
      cancel();
      sidebarIdentityCard.suppress(sessionId);
    },
    [cancel, sessionId]
  );
  const dismiss = useCallback(() => {
    cancel();
    sidebarIdentityCard.close(sessionId);
  }, [cancel, sessionId]);

  return { onPointerEnter, onPointerLeave, onPointerDown, dismiss };
}

type RowSpec = {
  key: 'sessionName' | 'agentName';
  label: string;
  /** null = 这一格没有(agent 未分配):写「未分配」且不可复制。 */
  value: string | null;
};

export const SidebarIdentityCard = observer(function SidebarIdentityCard({
  sessionId,
  title,
  anchor,
  onDismiss,
}: {
  sessionId: string;
  title: string;
  /** 取行本体。传取值函数:虚拟列表重渲染会换掉行节点,拿着旧节点定位是对着脱离文档的元素算坐标。 */
  anchor: () => Element | null;
  onDismiss: () => void;
}) {
  const { translate } = useSessionMessages();
  const identity = sessionAgentNames.identityFor(sessionId);

  const rows: RowSpec[] = [
    { key: 'sessionName', label: translate('identityCard.sessionName'), value: title },
    { key: 'agentName', label: translate('identityCard.agentName'), value: identity?.displayName ?? null },
  ];

  return (
    <PreviewCardPrimitive.Root
      open
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <PreviewCardPrimitive.Portal container={getPortalContainer()}>
        <PreviewCardPrimitive.Positioner
          anchor={anchor}
          side="right"
          align="start"
          collisionPadding={8}
          className="isolate z-50"
        >
          {/* 贴着行开(sideOffset 0),看得见的 8px 间隙是 Popup 朝行那一侧的透明边 —— 它算卡,
              所以指针从行走进卡,中间没有一个「两边都不是」的像素。 */}
          <PreviewCardPrimitive.Popup
            data-sidebar-identity-card
            data-session-id={sessionId}
            role="dialog"
            aria-label={translate('identityCard.dialog', { name: title })}
            onPointerLeave={(event) => {
              if (!staysOnCard(event)) onDismiss();
            }}
            className={cn(
              'z-50 origin-(--transform-origin) outline-hidden data-[side=right]:pl-2 data-[side=left]:pr-2',
              'duration-[var(--dur-fast)] data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 data-[side=right]:slide-in-from-left-2 data-[side=left]:slide-in-from-right-2 motion-reduce:animate-none motion-reduce:transition-none'
            )}
          >
            {/* 宽度跟内容走,封顶 16rem:短名字不再拖着一大截空白(owner 2026-10-16 实看:「占的留白太多了」)。 */}
            <div className="flex w-max max-w-64 flex-col overflow-hidden rounded-surface bg-background-quaternary py-1 text-sm text-foreground shadow-lift">
              {rows.map((row) => (
                <IdentityRow key={row.key} row={row} />
              ))}
            </div>
          </PreviewCardPrimitive.Popup>
        </PreviewCardPrimitive.Positioner>
      </PreviewCardPrimitive.Portal>
    </PreviewCardPrimitive.Root>
  );
});

function IdentityRow({ row }: { row: RowSpec }) {
  const { translate } = useSessionMessages();
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    []
  );

  const flash = (next: 'copied' | 'failed') => {
    setState(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), COPIED_MS);
  };

  const copy = async () => {
    if (row.value === null) return;
    try {
      // 带上标签:「任务名：X」。分隔符取文案(中文全角「：」,英文「: 」),拼接在这里做 ——
      // ❌ 把会话标题当插值参数塞进文案模板:标题是用户写的任意文字。
      await navigator.clipboard.writeText(`${row.label}${translate('identityCard.copyKeySeparator')}${row.value}`);
      flash('copied');
    } catch {
      // 复制失败也要就地说:值仍在行上,用户可以自己选 —— ❌ 静默。
      flash('failed');
    }
  };

  // 标签与值同一个字号(owner 2026-09-21:「文字大小不统一」)。标签栏同宽,两行的值左缘对齐;
  // 宽度放得下最长的「Agent 名」即可 —— 原先按「Session ID」留的 5rem,那一行已经没了。
  const labelClass = 'w-16 shrink-0 whitespace-nowrap text-left text-sm leading-5 text-foreground-muted';
  const valueClass = cn('min-w-0 truncate text-left text-sm leading-5', row.value === null && 'text-foreground-passive');

  if (row.value === null) {
    return (
      <div data-identity-row={row.key} className="flex items-center gap-2 px-3 py-1">
        <span className={labelClass}>{row.label}</span>
        <span className={valueClass}>{translate('identityCard.unassigned')}</span>
      </div>
    );
  }

  return (
    <button
      type="button"
      data-identity-row={row.key}
      data-copy-state={state}
      aria-label={translate('identityCard.copy', { label: row.label })}
      onClick={(event) => {
        // 行本身是会话的点击目标;这里的点击只是复制,❌ 顺带把会话打开或把卡关掉。
        event.stopPropagation();
        void copy();
      }}
      className="group/identity-row flex w-full cursor-pointer items-center gap-2 px-3 py-1 text-left transition-colors duration-[var(--dur-fast)] hover:bg-row-hover active:bg-row-press focus-visible:bg-row-hover"
    >
      <span className={labelClass}>{row.label}</span>
      {/* 图标**紧跟在值后面**,不推到卡的右缘 —— 短值与图标之间不留一截空白;图标只在指着的那一行出现,
          两行图标不对齐也看不出来。反馈就地替换值:值与反馈叠在同一格,值只是藏起来仍占着宽,
          所以点完卡不变窄、图标不挪位。 */}
      <span className="grid min-w-0 grid-cols-1">
        <span className={cn(valueClass, 'col-start-1 row-start-1', state !== 'idle' && 'invisible')}>{row.value}</span>
        <span aria-live="polite" className={cn(valueClass, 'col-start-1 row-start-1 text-foreground-muted')}>
          {state === 'copied'
            ? translate('identityCard.copied')
            : state === 'failed'
              ? translate('identityCard.copyFailed')
              : null}
        </span>
      </span>
      <span
        className={cn(
          'flex size-4 shrink-0 items-center justify-center text-foreground-muted transition-opacity duration-[var(--dur-fast)]',
          state === 'idle' && 'opacity-0 group-hover/identity-row:opacity-100 group-focus-visible/identity-row:opacity-100'
        )}
      >
        {state === 'copied' ? <Check className="size-3" /> : <Copy className="size-3" />}
      </span>
    </button>
  );
}
