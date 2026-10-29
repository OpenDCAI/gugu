import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { CallToolResult, Progress, ServerNotification, ServerRequest, Tool } from '@modelcontextprotocol/sdk/types.js'
import type { AcpMcpServer } from './acp-engine-utils'
import { extensionServerName, type ExtensionSessionMcp } from './extension-session-mcp'
import { GuguMcpHost, type GuguMcpHostPersistence } from './gugu-mcp-host'
import type { ExtensionSkill } from '@gugu/session-core/agents/plugins'
import type { CatalogTool } from './mcp/gugu-catalog-tools'
import type { AppSearchHit } from './mcp/gugu-app-search-tool'
import type { CloudMarketEntry } from '@shared/extensions/market'
import type { ExtensionManifest } from '@shared/extensions/manifest'
import { claimedSuffixes, extensionTabKind } from '@shared/extensions/manifest'
import { declaredPermissions } from './session/main/core/extensions/extension-authoring'
import { compatRefusal } from './session/main/core/extensions/market-catalog'
import {
  agentAddress,
  agentToolsOf,
  callerMeta,
  handedAs,
  programFailureReason,
  toolVisibleTo,
  type Caller,
  type CallerSessionContext,
  type ExtensionProgram,
  type ExtensionPrograms,
} from './session/main/core/extensions/extension-programs'

/**
 * The extension gateway (Refs #6615): sessions reach extension programs only through here; gugu runs
 * the programs (extension-programs.ts), one copy shared by every session.
 *
 * Invariants:
 * - One entry per session per program, own address and bearer, under the name the program always had.
 * - Every call is checked against the extension's permissions now, not at session start, and goes to
 *   the version installed now: an upgrade reaches running sessions at their next call.
 * - The program learns the calling session only from the `_meta` keys below, written here on every
 *   call; nothing the agent puts in `_meta` reaches the program.
 * - A tool whose MCP Apps visibility has no `model` is its extension's pages' alone: not listed, not callable.
 */

export interface ExtensionGatewayContext {
  ownerUserId: string
  subjectId: string
  /** The session this entry belongs to (its grant key): whose App scope it answers by (D-30). */
  session: string
  /** The session's id — the `agentId` the extension's pages see in `listAgents`. */
  agentId: string | undefined
  /** Which program this entry is for; the version is looked up on every call. */
  program: ExtensionProgram
}

export type ExtensionGatewayHost = GuguMcpHost<ExtensionGatewayContext>

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>

/** What the gateway reads besides the programs: where the calling session works. */
export interface GatewayReaders {
  sessionContext?: CallerSessionContext
}

const refused = (text: string): CallToolResult => ({ content: [{ type: 'text', text }], isError: true })

/**
 * D-30 (主人 10-06「肯定是能选的啊」): per session (its grant key), whether an App's tools are this agent's — what its owner chose
 * for this computer and the chats it is in, read at every ask (main: `inAppScope`). Every listing and call of an App's tools
 * asks it, natively or through the catalog. A session the session bundle never set up (no owner choosing for it) has every
 * App, as everyone does before a choice.
 */
const scopes = new Map<string, (extensionId: string) => Promise<boolean>>()
export function setSessionAppScope(session: string, inScope: (extensionId: string) => Promise<boolean>): void {
  scopes.set(session, inScope)
}
/** Its session is gone (main revokes its grant then): the scope goes too, or the table only grows. */
export function forgetSessionAppScope(session: string): void {
  scopes.delete(session)
}
export async function inScopeOf(session: string, extensionId: string): Promise<boolean> {
  const inScope = scopes.get(session)
  return inScope ? inScope(extensionId) : true
}

/**
 * App architecture §4.1: whether an App's tools reach this session now — the one answer every listing and call reads (native
 * tools/list and tools/call, the catalog, app_search, skills). Refused first (not installed, switched off, `agents:tools` taken
 * back, a broken configuration: `agentToolsRefusal`, with its words), then given to this agent (D-30, `inScopeOf`).
 */
