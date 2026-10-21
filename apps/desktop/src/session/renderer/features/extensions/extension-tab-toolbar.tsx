import { observer } from 'mobx-react-lite';
import { declaredToolbarCommands, runExtensionCommand } from './extension-commands';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

/**
 * The buttons an extension declared for its own tab.
 *
 * Drawn by the host, in host chrome, from the manifest — the extension never
 * gets a handle to build furniture with. An extension that declared nothing
 * renders nothing at all: an empty strip above every surface would cost every
 * extension vertical space to say「这里什么都没有」. Refs #2374.
 *
 * ⚠️ 只用 `index.css` 的 `@theme` 里登记过的色标。Tailwind v4 对没登记的 color key
 * **静默丢掉整条 utility**——第一版写的 `bg-hover` / `border-border-subtle` 两个都不
 * 存在,于是这条工具栏既没有分隔线也没有 hover 反馈,还全绿。
 */
export const ExtensionTabToolbar = observer(function ExtensionTabToolbar({
  tabKind,
  sessionId,
  tabId,
  label,
}: {
  /** `<extensionId>.<tabName>` — which contribution's buttons these are. */
  tabKind: string;
  sessionId: string | null;
  tabId: string;
  /** Names the strip for a screen reader; falls back to a generic word. */
  label?: string;
}) {
  const { translate } = useSessionMessages();
  const commands = declaredToolbarCommands(tabKind);
  if (commands.length === 0) return null;
  return (
    <div
      role="toolbar"
      aria-label={label ?? translate('extensions.actions')}
      aria-orientation="horizontal"
      className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1"
    >
      {commands.map((command) => (
        <button
          key={command.id}
          type="button"
          className="gg-pressable flex min-h-8 items-center rounded-sm px-3 text-xs text-foreground-muted hover:bg-row-hover hover:text-foreground"
          onClick={() => {
            runExtensionCommand(sessionId, tabId, command.id);
          }}
        >
          {command.title}
        </button>
      ))}
    </div>
  );
});
