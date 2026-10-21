import type { WindowMaterial } from '../../shared/window-material'

/**
 * @@@window-material (#7333) — renderer 这一侧只做一件事:把主进程的判定原样落到 `<html data-window-material>`。
 * 判定来自主进程读到的系统信号(shared/window-material.ts),❌ 在这里按平台名、媒体查询再判一遍(两个真值会打架)。
 * 没有桥(dev:web、手机、子窗口)⇒ 不落属性 = opaque,那是它们的真实状态:那些地方没有系统材质。
 */
export interface WindowMaterialBridge {
  getMaterial?: () => WindowMaterial
  onMaterialChange?: (callback: (material: WindowMaterial) => void) => () => void
}

export const WINDOW_MATERIAL_ATTRIBUTE = 'windowMaterial'

export function installWindowMaterialAttribute(root: HTMLElement, bridge: WindowMaterialBridge | undefined): () => void {
  if (!bridge?.getMaterial) return () => {}
  root.dataset[WINDOW_MATERIAL_ATTRIBUTE] = bridge.getMaterial()
  if (!bridge.onMaterialChange) return () => {}
  return bridge.onMaterialChange((material) => {
    root.dataset[WINDOW_MATERIAL_ATTRIBUTE] = material
  })
}
