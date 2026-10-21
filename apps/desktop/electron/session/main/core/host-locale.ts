/**
 * 宿主的界面语言,由宿主注入(同 agent-hooks/notification-copy.ts 的理由:会话页 ❌ import 宿主的语言 store,
 * 跨界只会拿到一份复制品)。会话页这侧替人写字的地方要它:App 的名字按 manifest 的 `localized` 挑那一种语言
 * (`localizedManifestText`),系统横幅、App 页拿到的打开方式、链接打不开的对话框都在这一侧拼。
 *
 * 宿主启动时注入一次、语言切换时再注入。没注入就是接线错了 ⇒ 抛,❌ 退回主字段装作一切正常。
 */
let injected: string | null = null;

export function setSessionHostLocale(locale: string): void {
  injected = locale;
}

export function sessionHostLocale(): string {
  if (!injected) throw new Error('the host locale was never injected into the session page');
  return injected;
}
