import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { assistantTranscriptState } from '../../../apps/desktop/electron/sessionpage/assistant-context-candidate';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const injected = (content: string) => ({ type: 'attachment', attachment: { type: 'hook_additional_context', content: [content] } });
async function inspect(rows: unknown[]) {
  const root = await mkdtemp(join(tmpdir(), 'assistant-context-')); roots.push(root);
  const file = join(root, 'native.jsonl'); const bytes = rows.map(row => JSON.stringify(row)).join('\n') + '\n';
  await writeFile(file, bytes);
  return assistantTranscriptState(file, ['Managed rule']);
}
it('counts active injected indices once, ignoring rendered mirrors and hook diagnostics', async () => {
  expect((await inspect([injected('<gugu_resource_index>one</gugu_resource_index>'),
    { type: 'api-request-blob', text: '<gugu_resource_index>mirror</gugu_resource_index>' },
    { type: 'attachment', attachment: { type: 'hook_success', stdout: '<gugu_resource_index>diagnostic</gugu_resource_index>' } },
  ])).duplicate).toBe(false);
  expect((await inspect([injected('<gugu_resource_index>one</gugu_resource_index>'), injected('<gugu_resource_index>two</gugu_resource_index>')])).duplicate).toBe(true);
});
it('only detects managed rules that are actually duplicated in active context', async () => {
  expect((await inspect([injected('Managed rule'), injected('Managed rule')])).duplicate).toBe(true);
  expect((await inspect([injected('Managed rule'), injected('Managed rule'), { type: 'system', subtype: 'compact_boundary' }, injected('One current map')])).duplicate).toBe(false);
});
