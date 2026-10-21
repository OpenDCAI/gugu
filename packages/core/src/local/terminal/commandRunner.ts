import { execFile, type ExecFileException } from 'node:child_process'

export interface CommandRunOptions {
  check?: boolean
  signal?: AbortSignal
  // @@@send-timeout (#517) - bound a command so a wedged target can't block forever. Used on tmux
  timeoutMs?: number
}

export interface CommandRunResult {
  status: number
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(args: string[], options?: CommandRunOptions): Promise<CommandRunResult>
  checkOutput(args: string[]): Promise<string>
  sleep(seconds: number): Promise<void>
}

function isAbortError(error: ExecFileException | null): boolean {
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR'
}

export class NodeCommandRunner implements CommandRunner {
  async run(args: string[], options: CommandRunOptions = {}): Promise<CommandRunResult> {
    if (args.length === 0) throw new Error('command args must not be empty')
    options.signal?.throwIfAborted()
    const [command, ...commandArgs] = args
    const abortController = new AbortController()

    return await new Promise<CommandRunResult>((resolve, reject) => {
      let callbackResult: {
        aborted: boolean
        error: ExecFileException | null
        stdout: string
        stderr: string
      } | null = null
      let childClosed = false
      let removeAbortListener = () => {}
      const settle = () => {
        if (!callbackResult || !childClosed) return
        removeAbortListener()
        const { aborted, error, stdout, stderr } = callbackResult
        if (error && aborted) {
          reject(error)
          return
        }
        // @@@send-timeout (#517) - on timeout execFile SIGKILLs the child and reports `killed`; surface
        // it as a clear, fast failure so the caller (delivery) can skip a wedged pane instead of hanging.
        if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed && options.timeoutMs) {
          reject(new Error(`command timed out after ${options.timeoutMs}ms: ${args.join(' ')}`))
          return
        }
        if (error && typeof error.code !== 'number') {
          reject(error)
          return
        }

        const status = error ? Number(error.code) : 0
        const result = { status, stdout, stderr }
        if (options.check && status !== 0) {
          reject(new Error(`command failed (${status}): ${args.join(' ')}\n${stderr}`))
          return
        }
        resolve(result)
      }
      const child = execFile(
        command,
        commandArgs,
        {
          encoding: 'utf8',
          killSignal: 'SIGKILL',
          timeout: options.timeoutMs ?? 0,
          signal: abortController.signal,
        },
        (error, stdout, stderr) => {
          callbackResult = { aborted: isAbortError(error), error, stdout, stderr }
          settle()
        },
      )
      const forceAbort = () => { abortController.abort(options.signal?.reason); child.kill('SIGKILL') }
      options.signal?.addEventListener('abort', forceAbort, { once: true })
      removeAbortListener = () => options.signal?.removeEventListener('abort', forceAbort)
      child.once('close', () => {
        childClosed = true
        settle()
      })
    })
  }

  async checkOutput(args: string[]): Promise<string> {
    return (await this.run(args, { check: true })).stdout
  }

  async sleep(seconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000))
  }
}

export function createNodeCommandRunner(): CommandRunner {
  return new NodeCommandRunner()
}
