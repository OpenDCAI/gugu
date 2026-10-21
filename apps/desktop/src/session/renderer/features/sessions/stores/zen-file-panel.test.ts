import { describe, expect, it } from 'vitest';
import { workspacePanelChromeStore, zenFilePanel } from './workspace-panel-chrome-store';

// #6754 禅模式(「Hide both sidebars」)的右半边 = 文件面板,❌ 已无处挂载的旧变更面板。
describe('zenFilePanel', () => {
  it('进禅模式收起 app 级文件面板形态,出来写回原值', () => {
    workspacePanelChromeStore.setCollapsed(false);
    const panel = zenFilePanel();
    const snapshot = panel.isCollapsed;

    panel.setCollapsed(true);
    expect(workspacePanelChromeStore.collapsed).toBe(true);
    panel.setCollapsed(snapshot);

    // 空面板的会话里推导值恒为「收起」;记的若是推导值,这里会被写成 true,偏好就丢了。
    expect(snapshot).toBe(false);
    expect(workspacePanelChromeStore.collapsed).toBe(false);
  });
});
