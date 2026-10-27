// app_* 在宿主这一侧的前后处理(App 体检 10-17 #15 第二步):主进程看到动作之前,宿主以这个 agent 的身份读卡片、
// 判 chat / item;装完、打包之后,把卡片发进群、造数据文件并检测;`device` 指另一台机器时整趟交给那一台。
// 从 acp-engine-utils.ts 搬来 —— 它们用的是宿主的社交上下文(gugu-im-server),所以留在宿主这个包里,❌ 进会话页的 core/extensions。
import { parseGuguLink } from '@gugu/core/shared/ui/guguLink'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { REMOTE_WORKSPACE_CHUNK_BYTES } from '@gugu/session-core/session-record/contract'
import { decodeTypedId } from '@gugu/core/shared/typedId.mjs'
import type { GuguMcpContext } from '../acp-engine-utils'
// @ts-expect-error -- the MCP tool implementation is an untyped ESM module.
import { extensionAttachmentOf, extensionCheckScopeOf, groupDataFileOf, sendExtensionCardOf } from './gugu-im-server.mjs'
import { isExtensionCheckAvailable } from './gugu-extension-tool'
import { INSTALLED_NOT_SHOWN_NOTE } from '../../src/session/shared/extensions/host-actions'
import { typedFileName } from '../../src/session/shared/extensions/app-runtime-protocol'
import { claimTakes } from '../../src/session/shared/extensions/file-openers'
import { FOLDER_PACKAGE_MAX_BYTES } from '../session/main/core/extensions/received-packages'
import { installAgreedOn, InstallRefusedError } from '../../src/session/shared/extensions/install-agreed-on'

/**
 * 一次 app_* 调用在宿主这一侧走完:`device` 指另一台机器就整趟交给那一台;否则先读卡片 / 判 chat 与 item,
 * 交给主进程(`run`),装完、打包之后发卡片、造数据文件。
 */
export async function runAppAction(
  action: unknown,
  context: GuguMcpContext,
  run: (action: unknown) => Promise<unknown>,
  runSession: ((action: unknown) => Promise<unknown>) | undefined,
): Promise<unknown> {
  if ((action as { action?: string }).action === 'manage') return manageResource(action as Record<string, unknown>, context, run, runSession)
  const elsewhere = await installedElsewhere(action, context, run, runSession)
  if (elsewhere !== null) return elsewhere
  // This machine named as device: main's action schema reads no device, so the usual install.
  return withPackedCardSent(await withMessageAttachment(action, context), context, run)
}

/** Existing-device operations carry no archive; confirmation returns to the initiating session. */
async function manageResource(action: Record<string, unknown>, context: GuguMcpContext, run: (action: unknown) => Promise<unknown>, runSession: ((action: unknown) => Promise<unknown>) | undefined) {
  const target = typeof action.url === 'string' ? parseGuguLink(action.url) : null
  if (target?.kind !== 'app-detail') throw new Error('app_manage: pass an App resource URL, not a folder or an App content link')
  if (!target.deviceId) return run(action)
  if (!runSession || context.kind !== 'social' || context.forkOf !== undefined) throw new Error('app_manage: this device URL needs a session with a Gugu identity that can reach your registered devices')
  const machines = await runSession({ action: 'devices' }) as Array<{ device_id: string; label?: string; this_machine?: boolean }>
  const machine = machines.find((row) => row.device_id === target.deviceId)
  if (!machine) throw new Error(`app_manage: device ${target.deviceId} is not registered to your account; obtain a fresh App URL from the intended device`)
  if (machine.this_machine) return run(action)
  const invoke = (consent?: unknown) => runSession({ ...action, action: 'app_manage', device: target.deviceId, ...(consent ? { consent } : {}) })
  if (!action.operation || action.operation === 'read') return invoke()
  const done = await installAgreedOn(
    async (consent) => ({ success: true, data: await invoke(consent) as Handed }),
    async (handed) => {
      const digest = handed.ask!.manifestDigest
      if (handed.asks === false) return { digest }
      const answer = await run({ action: 'ask_install', request: { ...handed.ask, machine: machine.label ?? target.deviceId } }) as { outcome: string; enableIn?: string[] }
      return answer.outcome === 'confirmed' ? { digest, enableIn: answer.enableIn } : { declined: answer.outcome }
    },
  )
  return done && 'declined' in done ? { installed: false, removed: false, outcome: done.declined, device_id: target.deviceId } : { ...done, device_id: target.deviceId }
}

