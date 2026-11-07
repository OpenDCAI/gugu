import type { AgentInstallErrorPresentation, Translate } from './agent-install'

/** The dialog shows a short cause; full host messages and paths stay in details. */
export function installFailureSummary(
  failure: AgentInstallErrorPresentation,
  translate: Translate,
  updating = false
): AgentInstallErrorPresentation {
  const diagnostic = [failure.message, failure.diagnostic].filter(Boolean).join('\n\n')
  const facts = diagnostic.toLowerCase()
  const operation = translate(updating ? 'agentsPage.updateAction' : 'agentsPage.installation')
  const permissionDenied = failure.message.startsWith(translate('agentsPage.errPermissionDenied'))
  const key = /cancelled|canceled|已取消/.test(facts)
    ? 'agentsPage.failureCancelled'
    : permissionDenied ||
        /\b(?:eacces|eperm)\b|permission denied|access is denied|not enough permission/.test(facts)
      ? 'agentsPage.failurePermission'
      : /\b(?:enospc|edquot)\b|no space left|disk quota exceeded/.test(facts)
        ? 'agentsPage.failureDisk'
        : /\beexist\b|file already exists|already holds another copy/.test(facts)
          ? 'agentsPage.failureExists'
          : /\b(?:etimedout|econnrefused|econnreset|enotfound|eai_again|enetunreach|ehostunreach)\b|network aborted|network is (?:down|unreachable)|connection (?:timed out|refused|reset|closed)|tcp connect error|dns error|failed to lookup address|could not resolve host|tls handshake[^\n]*(?:eof|timeout|timed out)|cannot reach the download source/.test(
                facts
              )
            ? 'agentsPage.failureNetwork'
            : 'agentsPage.failureIncomplete'
  return { message: translate(key, { operation }), diagnostic }
}
