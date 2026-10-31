import { existsSync, readdirSync, readFileSync, type Dirent } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import type { ExtensionSkill } from '@gugu/session-core/agents/plugins'
import type { AcpMcpServer } from './acp-engine-utils'
import type { ExtensionProgram } from './session/main/core/extensions/extension-programs'
import { resolvesInside } from './session/main/core/extensions/path-containment'
import { hostProgramLine, programName } from '@shared/extensions/manifest'

/**
 * What installed extensions give every agent session: their own MCP programs (and skills,
 * see `skills`). Refs #6387 — owner 2026-09-24 chose option B: an extension may ship a local
 * program as an MCP server, injected into sessions like any other.
 *
 * The task side reports the facts (which extensions are enabled and allowed, where they
 * live); this module turns them into the programs gugu runs (extension-programs.ts) and the
 * skills sessions read. Kept pure so every rule below is testable without Electron.
 */

export interface ExtensionAgentContribution {
  extensionId: string
  /** The manifest's base `name` and its `contributes.instructions`: the App's line in `<gugu_apps>`. */
  name: string
  instructions?: string
  rootDir: string
  dataDir: string
  /** Manifest digest: which version of the extension these programs are. */
  digest: string
  settings?: Record<string, string | boolean>
  settingsInvalid?: true
  /** `full`: its tools are listed natively when a session starts; `progressive`: reached through the catalog. */
  disclosure: 'full' | 'progressive'
  servers: readonly (
    | { name: string; command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> }
    /** F77 A tools module of the bundle, served as MCP by gugu's own runtime; named after its App (F119). */
    | { tools: string; env?: Readonly<Record<string, string>> }
    | { name: string; host: 'browser-use' | 'computer-use' }
  )[]
  /** Absolute folder of `<skill>/SKILL.md`, or null. */
  skillsDir: string | null
}

/** An App that gives this session programs or skills, as `<gugu_apps>` names it: one line, its instructions in full. */
export interface ExtensionAgentApp {
  extensionId: string
  name: string
  instructions: string
  /** #7317 Computer Use, on: its tools are not in the catalog but gugu's own device_actions / device_call (`<gugu_apps>` says so). */
  computerUse?: true
}

export interface ExtensionSessionMcp {
  /** One gateway entry per program (extension-gateway.ts). */
  servers: AcpMcpServer[]
  skills: ExtensionSkill[]
  /** The Apps whose programs or skills reach this session (in D-30 scope), named once at the opening. */
  apps: ExtensionAgentApp[]
  /** Which extension each program in `servers` came from, by the name the session knows it under. */
  origins: { name: string; extensionId: string }[]
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---/

/**
 * A frontmatter field read as YAML: a skill's description is often a folded block (`description: >-` and the lines
 * under it), and line by line it read as the two characters `>-` (抽卡台's skill, #6387 A/B 10-10).
 */
function frontmatterField(front: Record<string, unknown>, key: string): string | undefined {
  const value = front[key]
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * The skills in one extension's skills folder: every `<folder>/SKILL.md`, with the `name` and
 * `description` from its frontmatter — the two things an agent reads before deciding to open
 * the rest. A skill without a description fails loudly: listed without one, it is a title
 * nobody can judge.
 *
 * Each skill is read on its own: one that cannot be read is left out and said, with its App and
 * its SKILL.md, and its siblings are kept (skill 注入核查 10-14: a frontmatter YAML could not
 * parse, the whole App's skills went with it — the good one too — and the log named no App).
 * A skills folder that cannot be read (missing, or a file: `"skills": "SKILL.md"`) is said the
 * same way, once for the App. Nothing here throws: app_install, app_check and every session
 * opening call it, and none of them may fail over an App's skills.
 */
export function readExtensionSkills(extensionId: string, skillsDir: string, onProblem: (message: string) => void): ExtensionSkill[] {
  const said = (error: unknown) => (error instanceof Error ? error.message : String(error)).trimEnd()
  let entries: Dirent[]
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true })
  } catch (error) {
    onProblem(`extension ${extensionId}: skills folder cannot be read (${skillsDir}): ${said(error)}`)
    return []
  }
  const skills: ExtensionSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dir = join(skillsDir, entry.name)
    const file = join(dir, 'SKILL.md')
    if (!existsSync(file)) continue
    try {
      const parsed: unknown = parseYaml(FRONTMATTER.exec(readFileSync(file, 'utf8'))?.[1] ?? '')
      const front = parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
      const description = frontmatterField(front, 'description')
      if (!description) throw new Error('its frontmatter has no description')
      skills.push({ extensionId, name: frontmatterField(front, 'name') ?? entry.name, description, dir })
    } catch (error) {
      onProblem(`extension ${extensionId}: skill ${entry.name} left out of the session (${file}): ${said(error)}`)
    }
  }
  return skills
}

/** The name an agent sees the server under — its tools read `mcp__<name>__<tool>`. */
export function extensionServerName(extensionId: string, serverName: string): string {
  return serverName === extensionId ? extensionId : `${extensionId}-${serverName}`
}

