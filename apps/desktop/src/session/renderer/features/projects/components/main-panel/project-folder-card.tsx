import { observer } from 'mobx-react-lite';
import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type DragEvent, type PointerEvent } from 'react';
import { Check, Monitor, Plus, Server } from '@/lib/icons';
import type { ProjectFolder } from '@shared/core/projects/project-folders';
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
import './project-folder-card.css';

/**
 * 项目首页的文件夹卡(product spec「项目首页」,owner 2026-10-17 从三个方向里选 B,#7341)。
 *
 * 卡片露出最近用的几个文件夹(像从文件夹里探出来的纸);点卡片摊开全部;点其中一张 = 新会话从那儿开工;
 * 「+」或把文件夹拖上来 = 挂文件夹。封面颜色按项目 id 固定,有 agent 在跑时更鲜、没人在跑褪成灰。
 */

/** 卡片几何(px)。后片右上有个耳朵,前片左边高一截。 */
const G = { W: 468, H: 276, backH: 226, frontH: 136, TW: 132, TH: 22, LW: 168, S: 18, paperW: 236, paperH: 76, peek: 74 };
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

/** 封面:按项目 id 固定的两三团柔色(同头像规矩:同一个项目永远同一张)。 */
const HUES = [
  ['#9fc3cd', '#b9a9d6', '#c9dade'],
  ['#e2b394', '#a2c4b2', '#e3d3c3'],
  ['#b4a5d6', '#dcaebf', '#d8d0e6'],
  ['#a2c4b2', '#9fc3cd', '#cfe0d6'],
  ['#d4bf9f', '#b9a9d6', '#e2d9c8'],
  ['#a5bde0', '#cdb1d6', '#d3dcec'],
] as const;
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function seeded(seed: string) {
  let x = hash32(seed) || 1;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 4294967296;
  };
}
function Cover({ projectId, running, width, height, uid, saturationBoost = 1 }: { projectId: string; running: number; width: number; height: number; uid: string; saturationBoost?: number }) {
  const [a, b, base] = HUES[hash32(`cover:${projectId}`) % HUES.length];
  const blobs = useMemo(() => {
    const r = seeded(`svg:${projectId}`);
    return [a, b, a, b, '#ffffff'].map((fill, i) => ({
      fill,
      cx: Math.round(r() * width),
      cy: Math.round(r() * height * 0.9),
      rx: Math.round(width * (0.3 + r() * 0.3)),
      ry: Math.round(height * (0.35 + r() * 0.3)),
      opacity: i === 4 ? 0.55 : 0.95,
    }));
  }, [projectId, a, b, width, height]);
  // 在跑的越多越鲜,没人在跑褪成灰:扫一眼就知道哪个项目在动。
  const saturation = (running ? 1.15 + Math.min(running, 8) * 0.08 : 0.25) * saturationBoost;
  const saturated = (hex: string) => {
    const rgb = [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16));
    const luma = rgb[0] * 0.213 + rgb[1] * 0.715 + rgb[2] * 0.072;
    return `rgb(${rgb.map((value) => Math.round(Math.max(0, Math.min(255, luma + saturation * (value - luma))))).join(' ')})`;
  };
  // Soft gradients paint the same seeded palette without allocating SVG blur surfaces.
  const feather = width / 9 * 2;
  return <>
    <defs>{blobs.map((blob, i) => <radialGradient key={i} id={`fc-cloud-${uid}-${i}`}>
      <stop offset="0" stopColor={saturated(blob.fill)} />
      <stop offset="45%" stopColor={saturated(blob.fill)} stopOpacity={0.85} />
      <stop offset="70%" stopColor={saturated(blob.fill)} stopOpacity={0.4} />
      <stop offset="100%" stopColor={saturated(blob.fill)} stopOpacity={0} />
    </radialGradient>)}</defs>
    <rect width={width} height={height} fill={base} />
    {blobs.map((blob, i) => <ellipse key={i} cx={blob.cx} cy={blob.cy} rx={blob.rx + feather} ry={blob.ry + feather} opacity={blob.opacity} fill={`url(#fc-cloud-${uid}-${i})`} />)}
  </>;

}

