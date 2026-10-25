import { ATTACH_EXIT, HOST_RESUME_CALL } from '../session/main/core/pty/attach/attach-protocol'
import { callAccountProcess, pickAttachAccount } from './account-call'
import { listAccounts } from './server-layout'

/** Controller -> local account socket. No remote device action, process restart,
 * or model round is needed to announce that this very process has resumed. */
export async function runResume(
  args: readonly string[],
  io: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream } = process,
  deps = { accounts: listAccounts, call: callAccountProcess },
): Promise<number> {
  const suspendedSince = args.length === 4 && args[2] === '--suspended-since' ? Number(args[3]) : undefined
  if (![2, 4].includes(args.length) || args[0] !== '--account' || !/^[a-zA-Z0-9_-]{1,128}$/.test(args[1]!)
    || (args.length === 4 && (args[2] !== '--suspended-since' || !Number.isSafeInteger(suspendedSince)
      || suspendedSince! <= 0 || suspendedSince! >= Date.now()))) {
    io.stderr.write('用法: gugu-server resume --account <账号 id>\n')
    return 2
  }
  const account = pickAttachAccount(deps.accounts(), args[1]!)
  if ('error' in account) {
    io.stderr.write(`${account.error}\n`)
    return ATTACH_EXIT.notSignedIn
  }
  const outcome = await deps.call(account, { type: HOST_RESUME_CALL,
    payload: suspendedSince === undefined ? {} : { suspendedSince } }, { timeoutMs: 5_000 })
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
