import { execFile } from '@gugu/core/local/childProcess';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { enginePidDir, parseEnginePidfile, shouldReapEngineGroup } from '../../../../enginePidReap';
import type { ResourceProcess, ResourceProcessRoot } from './process-accounting';

function output(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { maxBuffer: 20 * 1024 * 1024, timeout: 10_000 }, (error, stdout) => error ? reject(error) : resolve(String(stdout))));
}

export async function listResourceProcesses(): Promise<ResourceProcess[]> {
  if (process.platform === 'win32') {
    throw new Error('Windows process-tree collection needs a native implementation');
  }
  const text = await output('ps', ['-axo', 'pid=,ppid=,command=']);
  return text.split('\n').flatMap(line => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) return [];
    return [{ pid: Number(match[1]), ppid: Number(match[2]), name: basename(match[3].split(/\s+/)[0]), command: match[3] }];
  });
}

/** Include reparented engines only with this main owner and the recorded unique endpoint. Read-only. */
export async function collectLedgerResourceRoots(processes: ResourceProcess[]): Promise<ResourceProcessRoot[]> {
  let names: string[];
  try { names = await readdir(enginePidDir()); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const live = new Map(processes.map(p => [p.pid, p]));
  const roots: ResourceProcessRoot[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    let record;
    try { record = parseEnginePidfile(await readFile(join(enginePidDir(), name), 'utf8')); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
    if (!record || record.ownerMainPid !== process.pid) continue;
    const actual = live.get(record.pgid);
    if (!actual || !shouldReapEngineGroup({ liveCmdline: actual.command ?? '', recordedArgs: record.args, engineId: record.engineId })) continue;
    roots.push({ id: `engine:${record.pgid}`, pid: record.pgid, kind: 'session', sessionId: record.conversationId, label: `${record.engineId} · ${record.conversationId.slice(0, 8)}` });
  }
  return roots;
}
