import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { MachineVerb } from '@shared/extensions/bridge-protocol';
import { HOSTED_PROGRAM_ELSEWHERE, hostsProgram } from '@shared/extensions/program-place';
import { listExtensionData, readExtensionData, writeExtensionData } from '@main/core/extensions/extension-data';
import { extensionDataRoot, extensionsService } from '@main/core/extensions/extensions-root';
import { extensionPrograms } from '@main/core/extensions/extension-programs';

/**
 * The verbs that follow the machine of a page's session (`BRIDGE_VERBS` rows with `machine`), as THIS machine does them:
 * its data folder, its program. One implementation each, called by this machine's bridge for its own pages and by
 * `answerAppCall` for a page on another of the person's machines — whose call is then this machine's, made for that session.
 */
/** Who the call is from: the session of the page, or the agent working it (owner 10-14), as its own tool call would be. */
export type MachineCallFrom = { sessionId?: string } | { agent: string; agentSession?: string };

const text = (value: unknown) => (typeof value === 'string' ? value : '');
const invalid = (message: string) => Object.assign(new Error(message), { code: 'invalid' });

export const machineVerbs = {
  readData: async (extensionId, args) => readExtensionData(extensionDataRoot(extensionId), text(args.path)),
  listData: async (extensionId, args) => listExtensionData(extensionDataRoot(extensionId), text(args.path) || '.'),
  writeData: async (extensionId, args) => {
    if (typeof args.content !== 'string') throw invalid('content must be a string');
    writeExtensionData(extensionDataRoot(extensionId), text(args.path), args.content);
    return undefined;
  },
  callProgram: async (extensionId, args, from) => {
    if (typeof args.name !== 'string') throw invalid('name must be a string');
    const server = typeof args.server === 'string' ? args.server : undefined;
    const toolArgs = args.arguments;
    const hosted = hostsProgram(extensionsService().get(extensionId).manifest, server);
    // Only name, arguments and server are read from the page; the program's `_meta` is the host's.
    const call = extensionPrograms.callFromPage(extensionId, {
      ...(server !== undefined ? { server } : {}),
      name: args.name,
      ...(toolArgs && typeof toolArgs === 'object' && !Array.isArray(toolArgs) ? { arguments: toolArgs as Record<string, unknown> } : {}),
      from,
    });
    // A hosted program whose host this computer does not have (#7293's own words for that one case): refused as a session
    // elsewhere refuses one (`invalid`). Any other failure of it — the browser did not start, say — is that failure.
    return await call.catch((error: unknown): CallToolResult => {
      const message = error instanceof Error ? error.message : String(error);
      const hostMissing = hosted && !(error as { code?: unknown } | null)?.code && message.startsWith('Host capability is unavailable');
      throw hostMissing ? invalid(`${HOSTED_PROGRAM_ELSEWHERE} (${message})`) : error;
    });
  },
} satisfies Record<MachineVerb, (extensionId: string, args: Record<string, unknown>, from: MachineCallFrom) => Promise<unknown>>;