/**
 * What the host reads as this agent before main sees an app_* action:
 * - #6646 `app_install { source_message_id }` becomes an install of that message's attachment;
 * - F5 `app_check { chat_id?, item_id? }` runs only in a chat this agent is in, on a file it may read.
 */
async function withMessageAttachment(action: unknown, context: GuguMcpContext): Promise<unknown> {
  const { action: name, source_message_id: messageId, chat_id: chatId, item_id: itemId } = action as {
    action?: unknown; source_message_id?: unknown; chat_id?: unknown; item_id?: unknown
  }
  if (name === 'check' && (chatId !== undefined || itemId !== undefined)) {
    if (context.kind !== 'social' || context.forkOf !== undefined) {
      throw new Error('app_check: chat_id and item_id need a session with a Gugu identity; leave them out to check the tab on its own')
    }
    const scope = await extensionCheckScopeOf(context, { chatId, itemId })
    return { ...(action as object), chat_id: scope.chatId, ...(scope.itemId ? { item_id: scope.itemId } : {}) }
  }
  if (name !== 'install' || messageId === undefined) return action
  if (context.kind !== 'social' || context.forkOf !== undefined) {
    throw new Error('app_install: source_message_id needs a session with a Gugu identity; pass source_dir instead')
  }
  return { action: 'install_attachment', ...(await extensionAttachmentOf(context, decodeTypedId('msg', messageId, 'source_message_id'))) }
}

/**
 * `app_install { device }` (L4 10-02): installed on that machine of the owner's, which takes the package the way it takes
 * a card's — checked there (#6646). A card's message is read here as this agent; a folder only this machine has goes
 * there as the package app_pack makes, over the device channel itself, part by part (#7290: no storage in between). D-31: the person is asked here, as this agent's approval in its session (wherever they follow it) —
 * that machine hands back what it would ask, and installs only the bytes they agreed to, given where they ticked. Null:
 * no device, or this very machine — the usual install.
 */
async function installedElsewhere(
  action: unknown,
  context: GuguMcpContext,
  run: (action: unknown) => Promise<unknown>,
  runSession: ((action: unknown) => Promise<unknown>) | undefined,
): Promise<unknown> {
  const { device, ...rest } = action as { device?: unknown } & Record<string, unknown>
  if (typeof device !== 'string') return null
  if (!runSession) throw new Error('app_install: device needs a session that reaches your other machines; leave it out to install here')
  const machines = await runSession({ action: 'devices' }) as Array<{ device_id?: string; label?: string; this_machine?: boolean }>
  if (machines.some((row) => row.device_id === device && row.this_machine === true)) return null
  const machine = machines.find((row) => row.device_id === device)?.label ?? device
  if (context.kind !== 'social' || context.forkOf !== undefined) {
    throw new Error('app_install: device needs a session with a Gugu identity — the package goes to that machine as this agent')
  }
  const ready = await withMessageAttachment(rest, context) as { action: string; message_id?: string; source_dir?: string }
  // #7290 A folder of the owner's goes there as a folder (that machine installs it as one, its publisher the person
  // signed in there): packed here, sent there part by part, with the sha256 packed here — that machine installs those
  // bytes or none. A card goes as its message.
  const packed = ready.action === 'install_attachment' ? null : await run({ action: 'pack', source_dir: ready.source_dir }) as Packed
  const upload = packed ? await sendPackage(packed, (part) => runSession({ action: 'app_install', device, package_part: part })) : null
  const { action: _install, source_dir: _folder, ...card } = ready
  const there = { ...card, ...(packed && upload ? { package_upload: upload, package_digest: packed.sha256 } : {}), action: 'app_install', device }
  // The same two steps as installing on another computer from the Apps page (`installAgreedOn`): that machine hands
  // back what it would ask, the person is asked here — as this agent's approval — and only those bytes go in there.
  try {
    const done = await installAgreedOn(
      async (consent) => ({ success: true, data: await runSession({ ...there, consent }) as Handed }),
      async (handed) => {
        const digest = handed.ask!.manifestDigest
        // Nothing to agree to (`asks` false): installed with no question, as here.
        if (handed.asks === false) return { digest }
        const said = await run({ action: 'ask_install', request: { ...handed.ask, machine } }) as { outcome: string; enableIn?: string[] }
        return said.outcome === 'confirmed' ? { digest, ...(said.enableIn ? { enableIn: said.enableIn } : {}) } : { declined: said.outcome }
      },
    )
    if (done && 'declined' in done) return { installed: false, outcome: done.declined, device_id: device }
    return { ...done, device_id: device }
  } catch (error) {
    // E-05 there is that machine's answer, said to the agent as it is — not a failed call.
    if (error instanceof InstallRefusedError) return { ...error.refusal, device_id: device }
    throw error
  }
}

