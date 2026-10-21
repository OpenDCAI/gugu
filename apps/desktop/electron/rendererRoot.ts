import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export type BuiltRendererRootInput = {
  appPath: string
  mainEntryPath: string
  pathExists?: (path: string) => boolean
}

export function resolveBuiltRendererRoot(input: BuiltRendererRootInput): string {
  const appPath = resolve(input.appPath)
  const mainDirectory = dirname(resolve(input.mainEntryPath))
  const rendererRoot = appPath === mainDirectory
    ? resolve(mainDirectory, '..', '..', '..', 'dist')
    : join(appPath, 'dist')
  const entryPath = join(rendererRoot, 'index.html')

  if (!(input.pathExists ?? existsSync)(entryPath)) {
    throw new Error(`[gugu-app-scheme] built renderer entry is missing: ${entryPath}`)
  }
  return rendererRoot
}

/**
 * 把解析推迟到**第一次真的有人请求** `gugu-app://` 时(#2795)。
 *
 * 注册这个协议不该要求构建产物存在:dev 的渲染层来自 `VITE_DEV_SERVER_URL`,全程不碰这个
 * scheme(全仓唯一的运行时请求在 main.ts 的生产分支)。原来在 `whenReady` 里 eager 解析,
 * 等于把一个「只有生产才用得到的产物检查」变成了 dev 的启动失败——干净 clone 第一次
 * `pnpm dev` 必翻车。
 *
 * fail-loud 一个字不弱:谁真去取构建产物,谁在取的那一刻拿到同样那条精确报错。
 */
export function createBuiltRendererRootResolver(input: BuiltRendererRootInput): () => string {
  let resolved: string | undefined
  return () => (resolved ??= resolveBuiltRendererRoot(input))
}
