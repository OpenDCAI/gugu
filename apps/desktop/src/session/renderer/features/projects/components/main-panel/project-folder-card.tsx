import { observer } from 'mobx-react-lite';
import { useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from 'react';
import { Check, Monitor, Plus, Server } from '@/lib/icons';
import type { ProjectFolder } from '@shared/core/projects/project-folders';
import { basenameFromAnyPath, shortHome } from '@shared/path-name';
import { senderAvatarUrl, subscribeSenderAvatars } from '@renderer/lib/chat/sender-avatar';
import { sidebarStore } from '@renderer/lib/stores/app-state';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { Button } from '@renderer/lib/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@renderer/lib/ui/dropdown-menu';
import { cn } from '@renderer/utils/utils';
import type { ProjectFoldersState, ShownFolder } from './project-folders';
import { ProjectFolderMenu } from './project-folder-menu';
import { ProjectCover } from './project-folder-cover';
import './project-folder-card.css';

/**
 * 项目首页的文件夹卡(product spec「项目首页」,owner 2026-10-17 从三个方向里选 B,#7341)。
 *
 * 卡片露出最近用的几个文件夹(像从文件夹里探出来的纸);点卡片摊开全部;点其中一张 = 新会话从那儿开工;
 * 「+」或把文件夹拖上来 = 挂文件夹。封面颜色按项目 id 固定,有 agent 在跑时更鲜、没人在跑褪成灰。
 */

/**
 * 卡片几何(px)。后片右上有个耳朵,前片左边高一截。W 是满宽:窄栏里卡片跟着这一栏收窄(`useColumnWidth`),❌ 定宽撑出边框。
 * 最窄 MIN_W:前片左边那截高出来的(LW)加上过渡弯得画得下。
 */
const MIN_W = 220;
const G = { W: 440, H: 276, backH: 226, frontH: 136, TW: 132, TH: 22, LW: 168, S: 18, paperW: 236, paperH: 64, peek: 66 };
/** 收起时探出来的三页:角度、横向错位。 */
const STACK = [
  [-4, -12],
  [-1, 0],
  [3, 11],
] as const;

/** 后片四边往里收 k:与前片重合的边不再并排抗锯齿出色边。 */
function backPath(W: number, H: number, TW: number, TH: number, k = 1.5) {
  return `M${k} ${TH + 14} Q${k} ${TH} ${14 + k} ${TH} L${W - TW - 20} ${TH} C${W - TW - 7} ${TH} ${W - TW - 5} 0 ${W - TW + 8} 0 L${W - 12 - k} 0 Q${W - k} 0 ${W - k} 12 L${W - k} ${H - 16} Q${W - k} ${H - k} ${W - 16} ${H - k} L16 ${H - k} Q${k} ${H - k} ${k} ${H - 16} Z`;
}
function frontPath(W: number, H: number, LW: number, S: number) {
  return `M0 12 Q0 0 12 0 L${LW - 10} 0 C${LW + 3} 0 ${LW + 5} ${S} ${LW + 19} ${S} L${W - 12} ${S} Q${W} ${S} ${W} ${S + 12} L${W} ${H - 12} Q${W} ${H} ${W - 12} ${H} L12 ${H} Q0 ${H} 0 ${H - 12} Z`;
}
/**
 * 前片形状用 mask 统一裁切磨砂纹理、高光与正文,包括右上台阶和圆角。
 */
function maskStyle(d: string, w: number, h: number): CSSProperties {
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'><path d='${d}'/></svg>`;
  const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  return {
    WebkitMaskImage: url,
    maskImage: url,
    WebkitMaskSize: '100% 100%',
    maskSize: '100% 100%',
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
  };
}

/**
 * Frost is a cached image of this folder's cover and the peeking papers. Live backdrop-filter
 * caused long GPU raster flushes on first interaction in Electron, even with a Backdrop Root.
 * The two static images stay rasterized; opening only fades the paper image out.
 */
function FrostedFront({ projectId, running, count, uid, W, paperW }: { projectId: string; running: number; count: number; uid: string; W: number; paperW: number }) {
  const top = G.H - G.frontH;
  const paperTop = G.H - G.frontH - G.peek;
  const peeking = Math.min(count, 3);
  return <>
    <svg className="gg-folder-card__cover-frost" width={W} height={G.frontH} viewBox={`0 ${G.backH - G.frontH} ${W} ${G.frontH}`} aria-hidden>
      <g className="gg-folder-card__cover"><ProjectCover projectId={projectId} running={running} width={W} height={G.backH} uid={`${uid}-frost`} saturationBoost={1.5} /></g>
    </svg>
    <svg className="gg-folder-card__paper-frost" width={W} height={G.frontH} viewBox={`0 ${top} ${W} ${G.frontH}`} aria-hidden>
      <defs><radialGradient id={`fc-paper-frost-${uid}`}>
        <stop offset="0" stopColor="var(--card)" stopOpacity={0.95} />
        <stop offset="50%" stopColor="var(--card)" stopOpacity={0.7} />
        <stop offset="100%" stopColor="var(--card)" stopOpacity={0} />
      </radialGradient></defs>
      <g>
        {Array.from({ length: peeking }, (_, index) => {
          const k = peeking === 1 ? 1 : 2 - index;
          const [rot, tx] = STACK[k];
          const x = (W - paperW) / 2 + tx;
          const y = paperTop + k * 9;
          return <g key={index} transform={`rotate(${rot} ${x + paperW / 2} ${y + G.paperH / 2})`}>
            <ellipse cx={x + paperW / 2} cy={y + G.paperH - 2} rx={paperW / 2 + 24} ry={44} fill={`url(#fc-paper-frost-${uid})`} />
          </g>;
        })}
      </g>
    </svg>
  </>;
}

function useAvatarTick() {
  const [, tick] = useReducer((n: number) => n + 1, 0);
  useEffect(() => subscribeSenderAvatars(tick), []);
}

function reducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

export { shortHome };

const FRESH_MS = 2 * 60 * 1000;

/**
 * 摊开 = 一手牌(owner 2026-10-27,参考扑克牌的握法;HTML 样稿逐版定下来的数)。
 *
 * - 所有纸绕同一个握点(纸下方)转开,右边的压左边的;文件夹名在每张左上角 —— 转开后每张恰好露出那一角。
 * - 一行最多 FAN_ROW_MAX 张,张数平均分到各行(20 个宽栏 = 4 行 × 5);放不下就往后再握一行,最多 FAN_MAX_ROWS 行。
 *   后一行只抬出名字那一截,与前一行错开半张。
 * - 选中的那张排在前一行最右:没有任何纸压它。❌ 按 DOM 先后叠(会把它压在最左最底下看不见)。
 * - 每张带一点按文件夹固定的随手偏差,❌ 排成格子;同一个文件夹每次摊开都在同一处。
 * - 栏越宽纸越大、名字间距越宽,走一条缓出曲线(❌ 线性后封顶,宽栏四周空着);卡片本身限宽(G.W)。
 */
export const FAN_ROW_MAX = 6;
export const FAN_MAX_ROWS = 5;
const FAN_MAX_ANGLE = (48 * Math.PI) / 180;
const FAN_ROW_RISE = 30;

/** 栏宽 → 0..1 的缓出量:420 起长,1200 到顶。 */
export function fanEase(column: number): number {
  const t = Math.min(1, Math.max(0, (column - 420) / (1200 - 420)));
  return 1 - Math.pow(1 - t, 1.6);
}

function jitter(key: string, salt: string, amplitude: number): number {
  let h = 2166136261;
  const s = `${key}:${salt}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (((h >>> 0) % 1000) / 1000 - 0.5) * 2 * amplitude;
}

export type FanSlot = { x: number; y: number; rot: number; z: number; row: number };

/**
 * 第 slot 张(展示顺序:0 = 前一行最右,即选中的那张)在扇面里的位置,相对纸的收起位置(中心不动时)。
 * 返回值:纸中心的平移(x、y,px)、绕纸中心的转角(rot,deg)、叠放(z)、在第几行(0 = 最前)。
 */
export function fanPlace(slot: number, count: number, opts: { column: number; paperW: number; paperH: number; key: string }): FanSlot {
  const { column, paperW, paperH, key } = opts;
  const label = 82 + 44 * fanEase(column);
  const half = FAN_MAX_ANGLE / 2;
  // 握点到纸顶的距离:扇面最外两张的外沿不出这一栏。
  const reach = Math.max(paperH + 90, Math.min(720, (column - 32 - paperW * Math.cos(half)) / (2 * Math.sin(half))));
  const fit = Math.max(3, Math.floor(Math.min(FAN_MAX_ANGLE * reach, column - 32 - paperW) / label) + 1);
  const rows = Math.min(FAN_MAX_ROWS, Math.ceil(count / Math.min(FAN_ROW_MAX, fit)));
  const per = Math.ceil(count / rows);
  const step = per === 1 ? 0 : Math.min(FAN_MAX_ANGLE / (per - 1), label / reach);
  const row = Math.floor(slot / per);
  const inRow = Math.min(per, count - row * per);
  const position = inRow - 1 - (slot - row * per); // 0 = 最左
  const angle = (position - (inRow - 1) / 2) * step + (row % 2 ? step / 2 : 0) + jitter(key, 'a', 0.02);
  // 绕握点转 = 纸中心沿圆弧走,再绕自己的中心转同一个角。
  const radius = reach - paperH / 2;
  // 两端会往下垂:整把牌抬起前一行垂量的八成,两端只有纸底一点压进卡面。
  const edge = ((Math.min(per, count) - 1) / 2) * step;
  const droop = reach * (1 - Math.cos(edge));
  const x = radius * Math.sin(angle) + jitter(key, 'x', 4);
  const y = radius * (1 - Math.cos(angle)) - droop * 0.8 - row * FAN_ROW_RISE + jitter(key, 'y', 3);
  return { x, y, rot: (angle * 180) / Math.PI, z: (rows - row) * 100 + position + 1, row };
}

/** 卡片所在这一栏有多宽(摊开的纸也不能超出它)。量到之前当它够宽。 */
function useColumnWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(Number.POSITIVE_INFINITY);
  useLayoutEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const measure = () => setWidth(node.clientWidth);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}
const bodyStyle: CSSProperties = { paddingTop: G.S + 12 };

export type FolderCardMachine = { id?: string | null; label: string; online: boolean; kind: 'server' | 'computer' };
/** 「+」菜单里的一台机器;id null = 这台电脑。 */
export type AttachMachine = FolderCardMachine & { id: string | null };

export const ProjectFolderCard = observer(function ProjectFolderCard({
  projectId,
  projectName,
  folders: state,
  memberIds = [projectId],
  machineOf,
  attachMachines,
  onAttach,
  onDropFolder,
  onAddMachine,
  floating = false,
}: {
  /** 代表这个项目的那一行(侧栏那一行)的本地项目 id。 */
  projectId: string;
  projectName: string;
  folders: ProjectFoldersState;
  /** 这个项目在各台机器上的本地项目(#7341 第二步:绑在同一个项目群上);没合并 = 只有 projectId。 */
  memberIds?: readonly string[];
  /** 某个本地项目在哪台机器上(卡面与每页纸标机器用)。 */
  machineOf: (projectId: string) => FolderCardMachine;
  /** 「+」能挂到哪几台机器上:一台就直接挑文件夹,多台先选机器。 */
  attachMachines: readonly AttachMachine[];
  onAttach: (machine: string | null) => void;
  onAddMachine?: () => void;
  /** 从 Finder 拖进来的文件夹(一个 File;取路径由调用方决定 —— 别的机器上的项目不能拿这台电脑的路径)。 */
  onDropFolder: (file: File) => void;
  /** 浮在群聊上面(项目块里开新任务,gugu-dev#181):一浮出来就摊开,提示换成「按 Esc 收起」;打字不收(owner 10-26)。 */
  floating?: boolean;
}) {
  const { translate } = useSessionMessages();
  useAvatarTick();
  const [open, setOpen] = useState(false);
  const [dragover, setDragover] = useState(false);
  const [landing, setLanding] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [columnRef, column] = useColumnWidth();
  const W = Math.max(MIN_W, Math.min(G.W, column));
  // 纸跟着栏宽长(缓出);收起时也是这一张,不随开合换尺寸(换尺寸会逐帧重排)。
  const paperW = Math.min(Math.round(150 + 86 * fanEase(column)), W - 32);
  const cardSize: CSSProperties = { width: W, height: G.H };
  const tiltFrame = useRef<number | null>(null);
  const pointer = useRef({ x: 0, y: 0 });
  useEffect(() => () => {
    if (tiltFrame.current !== null) cancelAnimationFrame(tiltFrame.current);
  }, []);
  // 浮出来就摊开:文件夹读到了才摊得开(与点卡片同一个条件)。
  const foldersRead = state.folders !== null;
  useEffect(() => {
    if (floating && foldersRead) setOpen(true);
  }, [floating, foldersRead]);
  const droppedRef = useRef<string | undefined>(undefined);
  const uid = useMemo(() => projectId.replace(/[^a-z0-9]/gi, '').slice(0, 12), [projectId]);

  // 这个项目自己的会话(各台机器上的都算;挂在别的项目会话下的子会话不算)。
  const members = new Set(memberIds);
  const sessions = [...new Map((sidebarStore.placement.entries.get(projectId) ?? [])
    .filter((entry) => members.has(entry.projectId))
    .map((entry) => [entry.sessionId, entry] as const)).values()];
  // 卡面列这个项目涉及的机器(同名去重),纸上标各自那一台;那台此刻答不上(只列着上次读到的)就标离线。
  const machinesShown = [...new Map(memberIds.map((id) => machineOf(id)).map((m) => [m.id === undefined ? m.label : m.id ?? 'local', m] as const)).values()];
  const paperMachine = (folder: ShownFolder): FolderCardMachine => {
    const m = machineOf(folder.projectId);
    return folder.offline ? { ...m, online: false } : m;
  };
  const runningIds = new Set(sessions.filter((entry) => entry.group === 'working').map((entry) => entry.sessionId));
  const running = runningIds.size;
  const agents = [...sessions]
    .sort((x, y) => Number(runningIds.has(y.sessionId)) - Number(runningIds.has(x.sessionId)) || y.time - x.time)
    .map((entry) => ({ sessionId: entry.sessionId, url: senderAvatarUrl(`session:${entry.sessionId}`), title: entry.title }))
    .filter((agent): agent is { sessionId: string; url: string; title: string } => agent.url !== null);
  const shownAgents = agents.slice(0, 6);

  const folders = state.folders ?? [];
  // 「刚挂上」只在挂上后的两分钟里算数:过后它就是一个普通的文件夹,❌ 一直挂着那个标。
  const isFresh = (folder: ProjectFolder) =>
    folder.workspaceId === state.fresh &&
    folder.attachedAt !== null &&
    Date.now() - Date.parse(folder.attachedAt) < FRESH_MS;
  // 刚挂上的排最前,然后是选中的,再是根目录和其余的(按挂上的先后)。
  const ordered = [...folders].sort((x, y) => {
    const rank = (f: ProjectFolder) =>
      isFresh(f) ? 0 : f.workspaceId === state.chosen?.workspaceId ? 1 : f.kind === 'root' ? 2 : 3;
    return rank(x) - rank(y);
  });

  // 刚挂上 = 这一页从卡片上方落进去一次。
  const dropping = state.fresh && state.fresh !== droppedRef.current ? state.fresh : undefined;
  useEffect(() => {
    if (!dropping) return;
    droppedRef.current = dropping;
    setOpen(false);
    const timer = setTimeout(() => {
      setLanding(true);
      setTimeout(() => setLanding(false), 320);
    }, 430);
    return () => clearTimeout(timer);
  }, [dropping]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const setTilt = (rx: number, ry: number, px: number, py: number) => {
    const node = cardRef.current;
    if (!node) return;
    node.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
    node.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
    node.style.setProperty('--px', px.toFixed(3));
    node.style.setProperty('--py', py.toFixed(3));
  };
  const resetTilt = () => {
    if (tiltFrame.current !== null) cancelAnimationFrame(tiltFrame.current);
    tiltFrame.current = null;
    cardRef.current?.classList.remove('is-tracking');
    setTilt(0, 0, 0, 0);
  };
  const toggleOpen = () => {
    if (state.folders === null) return;
    resetTilt();
    setOpen((value) => !value);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (open || reducedMotion()) return;
    pointer.current = { x: event.clientX, y: event.clientY };
    if (tiltFrame.current !== null) return;
    const node = event.currentTarget;
    // 高频指针事件合并到一帧；在写样式前只测量一次卡片。
    tiltFrame.current = requestAnimationFrame(() => {
      tiltFrame.current = null;
      const rect = node.getBoundingClientRect();
      const px = (pointer.current.x - rect.left) / rect.width - 0.5;
      const py = (pointer.current.y - rect.top) / rect.height - 0.5;
      node.classList.add('is-tracking');
      setTilt(-py * 6, px * 7, px, py);
    });
  };

  const onDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    if (!dragover) setDragover(true);
  };
  const onDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDragover(false);
    const file = event.dataTransfer.files[0];
    if (file) onDropFolder(file);
  };

  const backD = backPath(W, G.backH, G.TW, G.TH);
  const frontD = frontPath(W, G.frontH, G.LW, G.S);
  const frontStyle: CSSProperties = { width: W, height: G.frontH, ...maskStyle(frontD, W, G.frontH) };
  const base = G.H - G.frontH - G.peek;

  /**
   * 每一页纸的位置:收起时最相关的三页叠着探出来(其余的藏在叠底、透明),摊开时全部排成一手牌。
   * ⚠️ 两种状态下纸的 DOM 顺序一样(= ordered),前后只靠 z-index:挪动 DOM 节点会让浏览器丢掉那一页的过渡,
   * 收起时不渲染的纸摊开时是新挂上的节点、同样没有过渡 —— 实测四页里只有一页在动,其余是瞬移过去的。
   */
  type Place = { transform: string; rot: number; tx: number; ty: number; top: number; z: number; hidden: boolean };
  const chosenIndex = ordered.findIndex((folder) => folder.workspaceId === state.chosen?.workspaceId);
  const placement = (index: number, count: number): Place => {
    if (!open) {
      const peeking = Math.min(count, 3);
      const hidden = index >= 3;
      // 只有一页时摆正居中;两页、三页从中间往右叠,最相关的那页在最右、最上面。
      const k = hidden ? 0 : peeking === 1 ? 1 : 2 - index;
      const [rot, tx] = STACK[k];
      return { transform: `translate3d(${tx}px, ${k * 9}px, 0) rotate(${rot}deg)`, rot, tx, ty: k * 9, top: base, z: count - index, hidden };
    }
    const folder = ordered[index];
    const slot = index === chosenIndex ? 0 : chosenIndex >= 0 && index < chosenIndex ? index + 1 : index;
    const fan = fanPlace(slot, count, { column: Number.isFinite(column) ? column : 1200, paperW, paperH: G.paperH, key: folder.workspaceId });
    // 收起位置是纸顶在 base;摊开时前一行的纸底贴在前片上沿(留 4px)。
    const y = G.peek - G.paperH - 4 + fan.y;
    return {
      transform: `translate3d(${fan.x.toFixed(1)}px, ${y.toFixed(1)}px, 0) rotate(${fan.rot.toFixed(2)}deg)`,
      rot: fan.rot,
      tx: fan.x,
      ty: y,
      top: base,
      z: fan.z,
      hidden: false,
    };
  };
  const paperStyle = (place: Place, index: number): CSSProperties => {
    // 飞行过程中保持纸张与文字几何不变，避免逐帧重排。
    return {
      width: paperW,
      minHeight: G.paperH,
      left: (W - paperW) / 2,
      top: place.top,
      transform: place.transform,
      zIndex: place.z,
      opacity: place.hidden ? 0 : 1,
      transitionDelay: open ? `${index * 30}ms` : undefined,
      ['--rot' as string]: `${place.rot}deg`,
      ['--tx' as string]: `${place.tx}px`,
      ['--ty' as string]: `${place.ty}px`,
    };
  };

  const meta = translate('projects.folders.meta', { folders: folders.length, sessions: sessions.length });

  return (
    <div ref={columnRef} className="flex w-full min-w-0 flex-col items-center gap-3">
      <div
        ref={cardRef}
        data-testid="project-folder-card"
        className={cn('gg-folder-card', open && 'is-open', dragover && 'is-dragover', landing && 'is-landing')}
        style={cardSize}
        // 鼠标点卡片任何一处 = 摊开 / 收起;键盘走卡面上的项目名(它是一颗真按钮,带 aria-expanded)。
        onClick={toggleOpen}
        onPointerMove={onPointerMove}
        onPointerLeave={resetTilt}
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragover(false);
        }}
        onDrop={onDrop}
      >
        <div className="gg-folder-card__drop-hint">{translate('projects.folders.dropHint', { projectName })}</div>
        <div className="gg-folder-card__shadow" />
        <div className="gg-folder-card__stage" style={cardSize}>
          <svg className="gg-folder-card__back" width={W} height={G.backH} viewBox={`0 0 ${W} ${G.backH}`} aria-hidden>
            <clipPath id={`fc-back-${uid}`}>
              <path d={backD} />
            </clipPath>
            <g className="gg-folder-card__cover" clipPath={`url(#fc-back-${uid})`}>
              <ProjectCover projectId={projectId} running={running} width={W} height={G.backH} uid={uid} />
            </g>
            <path d={backD} fill="none" stroke="var(--fc-edge)" strokeWidth={0.6} />
          </svg>

          <div className="gg-folder-card__papers">
            {ordered.map((folder, index) => {
              const place = placement(index, ordered.length);
              const here = folder.sessionIds.filter((id) => runningIds.has(id)).length;
              const chosen = folder.workspaceId === state.chosen?.workspaceId;
              const fresh = isFresh(folder);
              return (
                // 位置与动画放在外面这一层:按钮原语自带一组带 !important 的过渡(120ms、只认固定几种属性),
                // 摊开 / 悬停上浮 / 落进来的动画放在按钮身上会被它压掉 —— 分层的 !important 从外面压不回来。
                <ProjectFolderMenu key={folder.workspaceId} folder={folder} projectName={projectName} state={state} disabled={!open}>
                <div
                  className={cn('gg-folder-paper-slot', folder.workspaceId === dropping && 'is-dropping')}
                  style={paperStyle(place, index)}
                  data-peek={place.hidden ? 'hidden' : 'shown'}
                  aria-hidden={place.hidden || undefined}
                >
                <Button
                  variant="ghost"
                  tabIndex={open ? 0 : -1}
                  aria-pressed={chosen}
                  title={folder.path}
                  data-testid="project-folder-paper"
                  className="gg-folder-paper"
                  onClick={(event) => {
                    // 收起时点到探出来的纸 = 点卡片(摊开);摊开后点一张 = 从这儿开工。
                    if (!open) return;
                    event.stopPropagation();
                    state.choose(folder.workspaceId);
                  }}
                >
                  {/* 名字在左上角:摊开后每张只露出这一角(像牌角的点数),❌ 让机器标签占着它 —— 那一格每张都一样。 */}
                  <span className="gg-folder-paper__top">
                    <span className="gg-folder-paper__name">{basenameFromAnyPath(folder.path) || folder.path}</span>
                    {fresh ? <span className="gg-folder-paper__fresh">{translate('projects.folders.fresh')}</span> : null}
                    <span className="gg-folder-paper__check">
                      <Check className="size-3.5" />
                    </span>
                  </span>
                  <span className="gg-folder-paper__path block">{shortHome(folder.path)}</span>
                  <span className="gg-folder-paper__where">
                    <MachineChip machine={paperMachine(folder)} />
                    {folder.branch ? <span className="gg-folder-paper__branch">{folder.branch}</span> : null}
                  <span className={cn('gg-folder-paper__meta', here > 0 && 'is-running')}>
                    {/* 有在跑的说在跑;开过但都歇着说有几个;一个没有时根目录说它是根目录 —— ❌「还没有会话在这儿跑」
                        把「歇着」说成「从没来过」。 */}
                    {here > 0
                      ? translate('projects.folders.runningHere', { count: here })
                      : folder.sessionIds.length > 0
                        ? translate('projects.folders.sessionsHere', { count: folder.sessionIds.length })
                        : folder.kind === 'root'
                          ? translate('projects.folders.root')
                          : translate('projects.folders.idleHere')}
                  </span>
                  </span>
                </Button>
                </div>
                </ProjectFolderMenu>
              );
            })}
          </div>

          <div className="gg-folder-card__front" style={frontStyle}>
            <FrostedFront projectId={projectId} running={running} count={folders.length} uid={uid} W={W} paperW={paperW} />
            <div className="gg-folder-card__body" style={bodyStyle}>
              <div className="gg-folder-card__title">
                <Button
                  variant="ghost"
                  className="gg-folder-card__toggle"
                  aria-expanded={open}
                  disabled={state.folders === null}
                  aria-label={translate('projects.folders.cardLabel', { projectName })}
                  data-testid="project-folder-card-toggle"
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleOpen();
                  }}
                >
                  <span className="gg-folder-card__name">{projectName}</span>
                </Button>
                <span className="gg-folder-card__meta">
                  {state.folders ? meta : null}
                  {running > 0 ? (
                    <>
                      {state.folders ? ' · ' : null}
                      <span className="is-running">{translate('projects.folders.running', { count: running })}</span>
                    </>
                  ) : null}
                </span>
              </div>
              {state.loadError ? (
                <div className="gg-folder-card__error">
                  {translate('projects.folders.loadFailed')}
                  <Button
                    variant="link"
                    size="xs"
                    onClick={(event) => {
                      event.stopPropagation();
                      state.reload();
                    }}
                  >
                    {translate('projects.folders.retry')}
                  </Button>
                </div>
              ) : null}
              <div className="gg-folder-card__foot">
                <div className="gg-folder-card__machines">
                  {machinesShown.map((m) => (
                    <MachineChip key={m.id === undefined ? m.label : m.id ?? 'local'} machine={m} />
                  ))}
                </div>
                <div className="gg-folder-card__agents" title={translate('projects.folders.agentTotal', { count: agents.length })}>
                  {shownAgents.map((agent) => (
                    <img key={agent.sessionId} src={agent.url} alt="" title={agent.title} />
                  ))}
                  {agents.length > shownAgents.length ? (
                    <span className="gg-folder-card__more" title={agents.slice(shownAgents.length).map((agent) => agent.title).join('\n')} aria-label={translate('projects.folders.agentMore', { count: agents.length - shownAgents.length })}>{translate('projects.folders.agentCount', { count: agents.length })}</span>
                  ) : null}
                </div>
                <AttachButton machines={attachMachines} onAttach={onAttach} onAddMachine={onAddMachine} label={translate('projects.folders.attach')} heading={translate('projects.folders.attachOn')} addLabel={translate('projects.folders.addMachine')} />
              </div>
            </div>
          </div>
          <svg className="gg-folder-card__front-edge" width={W} height={G.frontH} viewBox={`0 0 ${W} ${G.frontH}`} aria-hidden>
            <path d={frontD} fill="none" stroke="var(--fc-edge)" strokeWidth={0.8} />
            <path d={`M12 .6 L${G.LW - 10} .6`} stroke="var(--fc-hi)" strokeWidth={1} />
          </svg>
        </div>
      </div>
      {state.folders !== null || !state.loadError ? (
        <p className="gg-folder-card__hint" role={state.folders === null ? 'status' : undefined}>
          {state.folders === null
            ? translate('projects.folders.loading')
            : open
              ? translate(floating ? 'projects.folders.hintFloating' : 'projects.folders.hintOpen')
              : translate('projects.folders.hintClosed', { count: folders.length })}
        </p>
      ) : null}
    </div>
  );
});

