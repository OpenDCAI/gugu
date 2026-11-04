import { redactSecrets } from '@gugu/session-shared/logger'
import { desktopServerChannel, remoteServerPaths } from '../server-names'
import { parseStatusJson } from '../server-status'

export const EXISTING_IDENTITY_BEGIN = '__GUGU_EXISTING_IDENTITY_BEGIN__'
export const EXISTING_IDENTITY_END = '__GUGU_EXISTING_IDENTITY_END__'

/** Account labels are identifiable without exposing a full email address. */
export function sshAccountLabel(account: { userId: string; email: string | null }): string {
  const local = account.email?.split('@')[0]
  return `${local ? `${Array.from(local)[0]}… · ` : ''}${account.userId.slice(0, 8)}`
}

export function safeSshText(text: string): string {
  return redactSecrets(text)
    .replace(/((?:device_code|token_hash)["']?\s*[:=]\s*["']?)[^\s,"'}]+/gi, '$1[REDACTED]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{1,}/g, email => `${email[0]}…@…`)
}

/** Read the released installation identity; never execute or source launcher text. */
export function existingIdentityScript(): string {
  const { bin, home } = remoteServerPaths(desktopServerChannel())
  return [
    `B=${bin}`,
    `H=${home}`,
    'PINNED="$(sed -n \'s/^GUGU_SERVER_HOME="\\([^"]*\\)" exec .*/\\1/p\' "$B")" || exit 1',
    'case "$PINNED" in /*) H="$PINNED" ;; esac',
    `echo ${EXISTING_IDENTITY_BEGIN}`,
    '"$B" status --json || exit 1',
    'if [ ! -e "$H/install-id" ]; then echo identity_missing=1; else',
    // Validate every byte before framing; shell variables cannot preserve NUL bytes.
    '  BYTES="$(od -An -v -t u1 "$H/install-id")" || exit 1',
    `  I="$(printf '%s\\n' "$BYTES" | LC_ALL=C awk '`,
    '    { for (i = 1; i <= NF; i++) {',
    '      n = $i + 0',
    '      if (n == 9 || n == 10 || n == 11 || n == 12 || n == 13 || n == 32) { if (length(id)) trailing = 1 }',
    '      else if (!trailing && ((n >= 48 && n <= 57) || (n >= 65 && n <= 70) || (n >= 97 && n <= 102))) id = id sprintf("%c", n)',
    '      else invalid = 1',
    '    } }',
    '    END { if (invalid || length(id) != 32) exit 1; print id }',
    `  ')" || { echo 'The server installation identity is empty or invalid' >&2; exit 1; }`,
    '  printf \'machine_id=%s\\n\' "$I"',
    'fi',
    `echo ${EXISTING_IDENTITY_END}`,
    '',
  ].join('\n')
}

export function parseExistingIdentity(stdout: string, userId: string): { machineId: string; email: string | null } {
  const begin = stdout.lastIndexOf(EXISTING_IDENTITY_BEGIN)
  const end = stdout.indexOf(EXISTING_IDENTITY_END, begin)
  if (begin < 0 || end < 0) throw new Error('Could not read the existing server identity')
  const text = stdout.slice(begin + EXISTING_IDENTITY_BEGIN.length, end)
  const report = parseStatusJson(text)
  if (!report) throw new Error('Could not read the existing server account status')
  if (report.migrationRequired) throw new Error('The server account layout needs migration before adding this machine')
  const accounts = report.accounts.filter(account => account.signedIn && !account.signedOut)
  if (accounts.length !== 1) throw new Error('The server account changed or is no longer signed in; add the machine again after checking its status')
  const account = accounts[0]
  if (account.userId !== userId) throw new Error(`This server is signed in as ${sshAccountLabel(account)}. Sign out on that server or use another system user.`)
  if (/^identity_missing=1$/m.test(text)) throw new Error('This server has no installation identity. Update the server before adding it; its existing login was preserved.')
  const ids = [...text.matchAll(/^machine_id=([^\r\n]*)\r?$/gm)]
  if (ids.length !== 1 || !/^machine_id=[a-f0-9]{32}\r?\n$/i.test(text.slice(ids[0].index))) throw new Error('The server installation identity is empty or invalid')
  return { machineId: ids[0][1], email: account.email }
}

export type ExistingDeviceLookup = (input: { userId: string; machineId: string; signal: AbortSignal }) => Promise<string>
