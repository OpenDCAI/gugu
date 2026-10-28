import { db } from '@main/db/client';
import { terminals } from '@main/db/schema';
import type { SessionView } from '@shared/core/sessions/sessions';
import { appSettingsService } from './settings-service';

/**
 * 老用户迁移:「终端」开关第一次被读到、还没定值时,按这台电脑过去的用法算一次。
 * 两条满足任一就开,其余一律关(新装也是关):
 * - 上次在新建框里**手动**选过编程(`newSessionMemory.sessionView` 只有那颗分段控件写过,出厂是 general);
 * - 这台电脑开过 shell 终端页签(`terminals` 表里有行)。
 * ❌ 不看有没有 pty 会话:编程曾是很多 harness 的默认,有 pty 会话不代表这个人想要终端。
 */
export function migratedTerminalEnabled(input: {
  lastPickedView: SessionView;
  hasOpenedShellTerminal: boolean;
}): boolean {
  return input.lastPickedView === 'code' || input.hasOpenedShellTerminal;
}

/** 启动时(设置服务就位之后)跑一次:还没定值就算出来写回;已经定了的一律不动。 */
export async function settleTerminalEnabled(): Promise<boolean> {
  const terminal = await appSettingsService.get('terminal');
  if (terminal.enabled !== null) return terminal.enabled;
  const memory = await appSettingsService.get('newSessionMemory');
  const [anyTerminal] = await db.select({ id: terminals.id }).from(terminals).limit(1);
  const enabled = migratedTerminalEnabled({
    lastPickedView: memory.sessionView,
    hasOpenedShellTerminal: anyTerminal !== undefined,
  });
  await appSettingsService.update('terminal', { ...terminal, enabled });
  return enabled;
}