export type AppAccess = { ok: true } | { ok: false; state: 'refused' | 'not_given'; next: string }
export async function appAccess(programs: Pick<ExtensionPrograms, 'agentToolsRefusal'>, session: string | undefined, extensionId: string): Promise<AppAccess> {
  const refusal = programs.agentToolsRefusal(extensionId)
  if (refusal) return { ok: false, state: 'refused', next: refusal }
  if (session && !(await inScopeOf(session, extensionId))) return { ok: false, state: 'not_given', next: NOT_GIVEN([extensionId]) }
  return { ok: true }
}
/** Said once for all the Apps left out so (A-B 10-06: one sentence per App ran three times over). */
export const NOT_GIVEN = (extensionIds: readonly string[]) =>
  `${extensionIds.length === 1 ? `App ${extensionIds[0]} is` : `Apps ${extensionIds.join(', ')} are`} not given to this agent: ` +
  "its owner picks which agents get an App's tools (the App's row in 「App」), and once it is given they are here at the next call"

/** Said on the row of an App the person switched off: who switches it back on, and where — words the agent can pass on as they are. */
export const SWITCHED_OFF = (name: string) =>
  `Switched off on this computer. You cannot switch it on: ask your owner to open 「App」 in 咕咕, open ${name} there and press 「启用」 (Turn on); ` +
  'once it is on, app_search finds it on and catalog_list lists what it gives you'

/** An installed App as the catalog reads it (main: the App contributions): what an agent's app_search says about it. */
export interface CatalogInstalledApp {
  manifest: ExtensionManifest
  enabled: boolean
  /** It brings agents tools or a skill: only then can it be refused to them. */
  givesAgents: boolean
}

/** What an App that is on gives the agent, and where it is: its tools and skill in the catalog, its tabs by tab_kind. */
function onApp(app: CatalogInstalledApp): Pick<AppSearchHit, 'state' | 'next' | 'tabs'> {
  const { id, contributes } = app.manifest
  return {
    state: 'on',
    next: (app.givesAgents
      ? `catalog_list { name: "${id}" } lists its tools and skill`
      : 'It gives agents no tools: open one of its tabs with session_open_in_tab { app_tab }') +
      // 5-minute game rounds 2-3 (10-29): 「on」 was read as 「in this chat」 for a chat App made in another chat; A/B r02: told
      // only what the call does, the agent asked first — a person asking for it in a chat is the go-ahead.
      (contributes.tabs.some((tab) => claimedSuffixes(tab, 'chat').length > 0)
        ? `. It is on your owner's computer only, in no chat yet. Asked for in a chat, call app_install { app: "${id}", chat_id: <that chat>, data } now, without asking first — the request is the go-ahead; it adds the data file, checks it and posts the card`
        : '') +
      '. For a feature its tools or tabs do not provide, read guide_read apps-fork and ask "Shall I fork a version?" before making changes or building a workaround.',
    tabs: contributes.tabs.map((tab) => extensionTabKind(id, tab.name)),
  }
}

/** A market App not installed here, as its app_search row: how to install it, or why this computer cannot. */
function marketApp(entry: CloudMarketEntry & { firstPublishedAt: string }): AppSearchHit {
  const { id } = entry.manifest
  const asks = declaredPermissions(entry.manifest)
  return {
    manifest: entry.manifest,
    version: entry.version,
    publishedAt: entry.publishedAt,
    firstPublishedAt: entry.firstPublishedAt,
    state: 'market',
    next: entry.compat
      ? `Not installed, and this computer cannot install it: ${compatRefusal(id, entry.version, entry.compat)}`
      : `Not installed: catalog_call app_install { market: "${id}" } installs it from the market` +
        // 10-19 G: 「…so your owner confirms in your session first」 was read as «ask in the chat before calling»; the call is the ask.
        (asks.length > 0 ? ` — the call itself asks your owner to confirm ${asks.join(', ')} before anything is installed` : ', without asking anyone'),
  }
}

/**
 * One call into a program, native or through the catalog: permissions read now, the caller stamped, handed files
 * checked as the caller, progress passed back.
 */
