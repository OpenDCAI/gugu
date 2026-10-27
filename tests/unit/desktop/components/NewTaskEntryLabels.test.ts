import { describe, expect, it } from 'vitest';
import zhMain from '../../../../apps/desktop/src/i18n/locales/zh-CN/main';
import enMain from '../../../../apps/desktop/src/i18n/locales/en-US/main';
import zhSettings from '../../../../apps/desktop/src/i18n/locales/zh-CN/settings';
import enSettings from '../../../../apps/desktop/src/i18n/locales/en-US/settings';
import { enUSMessages, zhCNMessages } from '../../../../apps/desktop/src/session/renderer/localization/messages';

describe('new task entry terminology', () => {
  it.each([
    ['settings shortcut', () => zhMain.settings.newTask, () => enMain.settings.newTask],
    ['shell shortcut', () => zhMain.shell.newTask, () => enMain.shell.newTask],
    ['sidebar', () => zhCNMessages['sidebar.newTask'], () => enUSMessages['sidebar.newTask']],
    ['compose title', () => zhCNMessages['task.newTask'], () => enUSMessages['task.newTask']],
    ['project shortcut', () => zhCNMessages['sidebar.newSession'], () => enUSMessages['sidebar.newSession']],
    ['model recovery', () => zhCNMessages['chat.modelUnavailableNewSession'], () => enUSMessages['chat.modelUnavailableNewSession']],
  ])('%s names the task being created', (_name, chinese, english) => {
    expect(chinese()).toBe('新建任务');
    expect(english()).toBe('New task');
  });

  it('keeps project and machine context in the action label', () => {
    expect(zhCNMessages['sidebar.newSessionIn']).toBe('在 {project} 中新建任务');
    expect(enUSMessages['sidebar.newSessionIn']).toBe('New task in {project}');
    expect(zhSettings.devices.addServer.newTask).toBe('在这台机器上新建任务');
    expect(enSettings.devices.addServer.newTask).toBe('New task on this machine');
  });
});