type Handed = { outcome?: string; ask?: { manifestDigest: string } & Record<string, unknown>; asks?: boolean }

/** #7290 A package app_pack made, sent to another machine in order, part by part (the chunks a remote save uses): its upload id. */
async function sendPackage(packed: Packed, send: (part: Record<string, unknown>) => Promise<unknown>): Promise<string> {
  const bytes = await readFile(packed.file_path)
  if (bytes.byteLength > FOLDER_PACKAGE_MAX_BYTES) {
    throw new Error(`app_install: the App package is ${bytes.byteLength} bytes; one goes to another machine up to ${FOLDER_PACKAGE_MAX_BYTES}`)
  }
  const uploadId = randomUUID()
  let offset = 0
  do {
    const part = bytes.subarray(offset, offset + REMOTE_WORKSPACE_CHUNK_BYTES)
    await send({ upload_id: uploadId, offset, total: bytes.byteLength, final: offset + part.length >= bytes.byteLength, data: part.toString('base64') })
    offset += part.length
  } while (offset < bytes.byteLength)
  return uploadId
}

/**
 * F15 `app_pack { chat_id }`: main packs, then the file goes into that chat as an App card, sent as this
 * agent — one call, and the answer carries the message id. Without chat_id the answer is main's, untouched.
 */
