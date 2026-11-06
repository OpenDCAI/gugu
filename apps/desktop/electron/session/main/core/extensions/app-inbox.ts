import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { appInboxUnreadRow, type AppInboxPort, type AppInboxRow } from '@gugu/core/local/agent/appInbox';
import { log } from '@main/lib/logger';
import { extensionPrograms } from './extension-programs';

/**
 * Apps as a source of the agent inbox (`@gugu/core/local/agent/appInbox`): the reader's questions, asked of the App's own
 * program. A program starts on its first call, so only an App the cloud has named as a source is asked on every pull — the
 * names kept across restarts, since what a session could not take yet is read when it can (the reader's boot scan too).
 */

function sourcesFile(): string {
  return path.join(app.getPath('userData'), 'app-inbox-sources.json');
}

let known: Set<string> | null = null;

function sources(): Set<string> {
  if (known) return known;
  let saved: unknown = [];
  try {
    saved = JSON.parse(fs.readFileSync(sourcesFile(), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') log.error('app inbox: the known sources could not be read', { error: String(error) });
  }
  known = new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === 'string') : []);
  return known;
}

function remember(source: string): void {
  const all = sources();
  if (all.has(source)) return;
  all.add(source);
  fs.writeFileSync(sourcesFile(), JSON.stringify([...all]));
}

async function callInboxTool(source: string, name: string, args: Record<string, unknown>): Promise<unknown> {
  const result = await extensionPrograms.callFromPage(source, { server: source, name, arguments: args, from: {} });
  const text = result.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
  if (result.isError) throw new Error(`${source} ${name}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function refusal(source: string): Promise<string | null> {
  const refused = extensionPrograms.agentToolsRefusal(source);
  if (refused) return refused;
  const program = extensionPrograms.installed().find((candidate) => candidate.extensionId === source && candidate.server === source);
  if (!program) return `${source} has no tools module`;
  const tools = await extensionPrograms.tools(program);
  return tools.some((tool) => tool.name === 'inbox_pull') ? null : `${source} takes no agent deliveries in this version`;
}

export const appInbox: AppInboxPort = {
  async refusal(source) {
    remember(source);
    return refusal(source);
  },
  async pull(agentUserId, required) {
    const rows = await Promise.all([...sources()].map(async (source) => {
      try {
        if (await refusal(source)) return [];
        const pulled = await callInboxTool(source, 'inbox_pull', { agent: agentUserId });
        if (!Array.isArray(pulled)) throw new Error(`${source} inbox_pull answered no list`);
        return (pulled as AppInboxRow[]).map((row) => appInboxUnreadRow(source, row));
      } catch (error) {
        if (source === required) throw error;
        log.error('app inbox: an App did not answer; a chat delivery goes on', { source, agentUserId, error: String(error) });
        return [];
      }
    }));
    return rows.flat();
  },
  async ack({ source, agentUserId, key, seq }) {
    await callInboxTool(source, 'inbox_ack', { agent: agentUserId, key, seq });
  },
  async recordFailure({ source, agentUserId, key, command, state, error }) {
    await callInboxTool(source, 'inbox_failed', { agent: agentUserId, ...(key ? { key } : {}), ...(command ? { command } : {}), state, error });
  },
};
