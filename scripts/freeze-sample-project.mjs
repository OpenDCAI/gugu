#!/usr/bin/env node
// Freezes the bundled sample project (#709) from one real run, so what a new account sees is what a real agent
// did in a real Gugu, not something written by hand. Only the person's words in it were written by a person, and
// they were typed into that run. Not packaged: electron-builder ships dist/ and dist-electron/ only.
//
// What it reads, read-only:
//   - the run's project group on the shared test database (service role from .envs/shared-test.env; it refuses the
//     production host): the task card, the agent's replies to it, and the sha256 the server recorded for each file
//     the agent put in the group folder;
//   - the agent session's turns from the run instance's local database (gugu4.db): what it said on the way, what it
//     searched, which files it wrote and shared;
//   - a copy of the project folder taken right after the run; every file's bytes must match the recorded sha256.
// What it writes: apps/desktop/src/session/renderer/features/sample-project/content/<locale>.ts
//
// The committed content was frozen from these runs on the shared test database, by the onboarding run account
// (its address is recorded in #709's discussion, not here):
//   zh-CN  group 804e1026-fae6-4bc1-bd90-0ede2cdaeac9  session aea0c12d-4be3-4ae5-b026-f0d89884a0a4  (2026-10-28, Codex, gpt-6-luna)
//   en-US  group 952352ea-10ab-4213-84c1-dad7af0585a1  session 97ba576a-9ccc-4aac-8f22-247245f60d45  (2026-10-28, Codex, gpt-6-luna)
// The exact ids and file hashes of each run are written into the header of the file it generates.
//
// Usage:
//   node scripts/freeze-sample-project.mjs --locale zh-CN --session <id> --local-db <user-data>/gugu4.db \
//     --snapshot <copy of the project folder> [--turns 1] [--log <dev log, to record the model>]
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createClient } from '@supabase/supabase-js'

const repo = join(dirname(fileURLToPath(import.meta.url)), '..')
const { parseEnvFile, PRODUCTION_DB_HOST, hostOf } = createRequire(import.meta.url)('./env-registry.cjs')
const LOCALES = ['zh-CN', 'en-US']
const OUT_DIR = join(repo, 'apps/desktop/src/session/renderer/features/sample-project/content')
const TIME_ZONE = 'Asia/Shanghai'

const { values: args } = parseArgs({
  options: {
    locale: { type: 'string' },
    session: { type: 'string' },
    'local-db': { type: 'string' },
    snapshot: { type: 'string' },
    turns: { type: 'string', default: '1' },
    log: { type: 'string' },
  },
})
for (const key of ['locale', 'session', 'local-db', 'snapshot']) if (!args[key]) fail(`--${key} is required`)
if (!LOCALES.includes(args.locale)) fail(`--locale must be one of ${LOCALES.join(', ')}`)
const turnCount = Number(args.turns)
if (!Number.isInteger(turnCount) || turnCount < 1) fail('--turns must be a whole number from 1')

function fail(message) {
  console.error(`freeze-sample-project: ${message}`)
  process.exit(1)
}