async function callProgram(programs: ExtensionPrograms, program: ExtensionProgram, caller: Caller, name: string,
  args: Record<string, unknown> | undefined, extra: Extra, signal: AbortSignal, readers: GatewayReaders): Promise<CallToolResult> {
  const refusal = programs.agentToolsRefusal(program.extensionId)
  if (refusal) return refused(refusal)
  const tool = (await programs.tools(program)).find((candidate) => candidate.name === name)
  if (tool && !toolVisibleTo(tool, 'model')) return refused(`tool ${name} is for the App's own pages only`)
  let given: Awaited<ReturnType<typeof handedAs>>
  try {
    given = await handedAs(programs, agentAddress(caller.agentUserId)?.slice('user:'.length), tool, name, args)
  } catch (error) {
    return refused(error instanceof Error ? error.message : String(error))
  }
  const progressToken = extra._meta?.progressToken
  const onprogress = progressToken === undefined ? undefined : (progress: Progress) =>
    void extra.sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken } })
  const _meta = await callerMeta(caller, readers.sessionContext)
  return programs.call(program, { name, arguments: given.args, _meta }, {
    signal, onprogress, agent: agentAddress(caller.agentUserId)?.slice('user:'.length), handed: given.handed, handedChats: given.handedChats,
  })
}

/**
 * Extension tools a session reaches through catalog_* (D-10): every allowed extension, under the names native
 * entries use, at the version installed now. Read live, so an extension installed or upgraded mid-session is
 * there at once. An extension the session lists natively is callable here too, but not listed.
 */
