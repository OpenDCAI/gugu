import { RESOURCE_MONITOR_WINDOW_NAME } from '../src/session/shared/resource-monitor';
import type { SpecialAuxWindow } from './aux-window';
import { hardenWebPreferences } from './devtools-lock';

/** Existing same-process auxiliary-window path; created on click, destroyed on close. */
export const resourceMonitorWindow: SpecialAuxWindow = {
  name: RESOURCE_MONITOR_WINDOW_NAME,
  options: (backgroundColor) => ({
    width: 360, height: 220, minWidth: 320, minHeight: 200,
    alwaysOnTop: true, maximizable: false, fullscreenable: false, backgroundColor,
    webPreferences: hardenWebPreferences({ sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }),
  }),
  adopt: (child) => { child.setAlwaysOnTop(true, 'floating'); },
};
