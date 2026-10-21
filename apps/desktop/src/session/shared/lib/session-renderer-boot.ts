type SessionRendererBootFailure = (error: unknown) => void

declare global {
  interface Window {
    __EMDASH_REPORT_BOOT_FAILURE__?: SessionRendererBootFailure
  }
}

/**
 * 嵌入 renderer 的 bootstrap 失败报给宿主的桥。宿主把它和资源没载入走同一条路(错误卡 + fail loud):
 * bootstrap 被拒时挂载点永远不会出现子节点,不报上来就是一直转下去的加载态。
 */
export function installSessionRendererBootFailureReporter(
  reporter: SessionRendererBootFailure,
): void {
  // EmdashSessionFrame 是常驻实例，StrictMode cleanup 不能撤掉它唯一的宿主桥。
  window.__EMDASH_REPORT_BOOT_FAILURE__ = reporter
}

export function reportSessionRendererBootFailure(error: unknown): void {
  window.__EMDASH_REPORT_BOOT_FAILURE__?.(error)
}