export function createExtensionCatalog(deps: {
  programs: () => ExtensionPrograms
  onProblem: (message: string) => void
  sessionContext?: CallerSessionContext
  /** The skills installed Apps bring now (#6387), read at every listing like the programs. */
  skills?: () => readonly ExtensionSkill[]
  /** Every App installed now, those that give agents nothing and those switched off too. */
  apps: () => readonly CatalogInstalledApp[]
  /** The market's Apps, from the index in hand (main: `cloudExtensionMarket().entries()`). */
  market: () => Promise<readonly (CloudMarketEntry & { firstPublishedAt: string })[]>
}) {
  const native = new Map<string, Set<string>>()
  /** #6634 问题 16 Why each program whose tools/list failed at its last listing is not in the catalog; gone once it lists. */
  const leftOut = new Map<string, { program: ExtensionProgram; reason: string }>()
  /**
   * One program's tool list now (kept by version, so asked once), and why it is left out when it is: its listing failed,
   * or it answered with no tool for agents — before, such a program vanished without a word (10-19: 全能搜索 without a
   * search key). Either way the program's own words about itself follow, when it gave any.
   */
  const listProgram = async (programs: ExtensionPrograms, program: ExtensionProgram): Promise<Tool[]> => {
    const key = `${program.extensionId}/${program.server}`
    const itSays = () => {
      const said = programs.instructions(program)
      return said ? `; it says: ${said}` : ''
    }
    return programs.tools(program).then((list) => {
      if (list.some((tool) => toolVisibleTo(tool, 'model'))) leftOut.delete(key)
      else leftOut.set(key, { program, reason: `gives agents no tools right now${itSays() || "; its page in 「App」 shows how it is set up"}` })
      return list
    }, (error: unknown) => {
      leftOut.set(key, { program, reason: programFailureReason(program, error) + itSays() })
      deps.onProblem(`extension ${program.extensionId}: program ${program.server} left out of the catalog: ${(error as Error).message}`)
      return []
    })
  }
  /**
   * Programs listed side by side, as agents call their tools (`<App id>__<tool>`, 摩擦单 F119); a name two programs of
   * one App give is left out, naming both. What a listing and an App's state both read.
   */
  const listPrograms = async (programs: ExtensionPrograms, asked: readonly ExtensionProgram[]) => {
    const listed = await Promise.all(asked.map(async (program) => ({ program, tools: await listProgram(programs, program) })))
    const given = agentToolsOf(listed)
    for (const { programs: givers, why } of given.clashes) {
      for (const program of givers) leftOut.set(`${program.extensionId}/${program.server}`, { program, reason: why })
      deps.onProblem(`extension ${givers[0]!.extensionId}: ${why}`)
    }
    return given.tools
  }
  return {
    /** A session (re)starts: the extensions it lists natively now. */
    listedNatively(session: string, extensionIds: readonly string[]): void {
      native.set(session, new Set(extensionIds))
    },
    /**
     * The skills of the Apps this session reaches now, by the same rule as their tools: an App that may give tools and
     * is given to this agent (D-30). An App installed after the session opened is found here, its skill with its tools.
     * Every one is listed, also those the opening already gave: a resumed session is not given its platform block again.
     */
    async skills(session: string): Promise<ExtensionSkill[]> {
      const programs = deps.programs()
      const found: ExtensionSkill[] = []
      for (const skill of deps.skills?.() ?? []) {
        if ((await appAccess(programs, session, skill.extensionId)).ok) found.push(skill)
      }
      return found
    },
    /**
     * Every installed App with what this session can do with it now, read like the programs: off (the person's switch),
     * refused agents (its permissions, a broken configuration), not given to this agent (D-30), a program that does not
     * list or gives agents nothing, or on. `withMarket` adds the market's Apps not installed here; a market not reached is
     * said, never dropped. An App's programs are asked here (side by side), so its state never waits on a listing before it.
     */
    async apps(session: string | undefined, withMarket: boolean): Promise<{ apps: AppSearchHit[]; market?: string }> {
      const programs = deps.programs()
      const installed = deps.apps()
      const stateOf = async (app: CatalogInstalledApp): Promise<Pick<AppSearchHit, 'state' | 'next' | 'tabs'>> => {
        const id = app.manifest.id
        if (!app.enabled) return { state: 'off', next: SWITCHED_OFF(app.manifest.name) }
        if (!app.givesAgents) return onApp(app)
        const access = await appAccess(programs, session, id)
        if (!access.ok) return { state: access.state === 'refused' ? 'unavailable' : 'not_given', next: access.next }
        const own = programs.installed().filter((program) => program.extensionId === id)
        await listPrograms(programs, own)
        const failed = own.flatMap((program) => {
          const left = leftOut.get(`${program.extensionId}/${program.server}`)
          return left ? [`program ${program.server}: ${left.reason}`] : []
        })
        return failed.length > 0 ? { state: 'unavailable', next: failed.join('; ') } : onApp(app)
      }
      const apps: AppSearchHit[] = await Promise.all(installed.map(async (app) => ({ manifest: app.manifest, version: app.manifest.version, ...(await stateOf(app)) })))
      if (!withMarket) return { apps }
      try {
        const market = await deps.market()
        // An installed App the market carries sorts by the market's dates too (newest / updated).
        const dated = new Map(market.map((entry) => [entry.manifest.id, { publishedAt: entry.publishedAt, firstPublishedAt: entry.firstPublishedAt }]))
        const offered = market.filter((entry) => !entry.deprecated && !installed.some((app) => app.manifest.id === entry.manifest.id))
        return { apps: [...apps.map((app) => ({ ...app, ...dated.get(app.manifest.id) })), ...offered.map(marketApp)] }
      } catch (error) {
        return { apps, market: `not reached (${error instanceof Error ? error.message : String(error)}); only the Apps installed here were searched` }
      }
    },
    /**
     * `agentId` is the calling session here, `agentUserId` its agent's gugu id (`_meta['gugu/agent']`). The programs start
     * side by side, so one slow to answer delays the listing by its own wait, not by every one's in turn; with `name`, only
     * the App that name belongs to (`<App id>__<tool>`) is asked.
     */
    async tools(session: string, agentId: string | undefined, agentUserId?: string, name?: string): Promise<CatalogTool[]> {
      const programs = deps.programs()
      const candidates = programs.installed().filter((program) => !name || name.startsWith(`${program.extensionId}__`))
      const given = await Promise.all(candidates.map(async (program) => (await appAccess(programs, session, program.extensionId)).ok))
      const tools = await listPrograms(programs, candidates.filter((_, at) => given[at]))
      return tools.map(({ name, program, tool }) => ({
        name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema,
        ...(tool.annotations ? { annotations: tool.annotations } : {}),
        ...(native.get(session)?.has(program.extensionId) ? { listed: false as const } : {}),
        run: (args, extra) => callProgram(programs, program, { agentId, agentUserId }, tool.name, args as Record<string, unknown>, extra, extra.signal, deps),
      }))
    },
  }
}

