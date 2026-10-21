import { type TerminalRow } from '@main/db/schema';
import { type Terminal } from '@shared/core/terminals/terminals';

export function mapTerminalRowToTerminal(row: TerminalRow): Terminal {
  return {
    id: row.id,
    ssh: row.ssh === 1,
    projectId: row.projectId,
    sessionId: row.sessionId,
    shellId: row.shellId,
    name: row.name,
  };
}
