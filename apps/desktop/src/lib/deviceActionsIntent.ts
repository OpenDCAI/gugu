// #7199 助理主页「设备」那块点一台设备 → 打开「设置 → 设备」并直接进那台的「能做的事」。
// 设置面板按需挂载,意图先记在这里,「设备」那一页挂上时取走(取走即清,❌ 下次进设置又跳一遍)。与 addServerIntent 同形。
let pending: string | null = null

export function requestDeviceActionsOnOpen(deviceId: string): void {
  pending = deviceId
}

export function consumeDeviceActionsIntent(): string | null {
  const value = pending
  pending = null
  return value
}