async function withPackedCardSent(
  action: unknown,
  context: GuguMcpContext,
  run: (action: unknown) => Promise<unknown>,
): Promise<unknown> {
  const { action: name, chat_id: chatId, source_dir: sourceDir, market } = action as { action?: unknown; chat_id?: unknown; source_dir?: unknown; market?: unknown }
  if ((name !== 'pack' && name !== 'install') || chatId === undefined) return run(action)
  const tool = `app_${name}`
  if (context.kind !== 'social' || context.forkOf !== undefined) {
    throw new Error(`${tool}: chat_id needs a session with a Gugu identity; leave it out, then app_pack and send the file with message_send_file`)
  }
  // F31: message_id goes out bare — the tool layer types it (a typed one here was refused as a double encoding, after
  // the card had gone out). A card of this version already in the chat is answered, not sent again.
  // 摩擦单 F107: one with other bytes means the App changed and its version did not — the version goes up one patch
  // (`bump`, written back into manifest.json), `again` makes that version's archive, and its card is sent.
  // ❗ A side effect that already happened never comes back as an error: an error says "nothing happened", and the
  // agent does it again (L6 S8: four identical cards). Once installed or packed, a card that could not be sent is a
  // sentence in the answer, not a failed call.
  // `again` makes the bumped version's archive; null for an App from the market, whose versions are the market's own.
  const share = async (packed: Packed, again: (() => Promise<Packed>) | null) => {
    const send = (archive: Packed) => sendExtensionCardOf(context, {
      chatId, filePath: archive.file_path, fileName: archive.file_name, sha256: archive.sha256,
    }) as Promise<{ messageId: string; alreadyThere: boolean; differs: boolean | null }>
    let card: Awaited<ReturnType<typeof send>>
    let archive = packed
    let raised: string | null = null
    // What the version did comes first, whatever the second card did (L3's review).
    const up = () => raised
      ? `The chat had a card of ${packed.file_name} with other contents, so the version went up to ${raised} (manifest.json says so now). `
      : ''
    try {
      card = await send(packed)
      if (card.alreadyThere && card.differs === true && again) {
        raised = (await run({ action: 'bump', source_dir: sourceDir }) as { version: string }).version
        archive = await again()
        card = await send(archive)
      }
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      return { packed: archive, message_id: undefined, note: `${up()}The card was not sent (${why}); nothing went into the chat.` }
    }
    const note = !card.alreadyThere
      ? (raised ? `${up()}That version's card was sent.` : null)
      : card.differs === null
        ? `${up()}Already in the chat: it has a card of ${archive.file_name} (message_id); its contents could not be compared, so nothing new was sent.`
        : card.differs
          ? `${up()}The chat has a card of ${archive.file_name} (message_id) with other contents too, so nothing new was sent.`
          : `${up()}Already in the chat: it has this version's card (message_id), so nothing new was sent.`
    return { packed: archive, message_id: card.messageId, note }
  }
  // L7-d: told the others need the card, an agent asked its own owner to install it too — on the computer it was built on.
  const ownerHasIt = 'Your owner does not need the card: app_install already put it on their computer, the one you run on.'
  if (name === 'pack') {
    const { packed, message_id, note } = await share(await run(action) as Packed, async () => await run(action) as Packed)
    return {
      ...packed,
      ...(message_id ? { message_id } : {}),
      next: note ?? `It is in the chat as an App card: the others there install it from the card, or when they open one of its files. ${ownerHasIt}`,
    }
  }
  // S1 rerun: install and share are one step for a chat App — installed here, then packed and sent by the same code
  // app_pack { chat_id } runs. Declined or dismissed: nothing is packed or sent.
  const installed = await run(action) as InstallAnswer
  if (installed.installed !== true) return installed
  // A private chat is a chat like a group (主人 10-05「私聊也是得有面板的」): its data file and card go there the same way.
  // F40 (S2: 8 calls, the time all model round trips) With data, the chat's part is this same call: its data file, the
  // App checked on it, then the card — only when the check is ok, so a chat never gets an App that does not work.
  const { data } = action as { data?: InstallData }
  const prepared = data ? await groupDataFile(installed, data, chatId, context, run) : null
  // F52 main's sentence about a window that has not taken the install in yet stays first, whatever `next` becomes here.
  const lead = installed.window === 'not-confirmed' ? `${INSTALLED_NOT_SHOWN_NOTE} ` : ''
  if (prepared?.refused) {
    return { ...installed, ...prepared.answer, next: `${lead}Installed on your owner's computer, but ${prepared.refused} So the card was not sent.` }
  }
  if (prepared?.check && prepared.check.ok !== true) {
    return {
      ...installed,
      ...prepared.answer,
      next: `${lead}Installed on your owner's computer and the data file is ${prepared.answer.data_file?.link}, but the check ` +
        'found problems (check) — so the card was not sent, and the chat does not get an App that fails. Fix them, ' +
        'then app_install again with the same chat_id and data: the data file is kept.',
    }
  }
  // An App from the market is in no folder of the agent's: the installed copy is packed for the card (App 市场方案 10-07).
  const pack = async () => await run(market !== undefined ? { action: 'pack_installed', id: installed.id } : { action: 'pack', source_dir: sourceDir }) as Packed
  // F107 The bumped version is installed here too, as quietly as any reinstall asking nothing new.
  let current = installed
  const { packed, message_id, note } = await share(await pack(), market !== undefined ? null : async () => {
    current = await run({ action: 'install', source_dir: sourceDir, chat_id: chatId }) as InstallAnswer
    return pack()
  })
  // main's next already says the card is in the chat; when it is not (the card could not be sent), it goes.
  const notSent = message_id === undefined
  const cardNext = note === null ? current.next : notSent ? `${lead}${note}` : `${note} ${current.next ?? ''}`.trim()
  const next = prepared?.answer.data_file && !notSent
    ? `${prepared.check ? 'Checked on it: ok. ' : ''}${cardNext ?? ''} Tell the chat, with the data file's link: ${prepared.answer.data_file.link}`.trim()
    : [prepared?.note, cardNext].filter(Boolean).join(' ')
  return { ...current, ...(prepared?.answer ?? {}), ...(message_id ? { message_id } : {}), file_path: packed.file_path, ...(next ? { next } : {}) }
}

