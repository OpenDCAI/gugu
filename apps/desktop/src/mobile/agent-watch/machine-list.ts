import type { Device } from '@gugu/core/shared/types/chat'
import { machineKeyOf } from '@/components/contacts/contactsByDevice'

/**
 * 按**电脑**归并,不按设备行。
 *
 * 设备 id 由(机器, 账号, tier)派生(#523):同一台电脑上正式版与测试版是两条设备行、两个
 * device_id、同一个 label。不归并的话这里会把一台 Mac 列成两台一模一样的行,而其中一条
 * 往往是几天前的旧实例 —— 点进去说「机器离线」。真机上 owner 就是这么撞上的
 * (一个测试账号名下 demo + production 两行,后者最后在线是 9 天前)。
 * 通讯录早就把这条定为 bug 并归并了(contactsByDevice 的 @@@4277),这里复用**同一个** key 函数,
 * ❌ 不另写一份同形拷贝。
 *
 * 代表行取分组里排在最前的那条 —— 设备 store 按最近活跃排序,所以在线的那条天然排在旧的前面,
 * 手机也就总是去够得着的那一个实例。
 */
function byMachine<T extends Device>(devices: readonly T[]): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const device of devices) {
    const key = machineKeyOf(device)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(device)
  }
  return out
}

/**
 * 「任务」tab 与选机器那两张页上列哪几台:人自己名下的机器,按电脑归并。
 * 个人助理住的那台(云端宿主)**两种模式都不列**(product spec「它住在哪」,owner 10-15:用户只知道个人助理,
 * 不需要知道它住在哪;那台不接人开的任务):它派出的任务在「助理」App 的「任务」里,不在这张机器列表上。
 */
export function visibleMachines<T extends Device>(devices: readonly T[], isHome: (device: T) => boolean): T[] {
  return byMachine(devices.filter((device) => !isHome(device)))
}
