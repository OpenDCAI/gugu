/**
 * @@@win-titlebar-row — 标题栏「后退 / 前进」背后的**壳级**历史(WindowTitleBar.tsx)。
 *
 * 一格 = 用户在壳里「站在哪」:哪个 tab;在对话 tab 上再加「选中的是哪条会话」。
 * 设置是弹窗、新建 Agent 是草稿面,都不算一格 —— 关掉它们不该要按一次后退。
 *
 * 会话页有自己的一份历史(换任务、换页签,见会话页的 NavigationHistoryStore),这里❌ 再记一遍:
 * 在任务 tab 上时,后退/前进先交给会话页那份,它走到头了才轮到这一份(useShellNavigation)。
 */
export type ShellLocation =
  | { tab: 'chats'; chatId: string | null }
  | { tab: 'contacts' }
  | { tab: 'tasks' }

export function sameShellLocation(a: ShellLocation, b: ShellLocation): boolean {
  if (a.tab !== b.tab) return false
  if (a.tab === 'chats' && b.tab === 'chats') return a.chatId === b.chatId
  return true
}

/** 一条历史里最多留多少格;再多就丢最早的(与会话页那份同一上限)。 */
export const SHELL_HISTORY_LIMIT = 50

/** 这一格现在还去得了吗(例如那条会话已被删掉)。去不了的格在后退/前进时被跳过。 */
export type ShellLocationReachable = (location: ShellLocation) => boolean

export class ShellNavigationHistory {
  private entries: ShellLocation[] = []
  private index = -1
  /**
   * 后退/前进正在落地的那一格。落地会让壳的位置变化一次,那次变化是「回到了这一格」,
   * ❌ 不是一次新导航 —— 否则后退一步就把前进栈截掉了。
   */
  private applying: ShellLocation | null = null

  /** 壳的位置变了,记下来。 */
  record(location: ShellLocation): void {
    const applying = this.applying
    this.applying = null
    if (applying && sameShellLocation(applying, location)) return

    const current = this.entries[this.index]
    if (current && sameShellLocation(current, location)) return
    // 对话 tab 从「没选会话」变成「选了一条」是把这一格填上,不是走到了新的一格:
    // 否则冷启动后恢复选中的那一下,会让第一次后退落在一片空白的会话区上。
    // 但它仍是一次新的选择 ⇒ 前进栈照样截掉(后退到这一格再点一条会话,「前进」不该还指着旧路)。
    if (current?.tab === 'chats' && current.chatId === null && location.tab === 'chats') {
      this.entries[this.index] = location
      this.entries.splice(this.index + 1)
      return
    }

    this.entries.splice(this.index + 1)
    this.entries.push(location)
    if (this.entries.length > SHELL_HISTORY_LIMIT) this.entries.shift()
    this.index = this.entries.length - 1
  }

  canGoBack(reachable: ShellLocationReachable): boolean {
    return this.findReachable(-1, reachable) !== null
  }

  canGoForward(reachable: ShellLocationReachable): boolean {
    return this.findReachable(1, reachable) !== null
  }

  /** 退到上一格还去得了的位置,返回它(调用方负责真的切过去);没有就返回 null、游标不动。 */
  back(reachable: ShellLocationReachable): ShellLocation | null {
    return this.step(-1, reachable)
  }

  forward(reachable: ShellLocationReachable): ShellLocation | null {
    return this.step(1, reachable)
  }

  private step(direction: -1 | 1, reachable: ShellLocationReachable): ShellLocation | null {
    const target = this.findReachable(direction, reachable)
    if (target === null) return null
    this.index = target
    const location = this.entries[target]!
    this.applying = location
    return location
  }

  private findReachable(direction: -1 | 1, reachable: ShellLocationReachable): number | null {
    for (let i = this.index + direction; i >= 0 && i < this.entries.length; i += direction) {
      if (reachable(this.entries[i]!)) return i
    }
    return null
  }
}
