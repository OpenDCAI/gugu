import { ATTACH_EXIT, HOST_RESUME_CALL } from '../session/main/core/pty/attach/attach-protocol'
import { callAccountProcess, accountRequestError } from './account-call'
import { readServerAccount } from './server-layout'
import { ownerTimeZoneFromEnvironment } from './owner-timezone'

/** Controller -> local account socket. No remote device action, process restart,
 * or model round is needed to announce that this very process has resumed. */
export async function runResume(
  args: readonly string[],
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process,
  deps = { account: readServerAccount, call: callAccountProcess },
): Promise<number> {
  const rest = [...args]
  let requested: string | null = null
  if (rest[0] === '--account') {
    requested = rest[1] ?? ''
    rest.splice(0, 2)
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requested)) { io.stderr.write('Invalid account identity\n'); return 2 }
  }
  const suspendedSince = rest.length === 2 && rest[0] === '--suspended-since' ? Number(rest[1]) : undefined
  if (rest.length !== 0 && (rest.length !== 2 || rest[0] !== '--suspended-since'
    || !Number.isSafeInteger(suspendedSince) || suspendedSince! <= 0 || suspendedSince! >= Date.now())) {
    io.stderr.write('用法: gugu-server resume [--suspended-since <timestamp>]\n')
    return 2
  }
  const account = deps.account()
  const accountError = accountRequestError(account, requested)
  if (accountError || !account) {
    io.stderr.write(`${accountError}\n`)
    return ATTACH_EXIT.notSignedIn
  }
  let timeZoneContext
  try { timeZoneContext = ownerTimeZoneFromEnvironment() } catch {
    io.stderr.write('账号时区资料无效，未发送恢复通知\n'); return 2
  }
  const outcome = await deps.call(account, { type: HOST_RESUME_CALL,
    payload: { ...(suspendedSince === undefined ? {} : { suspendedSince }),
      ...(timeZoneContext ? { timeZoneContext } : {}) } }, { timeoutMs: 5_000 })
  if ('code' in outcome) {
    io.stderr.write(`${outcome.message}\n`)
    return outcome.code
  }
  let reply: { result?: { resumed?: boolean }; error?: { message?: string } }
  try {
    reply = JSON.parse(outcome.reply.toString('utf8')) as typeof reply
  } catch {
    io.stderr.write('账号进程返回了无法识别的恢复应答\n')
    return ATTACH_EXIT.refused
  }
  if (!reply.result?.resumed) {
    io.stderr.write(`${reply.error?.message ?? '账号进程没有接受恢复通知'}\n`)
    return ATTACH_EXIT.refused
  }
  io.stdout.write(`${JSON.stringify(reply.result)}\n`)
  return 0
}
