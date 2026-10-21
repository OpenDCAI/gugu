import { Button } from '@renderer/lib/ui/button';
import { cn } from '@renderer/utils/utils';
import type { SessionTranslate } from '../extension-consent';
import { pendingLabel, type ExtensionPendingAction } from './extension-pending';

/**
 * 这一行 / 这一页的 App 此刻该给的那一下(#7059,原型「一个按钮走完一生:安装 → 下载中 → 打开,有新版 = 更新」,
 * 照 Mac App Store / VS Code:位置、宽度不变,字跟着走)。
 *
 * - `get`:没装,点了装;`update`:装着、市场有能装的新版;`enable`:装着、停用了;`open`:装着、启用、有一页能打开。
 * - `word`:没有可按的事,只说一个词(已安装 / 需要更新咕咕);`null` 什么都不画(装着、启用、但没有一页可开,
 *   例如只认领文件的 App —— 它在 ⋯ 里管)。
 */
export type AppLifecycle =
  | { kind: 'get' }
  | { kind: 'update'; version: string }
  | { kind: 'enable' }
  | { kind: 'open' }
  | { kind: 'word'; text: string; title?: string }
  | null;

export function AppLifecycleButton({
  state,
  pending,
  percent,
  primary = false,
  disabled = false,
  translate,
  onClick,
  testId,
}: {
  state: AppLifecycle;
  /** 正在对它做的事:按钮换成进度,不接第二下。 */
  pending?: ExtensionPendingAction;
  percent?: number;
  /** 这一屏唯一的主按钮(产品页头上那一颗):实底;更新写全「更新到 vX」。行上的是描边小号。 */
  primary?: boolean;
  disabled?: boolean;
  translate: SessionTranslate;
  onClick: () => void;
  testId?: string;
}) {
  if (pending && pending !== 'uninstalling') {
    // 下载那一段有百分比就画一圈进度;读包、解包、装那几段只说在做什么。
    const ring = pending === 'downloading' && percent !== undefined;
    return (
      <span className={cn('mk-busy', primary && 'is-primary')} role="status" data-testid={testId}>
        {ring ? <i className="mk-ring" style={{ '--p': percent } as React.CSSProperties} aria-hidden /> : null}
        {pendingLabel(pending, translate, percent)}
      </span>
    );
  }
  if (!state) return null;
  if (state.kind === 'word') {
    return (
      <span className="mk-word" title={state.title} data-testid={testId}>
        {state.text}
      </span>
    );
  }
  const label =
    state.kind === 'get'
      ? translate('extensions.installAction')
      : state.kind === 'update'
        ? primary
          ? translate('extensions.updateTo', { version: state.version })
          : translate('extensions.updateAction')
        : state.kind === 'enable'
          ? translate('extensions.enable')
          : translate('extensions.open');
  return (
    <Button
      type="button"
      // 行上那颗用描边小号(咕咕设置页里行尾按钮那一种);secondary 的浅底在白底上几乎看不见,读起来像一行字。
      variant={primary ? 'default' : 'outline'}
      size={primary ? 'lg' : 'sm'}
      // 定宽:安装 → 下载中 → 打开,位置不跳。产品页头上那颗照 Google Play 宽 200。
      className={primary ? 'mk-primary-action' : 'min-w-14'}
      disabled={disabled || pending === 'uninstalling'}
      data-testid={testId}
      data-lifecycle={state.kind}
      onClick={(event) => {
        // 行本身点了是开产品页;按钮是它自己的事。
        event.stopPropagation();
        onClick();
      }}
    >
      {label}
    </Button>
  );
}
