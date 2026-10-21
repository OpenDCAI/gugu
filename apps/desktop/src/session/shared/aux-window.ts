/**
 * 咕咕自己开的子窗口(spec session-page「一屏几块」:一整块、一个 App 单独成窗):`window.open('about:blank', 名字)`
 * 的名字带这个前缀,主进程认这个前缀放行、配窗口外观;别的 window.open 照旧交给系统浏览器。
 */
export const AUX_WINDOW_NAME_PREFIX = 'gugu-aux:';

/** 构建角标也要浮在原生网页视图之上,不参与宿主文档里的网页遮挡判定。 */
export const BUILD_TAG_WINDOW_NAME = `${AUX_WINDOW_NAME_PREFIX}build-tag`;

export function isAuxWindowRequest(url: string, frameName: string): boolean {
  return (url === 'about:blank' || url === '') && frameName.startsWith(AUX_WINDOW_NAME_PREFIX);
}

/**
 * #7274 agent 操作网页时它的鼠标和「agent 正在操作」小条画在一扇透明、点不着、拿不到焦点的子窗里,盖在网页上:
 * 网页是画在界面之上的独立 view,界面自己的元素盖不住它。名字带这个前缀 + 页签的 browserId。
 */
export const AGENT_OVERLAY_WINDOW_NAME_PREFIX = 'gugu-agent-overlay:';

export function isAgentOverlayWindowRequest(url: string, frameName: string): boolean {
  return (url === 'about:blank' || url === '') && frameName.startsWith(AGENT_OVERLAY_WINDOW_NAME_PREFIX);
}

export function agentOverlayWindowName(browserId: string): string {
  return `${AGENT_OVERLAY_WINDOW_NAME_PREFIX}${browserId}`;
}

export function browserIdOfAgentOverlay(frameName: string): string | null {
  return frameName.startsWith(AGENT_OVERLAY_WINDOW_NAME_PREFIX) ? frameName.slice(AGENT_OVERLAY_WINDOW_NAME_PREFIX.length) || null : null;
}