/**
 * Frost is a cached image of this folder's cover and the peeking papers. Live backdrop-filter
 * caused long GPU raster flushes on first interaction in Electron, even with a Backdrop Root.
 * The two static images stay rasterized; opening only fades the paper image out.
 */
function FrostedFront({ projectId, running, count, uid }: { projectId: string; running: number; count: number; uid: string }) {
  const top = G.H - G.frontH;
  const paperTop = G.H - G.frontH - G.peek;
  const peeking = Math.min(count, 3);
  return <>
    <svg className="gg-folder-card__cover-frost" width={G.W} height={G.frontH} viewBox={`0 ${G.backH - G.frontH} ${G.W} ${G.frontH}`} aria-hidden>
      <g className="gg-folder-card__cover"><Cover projectId={projectId} running={running} width={G.W} height={G.backH} uid={`${uid}-frost`} saturationBoost={1.5} /></g>
    </svg>
    <svg className="gg-folder-card__paper-frost" width={G.W} height={G.frontH} viewBox={`0 ${top} ${G.W} ${G.frontH}`} aria-hidden>
      <defs><radialGradient id={`fc-paper-frost-${uid}`}>
        <stop offset="0" stopColor="var(--card)" stopOpacity={0.95} />
        <stop offset="50%" stopColor="var(--card)" stopOpacity={0.7} />
        <stop offset="100%" stopColor="var(--card)" stopOpacity={0} />
      </radialGradient></defs>
      <g>
        {Array.from({ length: peeking }, (_, index) => {
          const k = peeking === 1 ? 1 : 2 - index;
          const [rot, tx] = STACK[k];
          const x = (G.W - G.paperW) / 2 + tx;
          const y = paperTop + k * 9;
          return <g key={index} transform={`rotate(${rot} ${x + G.paperW / 2} ${y + G.paperH / 2})`}>
            <ellipse cx={x + G.paperW / 2} cy={y + G.paperH - 2} rx={G.paperW / 2 + 24} ry={44} fill={`url(#fc-paper-frost-${uid})`} />
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

/** 只管显示:常见的主目录前缀写成 ~(悬停的 title 仍是完整路径)。 */
export function shortHome(path: string): string {
  return path.replace(/^(?:\/Users\/[^/]+|\/home\/[^/]+|\/root|[A-Za-z]:\\Users\\[^\\]+)(?=[/\\]|$)/, '~');
}

const FRESH_MS = 2 * 60 * 1000;

const cardSize: CSSProperties = { width: G.W, height: G.H };
const bodyStyle: CSSProperties = { paddingTop: G.S + 12 };

export type FolderCardMachine = { id?: string | null; label: string; online: boolean; kind: 'server' | 'computer' };
/** 「+」菜单里的一台机器;id null = 这台电脑。 */
export type AttachMachine = FolderCardMachine & { id: string | null };

/**
 * 项目页签上那枚彩色小文件夹(gugu-dev#181 第 39、40 条):这张卡后片的缩影 —— 同一张按项目固定的封面、同一个
 * 「在跑的越多越鲜,没人在跑褪成灰」,一眼认得出是哪个项目、动没动。
 */
export const ProjectMiniFolder = observer(function ProjectMiniFolder({ projectId }: { projectId: string }) {
  const uid = `mini${projectId.replace(/[^a-z0-9]/gi, '').slice(0, 12)}`;
  const running = (sidebarStore.placement.entries.get(projectId) ?? []).filter((entry) => entry.group === 'working').length;
  const d = backPath(G.W, G.backH, G.TW, G.TH);
  return (
    // size-auto:按钮会把没写 size-* 的 svg 压成 12px 见方(button.tsx),这一枚按自己的 30×18 画。
    <svg width={30} height={18} viewBox={`-6 -6 ${G.W + 12} ${G.backH + 12}`} aria-hidden className="size-auto shrink-0">
      <clipPath id={`fc-mini-${uid}`}><path d={d} /></clipPath>
      <g clipPath={`url(#fc-mini-${uid})`}><Cover projectId={projectId} running={running} width={G.W} height={G.backH} uid={uid} /></g>
      <path d={d} fill="none" stroke="rgba(30,40,60,.35)" strokeWidth={12} />
    </svg>
  );
});

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
  /** 浮在群聊上面(项目块里开新任务,gugu-dev#181):一浮出来就摊开,提示换成「直接打字或按 Esc 就收起」。 */
  floating?: boolean;
}) {
  const { translate } = useSessionMessages();
  useAvatarTick();
  const [open, setOpen] = useState(false);
  const [dragover, setDragover] = useState(false);
  const [landing, setLanding] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
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

  const backD = backPath(G.W, G.backH, G.TW, G.TH);
  const frontD = frontPath(G.W, G.frontH, G.LW, G.S);
  const frontStyle: CSSProperties = { width: G.W, height: G.frontH, ...maskStyle(frontD, G.W, G.frontH) };
  const base = G.H - G.frontH - G.peek;

  /**
   * 每一页纸的位置:收起时最相关的三页叠着探出来(其余的藏在叠底、透明),摊开时全部排成一手牌。
   * ⚠️ 两种状态下纸的 DOM 顺序一样(= ordered),前后只靠 z-index:挪动 DOM 节点会让浏览器丢掉那一页的过渡,
   * 收起时不渲染的纸摊开时是新挂上的节点、同样没有过渡 —— 实测四页里只有一页在动,其余是瞬移过去的。
   */
  type Place = { transform: string; rot: number; tx: number; ty: number; top: number; z: number; hidden: boolean };
  const placement = (index: number, count: number): Place => {
    if (!open) {
      const peeking = Math.min(count, 3);
      const hidden = index >= 3;
      // 只有一页时摆正居中;两页、三页从中间往右叠,最相关的那页在最右、最上面。
      const k = hidden ? 0 : peeking === 1 ? 1 : 2 - index;
      const [rot, tx] = STACK[k];
      return { transform: `translate3d(${tx}px, ${k * 9}px, 0) rotate(${rot}deg)`, rot, tx, ty: k * 9, top: base, z: count - index, hidden };
    }
    const t = count === 1 ? 0 : index / (count - 1) - 0.5;
    const spread = Math.min(640, Math.max(260, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 760));
    const x = t * spread;
    const y = -62 - Math.cos(t * Math.PI) * 40 + Math.abs(t) * 16;
    return {
      transform: `translate3d(${x.toFixed(0)}px, ${y.toFixed(0)}px, 0) rotate(${(t * 12).toFixed(1)}deg)`,
      rot: t * 12,
      tx: x,
      ty: y,
      top: base,
      z: index + 1,
      hidden: false,
    };
  };
  const paperStyle = (place: Place, index: number): CSSProperties => {
    // 飞行过程中保持纸张与文字几何不变，避免逐帧重排。
    const width = G.paperW;
    return {
      width,
      minHeight: G.paperH,
      left: (G.W - width) / 2,
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
    <div className="flex flex-col items-center gap-3">
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
          <svg className="gg-folder-card__back" width={G.W} height={G.backH} viewBox={`0 0 ${G.W} ${G.backH}`} aria-hidden>
            <clipPath id={`fc-back-${uid}`}>
              <path d={backD} />
            </clipPath>
            <g className="gg-folder-card__cover" clipPath={`url(#fc-back-${uid})`}>
              <Cover projectId={projectId} running={running} width={G.W} height={G.backH} uid={uid} />
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
                  <span className="gg-folder-paper__top">
                    <MachineChip machine={paperMachine(folder)} />
                    {folder.branch ? <span className="gg-folder-paper__branch">{folder.branch}</span> : null}
                    {fresh ? <span className="gg-folder-paper__fresh">{translate('projects.folders.fresh')}</span> : null}
                    <span className="gg-folder-paper__check">
                      <Check className="size-3.5" />
                    </span>
                  </span>
                  <span className="gg-folder-paper__path block">{shortHome(folder.path)}</span>
                  <span className={cn('gg-folder-paper__meta block', here > 0 && 'is-running')}>
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
                </Button>
                </div>
                </ProjectFolderMenu>
              );
            })}
          </div>

          <div className="gg-folder-card__front" style={frontStyle}>
            <FrostedFront projectId={projectId} running={running} count={folders.length} uid={uid} />
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
          <svg className="gg-folder-card__front-edge" width={G.W} height={G.frontH} viewBox={`0 0 ${G.W} ${G.frontH}`} aria-hidden>
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
