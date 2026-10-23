/**
 * #6753 左右两颗面板开关归窗口 chrome:控制器(一格一份、撤销只撤自己)、
 * 标题栏行里的悬停区(Windows 上 ← → 与「文件」之间不许闪出预览)、内容区让位车道在 Windows 收回。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  listSlotOf,
  publishPanelToggle,
  readPanelToggle,
} from '../../../../apps/desktop/src/lib/panelToggles'
import {
  SHELL_RESTORE_LANE_PX,
  shellRestoreLane,
} from '../../../../apps/desktop/src/lib/window-chrome'
import {
  PEEK_EDGE_ZONE_PX,
  peekZones,
} from '../../../../apps/desktop/src/session/renderer/lib/layout/sidebar-peek'

describe('panelToggles 控制器', () => {
  beforeEach(() => vi.stubGlobal('window', {}))
  afterEach(() => vi.unstubAllGlobals())

  it('每个页签只认自己的列表栏;通讯录没有同构的列表栏', () => {
    expect(listSlotOf('tasks')).toBe('list:sessions')
    expect(listSlotOf('chats')).toBe('list:chats')
    expect(listSlotOf('contacts')).toBeNull()
  })

  it('撤销只撤自己那一份:先登记的卸载不会撤掉后登记的', () => {
    const first = { open: true, label: 'Collapse', toggle: vi.fn() }
    const second = { open: false, label: 'Expand', toggle: vi.fn() }
    const withdrawFirst = publishPanelToggle('list:sessions', first)
    const withdrawSecond = publishPanelToggle('list:sessions', second)
    withdrawFirst()
    expect(readPanelToggle('list:sessions')).toBe(second)
    withdrawSecond()
    expect(readPanelToggle('list:sessions')).toBeNull()
  })
})

describe('peekZones:标题栏行那一截', () => {
  // Windows:rail 60 + 卡片描边 1 ⇒ 列表栏根的左上角在 (61, 37);标题栏里的开关在 x 68..96。
  const root = { left: 61, top: 37 }
  const width = 240

  it('根以内:左缘 12px 是进入区,侧栏宽以内是保持区(mac 的根从窗口顶起,只走这一支)', () => {
    expect(peekZones({ x: root.left + PEEK_EDGE_ZONE_PX, y: 200 }, root, width)).toEqual({ inEnterZone: true, inStayZone: true })
    expect(peekZones({ x: root.left + 200, y: 200 }, root, width)).toEqual({ inEnterZone: false, inStayZone: true })
    expect(peekZones({ x: root.left + width + 1, y: 200 }, root, width)).toEqual({ inEnterZone: false, inStayZone: false })
  })

  it('标题栏行里:贴左缘那一截不是进入区 —— 从 ← → 划到「文件」不会闪出预览', () => {
    expect(peekZones({ x: root.left + 4, y: 18 }, root, width).inEnterZone).toBe(false)
  })

  it('标题栏行里:保持区只剩开关那一列,指针移到「文件」上预览就收', () => {
    expect(peekZones({ x: 82, y: 34 }, root, width).inStayZone).toBe(true)
    expect(peekZones({ x: root.left + SHELL_RESTORE_LANE_PX + 1, y: 18 }, root, width).inStayZone).toBe(false)
  })

  it('阴控:同一个点落在根以内时两区都成立(判据不是恒假)', () => {
    expect(peekZones({ x: root.left + 4, y: root.top + 1 }, root, width)).toEqual({ inEnterZone: true, inStayZone: true })
  })
})

describe('内容区的侧栏开关车道', () => {
  it('the collapse toggle reserves the same content header lane on every platform', () => {
    for (const platform of ['win', 'mac', 'linux', 'other', undefined]) {
      expect(shellRestoreLane(platform)).toBe(SHELL_RESTORE_LANE_PX)
    }
  })
})
