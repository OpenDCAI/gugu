import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';

/** Read only native active context, never rewrite a provider transcript or its ancestry. */
export async function assistantTranscriptState(path: string, ruleLines: readonly string[]): Promise<{ hash: string; duplicate: boolean }> {
  const digest = createHash('sha256');
  const stream = createReadStream(path);
  stream.on('data', chunk => digest.update(chunk));
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let indices = 0;
  const rules = new Map<string, number>();
  try {
    for await (const line of lines) {
      const row = JSON.parse(line);
      if (row.type === 'system' && row.subtype === 'compact_boundary') { indices = 0; rules.clear(); }
      // hook_success stdout, rendered mirrors and API blobs are diagnostics of the same
      // injection; counting them would manufacture a duplicate that the model never saw.
      if (row.type !== 'attachment' || row.attachment?.type !== 'hook_additional_context') continue;
      const text = JSON.stringify(row.attachment.content);
      indices += text.split('<gugu_resource_index>').length - 1;
      for (const rule of ruleLines) if (text.includes(rule)) rules.set(rule, (rules.get(rule) ?? 0) + 1);
    }
    return { hash: digest.digest('hex'), duplicate: indices > 1 || [...rules.values()].some(count => count > 1) };
  } finally { lines.close(); stream.destroy(); }
}

// Resolve the SDK from the host-selected ACP bridge. The installed bridge owns its
// compatible SDK; neither a global SDK nor a second downloaded runtime is involved.
export const ASSISTANT_CANDIDATE_PROGRAM = String.raw`
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
let input = ''; for await (const chunk of process.stdin) input += chunk;
const p = JSON.parse(input);
const { query, getSessionMessages } = await import(pathToFileURL(createRequire(p.adapter).resolve('@anthropic-ai/claude-agent-sdk')).href);
const abort = new AbortController();
process.once('SIGTERM', () => abort.abort());
const deadline = setTimeout(() => abort.abort(), Math.max(0, p.deadline - Date.now()));
let q;
try {
  if (!p.candidate || p.candidate === p.source) throw Error('Candidate identity must be reserved before copying');
  let compacted = false;
  q = query({ prompt: '/compact 仅保留主人需求、已确认决定、任务结果、未决约束及其来源。系统规则和资源索引由宿主另行提供，不属于主人需求，不应进入摘要。', options: {
    ...p.options, cwd: p.cwd, resume: p.source, forkSession: true, sessionId: p.candidate, persistSession: true, abortController: abort,
    tools: [], mcpServers: {}, strictMcpConfig: true, maxTurns: 1,
    pathToClaudeCodeExecutable: p.executable, env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' },
  } });
  for await (const event of q) {
    if (event.type === 'system' && event.subtype === 'init' && event.session_id !== p.candidate) throw Error('Native fork returned an unexpected identity');
    if (event.type === 'system' && event.subtype === 'compact_boundary') compacted = true;
    if (event.type === 'result' && event.is_error) throw Error('Native candidate compaction failed');
  }
  if (!compacted) throw Error('Native compaction produced no boundary');
  const history = await getSessionMessages(p.candidate, { dir: p.cwd });
  const visible = JSON.stringify(history.filter(row => !row.isCompletedLocalCommand));
  if (visible.includes('<gugu_resource_index>') || p.rules.some(rule => visible.includes(rule))) {
    throw Error('Candidate summary retained managed indices or rules');
  }
  const transcript = await readFile(join(dirname(p.sourcePath), p.candidate + '.jsonl'), 'utf8');
  let recovered = '';
  for (const line of transcript.split('\n').filter(Boolean)) {
    const row = JSON.parse(line);
    if (row.type === 'system' && row.subtype === 'compact_boundary') recovered = '';
    if (row.type === 'attachment' && row.attachment?.type === 'hook_additional_context') recovered += JSON.stringify(row.attachment.content);
  }
  if (!p.references.every(ref => recovered.includes(ref) || visible.includes(ref))) throw Error('Candidate did not restore all pending references');
  console.log(JSON.stringify({ candidate: p.candidate, compacted, verified: true }));
} catch (error) {
  console.log(JSON.stringify({ error: error instanceof Error ? error.message : 'Native candidate failed' })); process.exitCode = 1;
} finally { clearTimeout(deadline); q?.close(); }
`;

export async function createAssistantContextCandidate(input: {
  node: string; adapter: string; executable: string; source: string; sourcePath: string; candidate: string;
  cwd: string; options: Record<string, unknown>; env: NodeJS.ProcessEnv; rules: readonly string[]; references: string[];
}, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(input.node, ['--input-type=module', '--eval', ASSISTANT_CANDIDATE_PROGRAM], {
      cwd: input.cwd, env: input.env, stdio: ['pipe', 'pipe', 'pipe'], signal,
    });
    let stdout = ''; let stderrBytes = 0;
    child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 64_000) child.kill('SIGTERM'); });
    // Provider stderr can contain credentials; report only the presence of diagnostics.
    child.stderr.on('data', chunk => { stderrBytes += chunk.length; });
    child.on('error', reject);
    child.on('close', code => {
      try {
        const result = JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}');
        if (code !== 0 || !result.verified || result.candidate !== input.candidate) {
          throw new Error(result.error ?? `Native candidate exited ${code}; diagnostic bytes=${stderrBytes}`);
        }
        resolve(result.candidate);
      } catch (error) { reject(error); }
    });
    const { env: _env, node: _node, ...payload } = input;
    child.stdin.on('error', reject);
    child.stdin.end(JSON.stringify({ ...payload, deadline: Date.now() + 35_000 }));
  });
}