export function extensionAgentPrograms(
  contributions: readonly ExtensionAgentContribution[],
  host: {
    /** The program that runs `node` scripts: gugu's own runtime, so nobody has to install Node. */
    nodeExecutable: string
    /** F77 The runtime module that serves an App's tools module as MCP (`gugu-tools.mjs`); null in a build without one. */
    toolsRuntime: string | null
    /** `<scheme>://ext` for this build (links differ between production and Beta). */
    linkPrefix: string
    /** Say, loudly, what was left out of the session and why. */
    onProblem: (message: string) => void
  },
): { programs: ExtensionProgram[]; skills: ExtensionSkill[] } {
  const programs: ExtensionProgram[] = []
  const skills: ExtensionSkill[] = []
  for (const contribution of contributions) {
    if (contribution.settingsInvalid) {
      host.onProblem(`extension ${contribution.extensionId}: configuration is invalid; open the App's settings to repair it or restore defaults`)
      continue
    }
    // 一份 skill 写坏了只丢它自己,文件夹读不了丢这个扩展的全部,都由 readExtensionSkills 说出来、❌ 抛 —— 会话永远要能开。
    if (contribution.skillsDir) skills.push(...readExtensionSkills(contribution.extensionId, contribution.skillsDir, host.onProblem))
    for (const server of contribution.servers) {
      const name = programName(server, contribution.extensionId)
      if ('host' in server) {
        programs.push({ extensionId: contribution.extensionId, server: name, digest: contribution.digest,
          native: server.host, command: hostProgramLine(server.host), args: [], cwd: contribution.rootDir, dataDir: contribution.dataDir,
          env: { GUGU_APP_SETTINGS: JSON.stringify(contribution.settings ?? {}) } })
        continue
      }
      let runsOnGuguNode: boolean
      let command: string
      let args: string[]
      if ('tools' in server) {
        // F77 A tools module: gugu's own runtime speaks MCP for it (`gugu-tools.mjs <module>`), the App gives the tools.
        const module = resolvesInside(contribution.rootDir, server.tools)
        if (!module || !existsSync(module) || !host.toolsRuntime) {
          host.onProblem(`extension ${contribution.extensionId}: program ${name} left out of the session: ${
            host.toolsRuntime ? `${server.tools} is not a file of its bundle` : 'this build has no App runtime to serve its tools'}`)
          continue
        }
        runsOnGuguNode = true
        command = host.nodeExecutable
        args = [host.toolsRuntime, module]
      } else {
        runsOnGuguNode = server.command === 'node'
        // `./x` is a program inside the bundle; a bare name is found on PATH (npx, uvx, python3).
        command = runsOnGuguNode
          ? host.nodeExecutable
          : server.command.startsWith('./')
            ? join(contribution.rootDir, server.command.slice(2))
            : server.command
        // An argument naming a file in the bundle (`mcp/server.mjs`) becomes its absolute path.
        args = (server.args ?? []).map((arg) => {
          if (arg.startsWith('-') || isAbsolute(arg)) return arg
          // Same containment check as every other extension-supplied path (sibling folders and
          // symlinks out of the bundle do not count as "in the bundle").
          const inBundle = resolvesInside(contribution.rootDir, arg)
          return inBundle && existsSync(inBundle) ? inBundle : arg
        })
      }
      programs.push({
        extensionId: contribution.extensionId,
        server: name,
        digest: contribution.digest,
        command,
        args,
        env: {
          ...(server.env ?? {}),
          GUGU_EXTENSION_ID: contribution.extensionId,
          GUGU_EXTENSION_DATA_DIR: contribution.dataDir,
          GUGU_EXTENSION_LINK_BASE: `${host.linkPrefix}/${contribution.extensionId}`,
          GUGU_APP_SETTINGS: JSON.stringify(contribution.settings ?? {}),
          // gugu's own runtime is plain Node only with this set; any other program must not inherit it.
          ...(runsOnGuguNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
        },
        cwd: contribution.rootDir,
        dataDir: contribution.dataDir,
        ...(runsOnGuguNode ? { onGuguNode: true as const } : {}),
      })
    }
  }
  return { programs, skills }
}

/**
 * The Apps `<gugu_apps>` names: each one whose program gugu actually runs, or whose skills this session reads, with its
 * `instructions` (the schema gives every App with programs or skills one, and no other App). A program
 * `extensionAgentPrograms` left out (its tools module is not in the bundle, this build has no App runtime) runs nothing,
 * so an App with nothing else is not named: the opening says only what can run (复核 84 2(d)). Whether its tools are
 * listed natively or reached through the catalog does not matter: the line says what the App is for either way.
 * D-30 scope is the caller's (the same `inScope` the catalog uses).
 */
export function agentAppsOf(
  contributions: readonly ExtensionAgentContribution[],
  programs: readonly ExtensionProgram[],
): ExtensionAgentApp[] {
  // The native Computer Use host is named separately from catalog tools.
  const computerUse = new Set(programs.filter((program) => program.native === 'computer-use').map((program) => program.extensionId))
  const running = new Set(programs.map((program) => program.extensionId))
  return contributions.flatMap(({ extensionId, name, instructions, skillsDir }): ExtensionAgentApp[] => {
    if (instructions === undefined || (!running.has(extensionId) && skillsDir === null)) return []
    return [{ extensionId, name, instructions, ...(computerUse.has(extensionId) ? { computerUse: true as const } : {}) }]
  })
}
