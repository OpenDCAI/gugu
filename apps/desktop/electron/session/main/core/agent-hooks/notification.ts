import type { AgentStatusView } from '@gugu/core/shared/agentStatus';
import { shouldNotify } from '@gugu/core/shared/ui/notificationModels';
import { eq } from 'drizzle-orm';
import { app, BrowserWindow, Notification } from 'electron';
import { getMainWindow } from '@main/app/window';
import { getPluginMetadata } from '@main/core/agents/plugin-registry';
import { appSettingsService } from '@main/core/settings/settings-service';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { sessionAgentNotificationCopy } from './notification-copy';
import { taskName } from '@main/core/sessions/task-name';

const activeNotifications = new Set<Notification>();

export function focusAppFromNotification(): BrowserWindow | null {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return null;

  if (win.isMinimized()) win.restore();
  win.show();

  if (process.platform === 'darwin') {
    app.focus({ steal: true });
  } else {
    app.focus();
  }

  win.focus();
  return win;
}

/**
 * @@@5301 正文跟宿主语言走。这两句从前是写死的英文 —— 中文用户在会话页收到的横幅是英文的,
 * 而同一个 app 里聊天那条链(main.ts)一直是中文的,同一台机上两种语言。
 * 文案由宿主注入,❌ 别改回 import 宿主的语言 store(它有模块级状态,跨界只会拿到复制品)。
 */
function getNotificationBody(reading: AgentStatusView): string {
  const answering = reading.detail === 'question' || reading.detail === 'plan';
  return sessionAgentNotificationCopy()[answering ? 'needsAnswer' : 'needsApproval'];
}

async function getSessionLabel(sessionId: string): Promise<{ title: string | null; provider: string | null }> {
  const [row] = await db
    .select({ id: sessions.id, config: sessions.config, provider: sessions.provider })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  return { title: row ? taskName(row) : null, provider: row?.provider ?? null };
}

function getProviderName(providerId: string): string {
  return getPluginMetadata(providerId).name;
}

/**
 * 该不该发只看前后两份读数(shouldNotify:停下来等你批准 / 回答才叫人,做完、出错这类纯状态变化不叫),
 * ❌ 不按原始事件类型、❌ 不按读数从哪条路来(终端 hook、ACP、宿主自己的等待都是同一份读数) ——
 * 被自动批准的 permission_prompt 不会把读数推到 needs_user,也就不叫人。
 */
export async function maybeShowNotification(
  session: { sessionId: string; projectId: string },
  previous: AgentStatusView | null,
  next: AgentStatusView,
): Promise<void> {
  try {
    const { enabled, sound } = await appSettingsService.get('notifications');
    // @@@5301 ❌ 这里**不看窗口聚焦**(onScreen 恒为 false)。焦点只说明这个窗口在最前面,不说明人在电脑前 ——
    // 拿它当「用户已经看见了」的证据,结果就是人离开时该响的不响(owner 2026-09-09 定)。
    // 要不要打扰由用户自己的显式选择决定:通知总开关；声音只跟横幅。
    if (!Notification.isSupported()) return;
    if (!shouldNotify({ kind: 'agent', previous, next }, { enabled, onScreen: false })) return;

    const body = getNotificationBody(next);

    const label = await getSessionLabel(session.sessionId);
    const providerName = label.provider ? getProviderName(label.provider) : 'Agent';
    const title = label.title ? `${providerName} — ${label.title}` : providerName;

    const notification = new Notification({ title, body, silent: !sound });
    activeNotifications.add(notification);

    const releaseNotification = () => activeNotifications.delete(notification);
    notification.on('close', releaseNotification);
    // @@@5301 `failed` 带着**系统给的原因**(macOS 从 Electron 42 起走 UNNotification,
    // 被拒时 `addNotificationRequest` 回一个 NSError,Electron 原样转成这个事件)。
    // 从前这里只把对象从集合里摘掉,把原因丢了 —— 于是「跑完没横幅」在日志里一个字都没有。
    notification.on('failed', (_event, error) => {
      releaseNotification();
      log.warn('notification: OS refused to show the agent notification', { error: String(error) });
    });
    notification.on('show', () => {
      log.debug('notification: agent notification accepted by the OS', { title });
    });
    notification.on('click', () => {
      const win = focusAppFromNotification();
      if (!win) return;

      releaseNotification();
      // The window first (a banner's click comes from outside it), then the one way a session is opened.
      void import('../extensions/gugu-links').then(({ openLink }) => openLink({ kind: 'session', sessionId: session.sessionId, projectId: session.projectId }));
    });

    notification.show();
  } catch (error) {
    log.error('notification: failed to show OS notification', { error: String(error) });
  }
}

