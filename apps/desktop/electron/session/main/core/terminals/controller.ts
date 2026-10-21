import { createRPCController } from '@shared/lib/ipc/rpc';
import { createTerminal } from './createTerminal';
import { deleteTerminal } from './deleteTerminal';
import { getAllTerminals } from './getAllTerminals';
import { getTerminalsForSession } from './getTerminalsForSession';
import { getTerminalShellAvailability } from './getTerminalShellAvailability';
import { hydrateTerminal } from './hydrateTerminal';
import { stopLifecycleScriptSession } from './lifecycle-script-coordinator';
import { prepareLifecycleScript } from './prepareLifecycleScript';
import { renameTerminal } from './renameTerminal';
import { runLifecycleScript } from './runLifecycleScript';

export const terminalsController = createRPCController({
  getAllTerminals,
  createTerminal,
  deleteTerminal,
  getTerminalShellAvailability,
  hydrateTerminal,
  prepareLifecycleScript,
  renameTerminal,
  getTerminalsForSession,
  runLifecycleScript,
  stopLifecycleScript: (args: {
    projectId: string;
    workspaceId: string;
    type: 'setup' | 'run' | 'teardown';
  }) => {
    stopLifecycleScriptSession({ ...args, origin: 'manual' });
  },
});
