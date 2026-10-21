import { observer } from 'mobx-react-lite';
import { Folder, Monitor, Server } from '@/lib/icons';
import { useEffect, useState } from 'react';
import { hostStatusLabel, type HostConnectionState } from '@renderer/features/remote-hosts/connection-status';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/lib/ui/tooltip';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import { cn } from '@renderer/utils/utils';

// #6264「会话页里的别的机器」:项目名旁的机器名,前面一颗状态点(照 Zed 标题栏的主机名 + 状态点、
// VS Code 左下角的远程指示):
//   · 点的颜色 = 此刻的连接状态(连接中 / 已连接 / 重连中 / 离线),悬停说清楚,离线时带「上次在线 X 前」;
//   · 它只是标签,点它 = 点这一行(owner 嫌易误触,不再有菜单)。

// 色只有一个 accent(design.md):连接中 / 已连接 / 重连中都是「此刻活着的连接」⇒ live 蓝,
// 在路上的两种再加呼吸(docs/ui-visual-spec.md §6.4 ③:「在动」用琥珀、「选中」用蓝 = 两个 accent,已并成 live);
// ❌ 成功绿 / 琥珀各占一色。离线退成最淡的墨色。四种的区别另有悬停文字说清。
const DOT_CLASS: Record<HostConnectionState, string> = {
  connecting: 'bg-live animate-pulse motion-reduce:animate-none',
  connected: 'bg-live',
  reconnecting: 'bg-live animate-pulse motion-reduce:animate-none',
  offline: 'bg-foreground-passive opacity-60',
  // 要先登录(远程 SSH):没连着 ⇒ 与离线同一个淡墨点;区别在悬停那句话(「要先登录」)。
  'sign-in': 'bg-foreground-passive opacity-60',
  // 那台机器上的咕咕 server 太旧:连不上一套工作台,同离线的淡墨点;悬停说它会自己升级。
  outdated: 'bg-foreground-passive opacity-60',
  // 远程 SSH 的机器太旧、正在替它升级:在路上 ⇒ 与重连中同一颗呼吸的点;悬停说「版本太旧，正在更新」。
  updating: 'bg-live animate-pulse motion-reduce:animate-none',
  'update-failed': 'bg-foreground-passive opacity-60',
  // #7199 云电脑休眠中:live 空心圈 —— 它不是离线(有事会自动醒),❌ 退成淡墨;正在唤醒同重连中那颗呼吸的点。
  asleep: 'border border-live bg-transparent',
  waking: 'bg-live animate-pulse motion-reduce:animate-none',
  'wake-failed': 'border border-live bg-transparent',
};

/** 「上次在线 X 前」这类相对时间要自己走:侧栏开着一小时,不能一直写「刚刚」。 */
function useMinuteTick(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export const RemoteHostChip = observer(function RemoteHostChip({ deviceId }: { deviceId: string }) {
  const { translate } = useSessionMessages();
  const now = useMinuteTick();
  const device = remoteHostsStore.device(deviceId);
  const state = remoteHostsStore.connectionState(deviceId);
  if (!device || !state) return null;
  const label = device.label;
  const status = hostStatusLabel(state, label, device.lastSeenAt, now, translate, device.signInExpiredAt);

  // 纯标签:❌ 按钮、❌ 菜单、❌ 手指光标(owner:「这里容易误触啊,不要让我点击有功能吧?」)。
  // 点它就是点这一行(事件照常冒泡给行);悬停只说连接状态,离线时带「上次在线 X 前」。
  // 机器上的动作各有家:新建 = 行尾的「+」;断线自己会重连,急了去 设置 → 设备 那一行「重新连接」;改名同在那里。
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-remote-host-chip={deviceId}
            data-connection-state={state}
            aria-label={status}
            className="text-foreground-tertiary-passive flex min-w-0 shrink items-center gap-1 text-xs"
          >
            <span aria-hidden className={cn('size-1.5 shrink-0 rounded-[var(--radius-circle,50%)]', DOT_CLASS[state])} />
            <span className="min-w-0 truncate">{label}</span>
          </span>
        }
      />
      <TooltipContent>{status}</TooltipContent>
    </Tooltip>
  );
});

/** 机器标记的悬停文字后面接上它属于哪个项目:有了机器标记,这一行就不再另画项目标记(owner 2026-10-08)。 */
function withProject(text: string, project: string | null, translate: ReturnType<typeof useSessionMessages>['translate']): string {
  return project ? `${text} · ${translate('sidebar.inProject', { project })}` : text;
}

/**
 * 任务区(没有项目行的那些会话,如没选文件夹时跑在隐藏任务工作区里的)那一行前面的机器标记:
 * 与分叉标记同一个形状 —— 前缀小图标、悬停才出「在哪台机器上 · 连接状态 · 属于哪个项目」,❌ 占这 28px 行的宽度。
 * 项目下面的根会话不画(项目行已经挂着 RemoteHostChip);挂在父会话下的 child 与父会话不在同一台机器上时画。
 */
export const RemoteHostBadge = observer(function RemoteHostBadge({ deviceId, project }: { deviceId: string; project: string | null }) {
  const { translate } = useSessionMessages();
  const now = useMinuteTick();
  const device = remoteHostsStore.device(deviceId);
  const state = remoteHostsStore.connectionState(deviceId);
  if (!device || !state) return null;
  const status = withProject(hostStatusLabel(state, device.label, device.lastSeenAt, now, translate, device.signInExpiredAt), project, translate);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-remote-host-badge={deviceId}
            data-connection-state={state}
            aria-label={status}
            className="text-foreground-tertiary-passive flex shrink-0 items-center"
          >
            <Server className={cn('size-3', state !== 'connected' && state !== 'connecting' && state !== 'reconnecting' && 'opacity-60')} />
          </span>
        }
      />
      <TooltipContent className="whitespace-nowrap">{status}</TooltipContent>
    </Tooltip>
  );
});

/** 本机的会话挂在别的机器上的会话下面时,行首那枚「本机」标记(与 RemoteHostBadge 同一个形状)。 */
export function LocalHostBadge({ project }: { project: string | null }) {
  const { translate } = useSessionMessages();
  const label = withProject(translate('task.deviceLocal'), project, translate);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span data-local-host-badge aria-label={label} className="text-foreground-tertiary-passive flex shrink-0 items-center">
            <Monitor className="size-3" />
          </span>
        }
      />
      <TooltipContent className="whitespace-nowrap">{label}</TooltipContent>
    </Tooltip>
  );
}

/** 挂在父会话下、却在别的项目里的会话,行首那枚项目标记(与机器标记同一个形状,悬停出项目名)。 */
export function ProjectBadge({ label }: { label: string }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span data-project-badge={label} aria-label={label} className="text-foreground-tertiary-passive flex shrink-0 items-center">
            <Folder className="size-3" />
          </span>
        }
      />
      <TooltipContent className="whitespace-nowrap">{label}</TooltipContent>
    </Tooltip>
  );
}