/** What main's `pack` answers (and the host sends as a card). */
type Packed = { file_path: string; file_name: string; sha256: string; version?: string }

type InstallAnswer = {
  installed?: boolean
  id?: string
  next?: string
  /** F52 the window has not taken the install in yet (`INSTALLED_NOT_SHOWN_NOTE` opens `next`). */
  window?: 'not-confirmed'
  tabs?: { tab_kind: string; chat_files?: string[] }[]
}

/** F40 A new data file (`title`, `content`), or — 摩擦单 F102 — `item_id`, a file already in the chat. */
type InstallData = { title: string; content: unknown } | { item_id: string }

/**
 * F40 The chat's data file for a just-installed App — named after the file type it claims — and the App checked on
 * it. The install already happened, so nothing here throws: what could not be done is said (`note`), and what makes
 * the card wrong to send (`refused`: data the App cannot open) keeps it back.
 */
async function groupDataFile(
  installed: InstallAnswer,
  data: InstallData,
  chatId: unknown,
  context: GuguMcpContext,
  run: (action: unknown) => Promise<unknown>,
): Promise<{
  answer: { data_file?: { item_id: string; link: string; reused: boolean }; check?: unknown; pictures?: unknown }
  check?: { ok?: boolean }
  note?: string
  refused?: string
}> {
  const tabs = (installed.tabs ?? []).filter((candidate) => candidate.chat_files?.length)
  if (tabs.length === 0) return { answer: {}, note: 'data was not used: this App opens no chat files, so there is no data file to make.' }
  let tab = tabs[0]!
  let file: { item: { id: string; chat_id: string; filename?: string; content_type?: string | null }; link: string; reused: boolean }
  if ('item_id' in data) {
    // 摩擦单 F102 (S20: a 975 KB catalog copied into the bundle, then into a second file) The data is already in the
    // chat: the App opens that file itself, as 「用 X 打开」 would — only a claim of its name or suffix takes it, and the
    // person's file keeps its name.
    try {
      file = await groupDataFileOf(context, { chatId, itemId: data.item_id })
    } catch (error) {
      return { answer: {}, refused: `its data could not be opened (${error instanceof Error ? error.message : String(error)}).` }
    }
    // Matched as a click in the chat matches it (`typedFileName`): a JSON document titled 「投票」 is `投票.json`.
    const name = typedFileName({ name: file.item.filename ?? '', contentType: file.item.content_type })
    const claiming = tabs.find((candidate) => candidate.chat_files!.some((claim) => claimTakes(claim, name)))
    if (!claiming) {
      const claims = tabs.flatMap((candidate) => candidate.chat_files!).join(', ')
      return {
        answer: { data_file: { item_id: file.item.id, link: file.link, reused: true } },
        refused: `this App does not open ${name} in a chat: it claims ${claims}. Claim that file by its name or its ` +
          `suffix — opens_files {"chat":["${name.toLowerCase()}"]} — app_create again, then app_install with ` +
          'the same data; the file keeps its name.',
      }
    }
    tab = claiming
  } else {
    const suffix = tab.chat_files![0]!
    const name = data.title.endsWith(suffix) ? data.title : `${data.title}${suffix}`
    try {
      file = await groupDataFileOf(context, { chatId, name, content: data.content })
    } catch (error) {
      return { answer: {}, note: `The data file was not made (${error instanceof Error ? error.message : String(error)}).` }
    }
  }
  const dataFile = { item_id: file.item.id, link: file.link, reused: file.reused }
  if (!isExtensionCheckAvailable()) return { answer: { data_file: dataFile } }
  try {
    const { next: _next, pictures, ...check } = await run({ action: 'check', tab_kind: tab.tab_kind, chat_id: file.item.chat_id, item_id: file.item.id }) as { ok?: boolean; next?: string; pictures?: unknown }
    // The check's pictures at the top of the answer, where the tool registrar turns them into images — never inside
    // `check` as base64 text in the agent's context.
    return { answer: { data_file: dataFile, check, ...(pictures ? { pictures } : {}) }, check }
  } catch (error) {
    return { answer: { data_file: dataFile }, note: `The App was not checked (${error instanceof Error ? error.message : String(error)}).` }
  }
}