/**
 * 「+」:能挂的只有一台机器就直接去挑文件夹;多台就先选机器(那台机器上挑,别的机器由那台画目录树)。
 * 菜单开在 portal 里,但 React 的点击照样冒泡回卡片 —— 菜单里每一下都要拦住,❌ 选台机器顺手把卡片摊开。
 */
function AttachButton({
  machines,
  onAttach,
  label,
  heading,
  onAddMachine,
  addLabel,
}: {
  machines: readonly AttachMachine[];
  onAttach: (machine: string | null) => void;
  label: string;
  heading: string;
  onAddMachine?: () => void;
  addLabel: string;
}) {
  const button = (
    <Button
      size="icon"
      className="gg-folder-card__add"
      aria-label={label}
      title={label}
      data-testid="project-folder-attach"
      onClick={(event) => {
        event.stopPropagation();
        if (machines.length <= 1 && !onAddMachine) onAttach(machines[0]?.id ?? null);
      }}
    >
      <Plus />
    </Button>
  );
  if (machines.length <= 1 && !onAddMachine) return button;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={button} />
      <DropdownMenuContent side="top" align="end" className="w-auto max-w-80 min-w-48" onClick={(event) => event.stopPropagation()}>
        {/* 分组标题只能在 Group 里(Base UI):少了这一层,点开菜单整页崩(#7341 实机撞过)。 */}
        <DropdownMenuGroup>
          <DropdownMenuLabel>{heading}</DropdownMenuLabel>
          {machines.map((machine) => (
            <DropdownMenuItem
              key={machine.id ?? 'this-computer'}
              disabled={!machine.online}
              data-testid="project-folder-attach-machine"
              onClick={() => onAttach(machine.id)}
            >
              {machine.kind === 'server' ? <Server className="size-3.5 shrink-0" /> : <Monitor className="size-3.5 shrink-0" />}
              <span className="min-w-0 truncate">{machine.label}</span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        {onAddMachine ? <>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-testid="project-folder-add-machine" onClick={onAddMachine}>
            <Plus className="size-3.5 shrink-0" />
            {addLabel}
          </DropdownMenuItem>
        </> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MachineChip({ machine }: { machine: FolderCardMachine }) {
  return (
    <span className="gg-folder-chip">
      {machine.kind === 'server' ? <Server /> : <Monitor />}
      {machine.label}
      <span className={cn('gg-folder-chip__dot', !machine.online && 'is-offline')} />
    </span>
  );
}
