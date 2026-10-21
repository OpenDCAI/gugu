import { Globe, Server } from '@/lib/icons'
import { PaneEmptyStateAction, type WorkspacePanelAction } from '../sessions/pane-empty-state';
import * as styles from './browser-start-page.css';
import { Button } from '@renderer/lib/ui/button';
import type { ProjectsTranslate } from '@renderer/localization/messages-projects';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

export function BrowserStartPage({
  devServerUrls,
  onOpenUrl,
  actions = [],
}: {
  devServerUrls: string[];
  actions?: WorkspacePanelAction[];
  onOpenUrl: (url: string) => void;
}) {
  const { translate } = useSessionMessages();
  const localUrls = devServerUrls.filter(isLocalUrl);
  const order = ['review', 'terminal', 'files', 'side-session', 'browser', 'ports'];
  const tools = actions.filter((action) => action.section !== 'extensions')
    .sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  const apps = actions.filter((action) => action.section === 'extensions');

  return (
    <div className={styles.startPage}>
      <div className={styles.content}>
        {tools.length > 0 && <section className={styles.section}>
          <h2 className={styles.heading}>{translate('browser.tools')}</h2>
          <div className={styles.tools}>
            {tools.map((entry) => <PaneEmptyStateAction key={entry.id}
              className={styles.tool} icon={entry.icon} label={entry.id === 'browser' ? translate('browser.newPage') : entry.label}
              shortcutSettingsKey={entry.shortcutSettingsKey} disabled={entry.disabled}
              title={entry.title} onClick={entry.onClick} />)}
          </div>
        </section>}
        {apps.length > 0 && <section className={styles.section}>
          <h2 className={styles.heading}>{translate('extensions.appsSection')}</h2>
          <div className={styles.apps}>
            {apps.map((entry) => <Button key={entry.id} variant="ghost" className={styles.app}
              disabled={entry.disabled} title={entry.title ?? entry.label} onClick={entry.onClick}>
              <span className={styles.appIcon}>{entry.icon}</span>
              <span className="w-full truncate text-center">{entry.label}</span>
            </Button>)}
          </div>
        </section>}
        {localUrls.length > 0 && (
          <>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-foreground-muted">
                {translate('browser.localServers')}
              </h2>
              <Server className="size-4 text-foreground-tertiary-muted" />
            </div>
            {/* 密度面板承载整段,行与行之间靠 gap + hover 底色,不逐行画框
                (design.md:prefer a change of density over a box — 2026-09-22 改)。 */}
            <div className="flex flex-col gap-1 rounded-lg bg-background-1 p-1">
              {localUrls.map((url) => (
                <button
                  key={url}
                  type="button"
                  className="group hover:bg-row-hover flex min-h-14 w-full items-center gap-3 rounded-md px-3 py-2 text-left"
                  onClick={() => onOpenUrl(url)}
                >
                  {/* 裸图标,不塞进染色 tile(design.md Reject:icons dropped into tinted tiles)——
                      2026-09-22 去掉框/填底/蓝墨:图标的蓝不表达任何状态,真正的在线信号是
                      右侧那个圆点(见下,C-05)。 */}
                  <Globe className="size-4 shrink-0 text-foreground-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {formatServerTitle(url, translate)}
                    </span>
                    {/* host:port 是要照抄去连的地址,走 mono(design.md:mono 唯一的活是
                        「你要输入或安装的东西」—— 2026-09-22 补上)。 */}
                    <span className="block truncate font-mono text-xs text-foreground-muted">
                      {formatServerAddress(url)}
                    </span>
                  </span>
                  <span className="size-2 shrink-0 rounded-full bg-foreground-info" />
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function formatServerAddress(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}

// The port number and the host:port address are raw URL data; only the
// surrounding "Port <n>" label is localized.
function formatServerTitle(url: string, translate: ProjectsTranslate): string {
  const address = formatServerAddress(url);
  for (const prefix of ['localhost:', '127.0.0.1:']) {
    if (address.startsWith(prefix)) {
      return translate('browser.serverPort', { port: address.slice(prefix.length) });
    }
  }
  return address;
}

function isLocalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === 'localhost' ||
      parsed.hostname === '127.0.0.1' ||
      parsed.hostname === '::1' ||
      parsed.hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}