const env = parseEnvFile(readFileSync(join(repo, '.envs/shared-test.env'), 'utf8'))
const url = env.GUGU_SUPABASE_URL
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !serviceKey) fail('.envs/shared-test.env needs GUGU_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
if (hostOf(url) === PRODUCTION_DB_HOST) fail('refusing the production database')
const db = (schema) => createClient(url, serviceKey, { auth: { persistSession: false }, db: { schema } })
const chatDb = db('chat')

async function rows(query, what) {
  const { data, error } = await query
  if (error) fail(`reading ${what}: ${error.message}`)
  return data
}

// The session's group and its task card, as the run instance recorded them; its turns: the process is kept only there.
const local = new DatabaseSync(args['local-db'], { readOnly: true })
const session = local.prepare('SELECT config FROM sessions WHERE id = ?').get(args.session)
if (!session) fail(`session ${args.session} is not in ${args['local-db']}`)
const { taskChatId: chatId, initialMessageId } = JSON.parse(session.config)
if (!chatId || !initialMessageId) fail(`session ${args.session} was not started from a task card in a group`)
const [cardRow] = await rows(chatDb.from('messages').select('*').eq('id', initialMessageId).eq('chat_id', chatId), 'the task card')
const card = cardRow?.content_type === 'card' ? { row: cardRow, body: JSON.parse(cardRow.content) } : null
if (card?.body.type !== 'task' || card.body.sessionId !== args.session) fail(`message ${initialMessageId} is not the task card of session ${args.session}`)
const ownerId = card.row.sender_user_id
const agentId = card.body.agentUserId
if (card.body.agentType !== 'codex') fail(`the sample draws a Codex agent; this run's agent is ${card.body.agentType}`)
const [owner] = await rows(db('identity').from('users').select('id, display_name').eq('id', ownerId), 'the owner')
if (!owner?.display_name) fail('the owner has no display name')

const turns = local
  .prepare('SELECT data FROM session_turns WHERE session_id = ? ORDER BY seq LIMIT ?')
  .all(args.session, turnCount)
  .map((row) => JSON.parse(row.data))
local.close()
if (turns.length < turnCount) fail(`session ${args.session} has ${turns.length} finished turn(s) in ${args['local-db']}`)
const endedAt = Math.max(...turns.map((turn) => turn.endedAt))
if (!turns.every((turn) => Number.isFinite(turn.startedAt) && Number.isFinite(turn.endedAt))) fail(`session ${args.session}: a frozen turn has no start or end time`)

// The group's messages from the card until the last frozen turn ended: the card, and what the agent posted.
const messages = (await rows(chatDb.from('messages').select('*').eq('chat_id', chatId).gte('seq', card.row.seq).order('seq'), 'the group messages'))
  .filter((row) => Date.parse(row.created_at) <= endedAt && !row.deleted_at && !row.retracted_at)
if (!messages.some((row) => row.id === card.row.id)) fail('the task card is not among the messages up to the end of the run')

// Files in the frozen messages — posted as file cards, or linked from text: one sample id each, and the bytes that
// match what the server recorded for the version the card or the link carries (the latest one for a bare link).
const FILE_LINK = /gugu-file:\/\/([0-9a-f-]{36})(?:\?v=(\d+))?/gi
const versionOf = new Map()
const pinVersion = (itemId, version) => {
  if (version === undefined) return
  if (versionOf.has(itemId) && versionOf.get(itemId) !== version) fail(`file ${itemId} is shown at versions ${versionOf.get(itemId)} and ${version} in one run`)
  versionOf.set(itemId, version)
}
const itemIds = [...new Set(messages.flatMap((row) => {
  if (row.content_type === 'attachment') return (pinVersion(row.file_item_id, row.file_version), [row.file_item_id])
  return [...String(row.content).matchAll(FILE_LINK)].map(([, id, version]) => (pinVersion(id.toLowerCase(), version === undefined ? undefined : Number(version)), id.toLowerCase()))
}))]
const sampleIdOf = new Map(itemIds.map((itemId, index) => [itemId, `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]))
const files = []
for (const itemId of itemIds) {
  const revisions = await rows(chatDb.from('file_device_revisions').select('version, relative_path, sha256, file_name, content_type').eq('item_id', itemId), `file ${itemId}`)
  if (revisions.length === 0) fail(`file ${itemId} has no recorded revision`)
  const wanted = versionOf.get(itemId)
  const latest = wanted === undefined ? revisions.reduce((a, b) => (b.version > a.version ? b : a)) : revisions.find((revision) => revision.version === wanted)
  if (!latest) fail(`file ${itemId} has no recorded version ${wanted}`)
  const bytes = readFileSync(join(args.snapshot, latest.relative_path))
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== latest.sha256) fail(`${latest.relative_path} in the snapshot is not version ${latest.version} of the group's file (${sha256} ≠ ${latest.sha256})`)
  const mimeType = latest.content_type === 'text/csv' ? 'text/csv' : latest.content_type === 'text/markdown' ? 'text/markdown' : fail(`${latest.file_name}: the sample shows markdown and csv only, not ${latest.content_type}`)
  files.push({ id: sampleIdOf.get(itemId), name: latest.file_name, mimeType, text: bytes.toString('utf8'), sha256, itemId, version: latest.version })
}
const fileNameOf = new Map(files.map((file) => [file.itemId, file.name]))

const time = (at) => new Intl.DateTimeFormat('en-GB', { timeZone: TIME_ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(at))
const relink = (text) => text.replace(FILE_LINK, (_, itemId) => `gugu-file://${sampleIdOf.get(itemId.toLowerCase())}`)
// The owner's name must not be frozen into a sample everyone sees: it may only be the mention the group adds.
const ownerMention = `@${owner.display_name} `
const keyOf = new Map(messages.map((row, index) => [row.id, `m${index + 1}`]))

// The chat's own rule for a time divider (messageRowTime): the first message, or five minutes after the one before.
const dividerAt = (index) => index === 0 || Date.parse(messages[index].created_at) - Date.parse(messages[index - 1].created_at) >= 5 * 60 * 1000
const frozenMessages = messages.map((row, index) => ({ ...(dividerAt(index) ? { divider: true } : {}), ...frozenMessage(row) }))
function frozenMessage(row) {
  const id = keyOf.get(row.id)
  if (row.id === card.row.id) return { id, kind: 'task', time: time(row.created_at), text: card.body.text }
  const from = row.sender_user_id === ownerId ? 'owner' : row.sender_user_id === agentId ? 'agent' : fail(`message ${row.seq} is from someone else`)
  // A project group's files are shared from the owner's computer, so their cards are the owner's: kept as they were.
  if (row.content_type === 'attachment') return { id, kind: 'file', from, time: time(row.created_at), file: sampleIdOf.get(row.file_item_id) }
  if (row.content_type !== 'text') fail(`message ${row.seq} is a ${row.content_type}; the sample shows text, files and the task card only`)
  let text = String(row.content)
  const mentionsOwner = from === 'agent' && (row.to_user_ids ?? []).includes(ownerId) && text.startsWith(ownerMention)
  if (mentionsOwner) text = text.slice(ownerMention.length)
  const replyTo = row.reply_to_message_id ? keyOf.get(row.reply_to_message_id) : undefined
  if (row.reply_to_message_id && !replyTo) fail(`message ${row.seq} replies to a message outside the run`)
  return { id, kind: 'text', from, time: time(row.created_at), text: relink(text), ...(replyTo ? { replyTo } : {}), ...(mentionsOwner ? { mentionsOwner } : {}) }
}

// The process, from the turns: its own words, its searches, the files it wrote and shared, its reply to the group.
// Thinking, tool calls that failed and the other tools it used are left out — fewer lines, none made up.
const steps = []
const push = (step) => {
  const last = steps.at(-1)
  if (last && last.kind === step.kind && step.kind !== 'said' && step.kind !== 'posted') {
    for (const key of ['queries', 'files']) if (step[key]) last[key] = [...new Set([...last[key], ...step[key]])]
  } else if (!(last?.kind === 'posted' && step.kind === 'posted')) steps.push(step)
}
const json = (text) => { try { return JSON.parse(text) } catch { return null } }
const parseGroupFileId = (link) => /^gugu-file:\/\/([0-9a-f-]{36})/.exec(String(link ?? ''))?.[1]
for (const turn of turns) {
  for (const item of turn.items) {
    if (item.kind === 'message' && item.role === 'assistant') {
      const text = item.text.trim()
      if (text && text !== '[NO_REPLY]') push({ kind: 'said', text })
    } else if (item.status !== 'done') continue
    else if (item.kind === 'search-tool-call') {
      const input = json(item.rawInput)
      const queries = input?.action?.queries ?? (input?.query ? [input.query] : [])
      if (queries.length > 0) push({ kind: 'searched', queries })
    } else if (item.kind === 'create-file-tool-call' || item.kind === 'modify-file-tool-call') push({ kind: 'wrote', files: [basename(item.path)] })
    else if (item.kind === 'mcp-tool-call') {
      // A folder App's tool arrives through catalog_call as { tool, args }; a Gugu tool's input is its args.
      const input = json(item.rawInput)
      const tool = input?.tool ?? item.tool
      const output = json(item.outputText)
      if (tool === 'workspace__create' && fileNameOf.has(output?.created?.id)) push({ kind: 'shared', files: [fileNameOf.get(output.created.id)] })
      else if (tool === 'message_send_file' && fileNameOf.has(parseGroupFileId(output?.file))) push({ kind: 'shared', files: [fileNameOf.get(parseGroupFileId(output.file))] })
      else if (tool === 'message_send') push({ kind: 'posted' })
    }
  }
}

const model = args.log
  ? [...readFileSync(args.log, 'utf8').matchAll(/platform model injected into Chat UI session (\{.*\})/g)].map((match) => json(match[1])).find((entry) => entry?.sessionId === args.session)?.model
  : undefined
const content = {
  agent: { name: card.body.agentName, engine: 'codex' },
  messages: frozenMessages,
  files: files.map(({ id, name, mimeType, text, sha256 }) => ({ id, name, mimeType, text, sha256 })),
  task: { startedAt: time(turns[0].startedAt), endedAt: time(endedAt), steps },
}
// Anywhere at all — a message, a line it said, a search, a file's text: the mention is already only a mark.
if (JSON.stringify(content).includes(owner.display_name)) fail(`the frozen run names the owner (${owner.display_name}) beyond the mention`)
const exportName = `${args.locale.replace('-', '')}SampleProject`
const header = [
  `// Generated by scripts/freeze-sample-project.mjs (#709): one real run, frozen. Do not edit by hand — run it again.`,
  `// Run: ${new Date(turns[0].startedAt).toISOString().slice(0, 10)} on the shared test database; group ${chatId}; session ${args.session}` +
    `; ${turnCount} turn(s); agent ${card.body.agentName} (codex${model ? `, ${model}` : ''}).`,
  ...files.map((file) => `// File ${file.name}: group folder item ${file.itemId} version ${file.version}, sha256 ${file.sha256}.`),
]
const out = join(OUT_DIR, `${args.locale}.ts`)
writeFileSync(out, `${header.join('\n')}\nimport type { SampleProjectContent } from './types';\n\nexport const ${exportName}: SampleProjectContent = ${JSON.stringify(content, null, 2)};\n`)
console.log(`wrote ${out}: ${frozenMessages.length} messages, ${files.length} files, ${steps.length} steps`)
