import type { ExtensionManifest } from './manifest'

/**
 * 161 10-17: which machine a page's `callProgram` runs on. An App's own program follows the place's data — a page in a
 * session on another machine calls it there (`agentSession.app_call`). A program gugu hosts itself (`{ name, host }`,
 * Browser Use) drives the browser on the screen the person is looking at: its "data" is that screen, so it always runs on
 * the machine drawing the page, never sent to the session's machine — and a phone, which hosts none, has no such program.
 */
export function hostsProgram(manifest: Pick<ExtensionManifest, 'contributes'>, server?: string): boolean {
  const servers = manifest.contributes.mcpServers ?? []
  const named = server === undefined
    ? (servers.length === 1 ? servers[0] : undefined)
    : servers.find((candidate) => 'name' in candidate && candidate.name === server)
  return !!named && 'host' in named
}

/** A hosted program that cannot run where it is asked to: the code a page branches on, the same here and elsewhere. */
export const HOSTED_PROGRAM_ELSEWHERE = 'This program drives the browser on the screen this page is drawn on; it runs on that computer only'
