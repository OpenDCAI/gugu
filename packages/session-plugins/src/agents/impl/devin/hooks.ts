import {
  buildNestedJsonHookConfig,
  makeNotificationHookCommand,
  makeStdinHookCommand,
} from '@gugu/session-core/agents/plugins/helpers';

export const DEVIN_HOOKS_PATH = '.devin/hooks.v1.json';

// `.devin/hooks.v1.json` 无咕咕归属标记 —— 只有一句「咕咕自建」的**声明**,不是证据。归属存疑时按
// 代价不对称往安全侧倒:误当用户文件顶多是坏了不自愈(devin 新建当前不可达,今天走不到);误当咕咕文件会
// 整份覆盖用户配置(正是 #4604)。⇒ 'user':读不动就抛、绝不覆盖。要升 'gugu-managed' 先拿出处。
export function buildDevinHookConfig() {
  return buildNestedJsonHookConfig(
    DEVIN_HOOKS_PATH,
    [
      { hookKey: 'Stop', command: makeStdinHookCommand('stop') },
      { hookKey: 'SessionEnd', command: makeStdinHookCommand('stop') },
      { hookKey: 'PermissionRequest', command: makeNotificationHookCommand('permission_prompt') },
    ],
    'user'
  );
}
