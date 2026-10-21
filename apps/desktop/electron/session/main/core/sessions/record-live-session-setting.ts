import { eq } from 'drizzle-orm';
import {
  canRepresentPermissionMode,
  classifyProviderPermissionMode,
  type GuguPermissionMode,
} from '@gugu/session-core/acp';
import { getPlugin } from '@main/core/agents/plugin-registry';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import type { Session } from '@shared/core/sessions/sessions';

/**
 * 会话**中途**改的一项设置,且 provider **已经确认生效**(`LiveSettingResult.status === 'applied'`)。
 *
 * - `permission`:`modeId` 是 provider 自己的原生档 id(确认回来的 `effectiveValue`),
 *   在这里归到咕咕四档再落库 —— 记录里存的是四档,不是某一家的方言。
 * - 模型不在这里:它有计费路那一半要一起写,归 `recordLiveModelSwitch`(#6182)。
 * - `effort`:原样存。
 */
export type LiveSessionSetting =
  | { dimension: 'permission'; modeId: string }
  | { dimension: 'effort'; value: string };

/**
 * 把用户在活会话上改过、且 provider 已确认的设置**写回会话记录**。
 *
 * ## 为什么必须有这一步
 *
 * 活会话上的设置只活在 provider 进程里;每次重开(app 重启、进程重拉、重载)时,两条启动路
 * (渲染层 `_startInput`、主进程 `acpStartInputFor`)读的都是**会话记录**,运行时
 * `applyConfiguredPermissionMode` / `applyInitialModel` 在 `session/load` 上照样把它重新下发。
 * 记录不跟上 ⇒ 重开后**悄悄回到建会话时那一档**。权限这一维最危险:用户中途从「完全访问」
 * 收紧到「只读」,重开后又被放回完全访问 —— 比他最后一次选的更松,而界面不会说。
 *
 * ## ❌ 不乐观写
 *
 * 只由「provider 回了 applied」的调用方来调。`pending_next_turn` / `restart_required` /
 * 失败都不是事实:把没生效的值写进记录,重开后记录说 A、上一段实际跑的是 B。
 * 唯一的例外是**停下的会话**(#7342,渲染层 `setMode` 在没有进程、也不在起时):那时没有在跑的那一段可以
 * 说「实际是 B」,记录本身就是下一次起的那一档 —— 写它不是乐观,是这一维唯一的事实。
 * `restart_required` 那条路由宿主的重载自己先写记录(`reloadEmdashSession`),不经这里。
 *
 * ## 读-改-写,只动相关的键
 *
 * `config` 里同住着 firstUtterance / mcp 开关等事实,整份覆盖会把它们抹掉(与
 * `set-session-mcp-servers` 同一条纪律)。
 */
export async function recordLiveSessionSetting(
  sessionId: string,
  setting: LiveSessionSetting
): Promise<void> {
  // ⚠️ 读与写在同一个**同步**事务里:权限档与思考档是两个控件,连着改两下时,两次调用若各自
  //    `await` 读再写,后写的那次会拿过期的 config 把前一次刚落的那一维盖掉 —— 正是这个函数要防的回退。
  const written = db.transaction((tx) => {
    const row = tx
      .select({
        projectId: sessions.projectId,
        provider: sessions.provider,
        config: sessions.config,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1)
      .get();
    if (!row) throw new Error(`Session not found: ${sessionId}`);
    const current = row.config;
    if (!current || typeof current !== 'object') {
      throw new Error(`Session ${sessionId} has no config to record the live ${setting.dimension} change`);
    }

    // ⚠️ 补丁走 Record 再展开 —— `config` 列是 pty | acp 的联合,理由同 set-session-mcp-servers。
    const changes: Partial<Pick<Session, 'permissionMode' | 'effort'>> = {};
    if (setting.dimension === 'permission') {
      const permissionMode = permissionModeForProviderMode(row.provider, setting.modeId);
      if (!permissionMode) {
        // 这个原生档代表不了它被归到的那一档(claude 的 `auto` 这类咕咕故意不映射的档)。
        // 硬归一档写进去,重开时会切到**另一个** id —— 那不是用户选的东西。响亮记一行,不写。
        log.warn('recordLiveSessionSetting: provider mode has no Gugu permission rung; record left unchanged', {
          sessionId,
          provider: row.provider,
          modeId: setting.modeId,
        });
        return null;
      }
      changes.permissionMode = permissionMode;
    } else {
      changes.effort = setting.value;
    }

    const next: Record<string, unknown> = { ...current, ...changes };
    tx.update(sessions)
      .set({ config: next as typeof current })
      .where(eq(sessions.id, sessionId))
      .run();
    return { row, changes };
  });
  if (!written) return;
  const { row, changes } = written;

  events.emit(sessionChangedChannel, {
    sessionId,
    projectId: row.projectId,
    // 渲染层手里那份 Conversation 也要跟上 —— 渲染层自己的启动路读的是它,不是库。
    changes,
  });
}

/** provider 原生档 id → 咕咕四档;该 id 代表不了它归到的那一档时返回 null。 */
function permissionModeForProviderMode(provider: string | null, modeId: string): GuguPermissionMode | null {
  let modeMap;
  try {
    // provider 缺席/未知 ⇒ 没有声明表,退回按名字归类(与运行时同一条回落)。
    const autoApprove = provider ? getPlugin(provider).capabilities.autoApprove : undefined;
    modeMap = autoApprove?.kind === 'supported' ? autoApprove.modes : undefined;
  } catch {
    modeMap = undefined;
  }
  const mode = classifyProviderPermissionMode(modeId, modeMap);
  return canRepresentPermissionMode(modeId, mode, modeMap) ? mode : null;
}
