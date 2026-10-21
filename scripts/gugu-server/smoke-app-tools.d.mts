/** One program of an App as gugu starts it (smoke-app-tools.mjs launchOf); null for one not on gugu's node. */
export interface SmokeLaunch {
  command: string
  args: string[]
  env: Record<string, string>
  cwd: string
  stdio: ['pipe', 'pipe', 'pipe', 'ipc']
  serialization: 'advanced'
  detached: true
}
export declare function launchOf(
  appId: string,
  root: string,
  server: { tools: string; env?: Readonly<Record<string, string>> } | { command: string; args?: readonly string[]; env?: Readonly<Record<string, string>> },
  runtime: { node: string; programRuntime: string; toolsRuntime: string; dataDir: string; linkPrefix: string; settings?: Record<string, string | boolean> },
): SmokeLaunch | null
