// #7199「这台电脑能做的事」分组的名字与一句说明,文案在 settings 命名空间。
// 设置页与「助理」App(能力 · 设备)都从这里取,❌ 各写一份。
import { useTranslation } from 'react-i18next'

/** i18next 把 key 里的「.」当层级:files.desktop 在文案表里写作 files_desktop。 */
const groupKey = (id: string) => id.replace('.', '_')

export function useDeviceActionGroupText() {
  const { t } = useTranslation('settings')
  return {
    name: (id: string) => t(`devices.deviceActions.group.${groupKey(id)}`, { defaultValue: id }),
    description: (id: string) => t(`devices.deviceActions.groupDesc.${groupKey(id)}`, { defaultValue: '' }),
  }
}
