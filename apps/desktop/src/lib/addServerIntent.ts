// #6264 会话页新建框里「添加一台机器」→ 打开「设置 → 设备」并直接进入添加那一步。
// 设置面板是按需挂载的,所以意图先记在这里,「设备」那一页挂上时取走(取走即清,❌ 下次进设置又弹一遍)。
let pending = false

export function requestAddServerOnOpen(): void {
  pending = true
}

export function consumeAddServerIntent(): boolean {
  const value = pending
  pending = false
  return value
}