export function createExtensionGatewayHost(
  programs: () => ExtensionPrograms,
  persistence?: GuguMcpHostPersistence,
  readers: GatewayReaders = {},
): ExtensionGatewayHost {
  /** The installed version of this entry's program; undefined once the extension no longer ships it. */
  const installed = (entry: ExtensionProgram) =>
    programs().installed().find((program) => program.extensionId === entry.extensionId && program.server === entry.server)
  return new GuguMcpHost<ExtensionGatewayContext>(
    (getContext, grantSignal, trackRequest) => {
      const { program } = getContext()
      const server = new McpServer(
        { name: extensionServerName(program.extensionId, program.server), version: '0.1.0' },
        { capabilities: { tools: {} } },
      )
      server.server.setRequestHandler(ListToolsRequestSchema, () => {
        const { program: entry, session } = getContext()
        // A refused App's program is not started just to be listed; nor one not given to this agent (D-30).
        const tools = appAccess(programs(), session, entry.extensionId).then((access) => {
          const current = access.ok ? installed(entry) : undefined
          return current ? programs().tools(current) : []
        })
        return trackRequest(tools.then((list) => ({ tools: list.filter((tool) => toolVisibleTo(tool, 'model')) })), 'tools/list')
      })
      server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const { program: entry, agentId, subjectId, session } = getContext()
        const { name, arguments: args } = request.params
        const access = await appAccess(programs(), session, entry.extensionId)
        if (!access.ok) return refused(access.next)
        const current = installed(entry)
        if (!current) return refused(`App ${entry.extensionId} no longer ships program ${entry.server}`)
        return trackRequest(callProgram(programs(), current, { agentId, agentUserId: subjectId }, name, args, extra, AbortSignal.any([grantSignal, extra.signal]), readers), name)
      })
      return server
    },
    (context) => ({
      ownerId: context.ownerUserId,
      subjectId: context.subjectId,
      toolScope: `extension:${context.program.extensionId}/${context.program.server}`,
    }),
    persistence,
  )
}

/** This session's gateway entries, one per program; a program that cannot be granted is left out, loudly. */
export async function buildExtensionGateway(
  host: ExtensionGatewayHost,
  session: { grantKey: string; ownerUserId: string; subjectId: string; agentId?: string },
  programs: readonly ExtensionProgram[],
  onProblem: (message: string) => void,
): Promise<Omit<ExtensionSessionMcp, 'skills' | 'apps'>> {
  const servers: AcpMcpServer[] = []
  const origins: ExtensionSessionMcp['origins'] = []
  if (programs.length > 0) await host.start()
  for (const program of programs) {
    const name = extensionServerName(program.extensionId, program.server)
    try {
      const { ownerUserId, subjectId, agentId } = session
      const grant = await host.grant(`${session.grantKey}:${name}`, { ownerUserId, subjectId, agentId, program, session: session.grantKey })
      const headers = [{ name: 'Authorization', value: `Bearer ${grant.capability}` }]
      // Same tier as a connected service: delivered by gugu, varies with what is installed. Only Apps the person chose
      // to list up front come here, so their tools go straight on the model's table (`alwaysLoad`), as a connected
      // service's do — never behind a harness's own deferral (codex code mode, 10-06).
      servers.push({ name, transport: 'http', url: grant.url, headers, alwaysLoad: true, owner: 'integration' })
      origins.push({ name, extensionId: program.extensionId })
    } catch (error) {
      onProblem(`extension ${program.extensionId}: program ${program.server} left out of the session: ${(error as Error).message}`)
    }
  }
  return { servers, origins }
}
