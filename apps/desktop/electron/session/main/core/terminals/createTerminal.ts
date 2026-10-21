import { eq, sql } from 'drizzle-orm';
import { withCompensation } from '@main/core/utils/compensation';
import { db } from '@main/db/client';
import { terminals } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { TerminalShellId } from '@shared/core/terminals/terminal-settings';
import type { CreateTerminalParams, Terminal } from '@shared/core/terminals/terminals';
import { resolveSession } from '../projects/utils';
import { appSettingsService } from '../settings/settings-service';
import { mapTerminalRowToTerminal } from './core';

async function resolveCreateTerminalShell(
  params: CreateTerminalParams,
  targetKind: 'local' | 'ssh'
): Promise<TerminalShellId> {
  if (params.shell !== undefined) return params.shell;
  if (targetKind !== 'local') return 'system';

  const { defaultShell } = await appSettingsService.get('terminal');
  return defaultShell;
}

export async function createTerminal(params: CreateTerminalParams): Promise<Terminal> {
  const { id: terminalId, initialSize = { cols: 80, rows: 24 } } = params;

  const session = resolveSession(params.projectId, params.sessionId);
  if (!session) {
    throw new Error('Session not mounted');
  }

  const shell = await resolveCreateTerminalShell(params, session.terminals.kind);
  const [row] = await db
    .insert(terminals)
    .values({
      id: terminalId,
      projectId: params.projectId,
      sessionId: params.sessionId,
      name: params.name,
      shellId: shell,
      ssh: 0,
      updatedAt: sql`CURRENT_TIMESTAMP`,
    })
    .returning();

  const terminal = mapTerminalRowToTerminal(row);
  await withCompensation({
    action: () => session.terminals.spawnTerminal(terminal, initialSize, { shell }),
    compensate: async () => {
      await db.delete(terminals).where(eq(terminals.id, row.id)).execute();
    },
    onCompensationError: (error) => {
      log.error('createTerminal: failed to roll back terminal row after spawn failure', {
        terminalId,
        error: error instanceof Error ? error.message : String(error),
      });
    },
  });

  return terminal;
}
