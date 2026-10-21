import { UI_EVENTS } from '@/lib/uiEvents';
import type { ActiveSection } from '@gugu/core/shared/enums/settingsSectionModels';

// 设置只有一个,是壳的弹窗(product spec)。本页只转达「打开它、落到哪一格」;关掉是弹窗自己的事。
export function openShellSettings(section?: ActiveSection): void {
  window.dispatchEvent(new CustomEvent(UI_EVENTS.openSettings, { detail: { section } }));
}
