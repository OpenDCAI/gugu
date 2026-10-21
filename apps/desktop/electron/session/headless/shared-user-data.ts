// @@@5080 「这台机器上的咕咕数据放哪」—— 桌面壳写,无头宿主读。
//
// owner 2026-09-05:「桌面版和网页版你设计成这么割裂吗……我以为只是换个视窗」。割裂里最扎眼的一条是
// 两个宿主两份会话库,于是桌面版看不见网页版建的会话。要合成一份,无头宿主就得知道桌面壳的 userData
// 在哪 —— 而那个路径**不能猜**:
//   · Electron 的默认值取 `productName`(本仓是中文「咕咕」),打包后还可能被 electron-builder 改;
//   · 桌面壳自己支持 `--user-data-dir` / `GUGU_USER_DATA_DIR` 覆盖(双实例、e2e 都在用)。
// 猜错的样子是**静默的**:无头宿主指到另一个空目录,页面一切正常,只是「还是两份数据」——
// 与「没改」逐字节相同。所以由桌面壳把**它解析出来的真值**写下来,读的那一方不做任何推断。
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 指针文件。`~/.gugu` 是咕咕既有的本机状态目录(runtime-sessions / agents.json 都在这儿)。 */
export function sharedUserDataPointerPath(): string {
  return path.join(os.homedir(), '.gugu', 'desktop-user-data-path')
}

/**
 * 桌面壳启动时调用:把自己解析出来的 userData 真实路径记下来。
 *
 * 写失败**不抛** —— 它不在桌面壳的关键路径上,写不成最多是无头宿主回落到自己的目录(老行为)。
 * ⚠️ 但也❌ 不静默:调用方拿到 false 要记一行,否则「为什么还是两份数据」查不出来。
 */
export function writeSharedUserDataPointer(userDataPath: string): boolean {
  try {
    const target = sharedUserDataPointerPath()
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, `${path.resolve(userDataPath)}\n`, { encoding: 'utf8', mode: 0o600 })
    return true
  } catch {
    return false
  }
}

/**
 * 无头宿主启动时调用:桌面壳留下的路径,或 null。
 *
 * ❌ 不校验目录里有没有库:桌面壳装了但一次都没打开过会话页时,那个目录本来就是空的,
 * 拿「空」当「无效」会把这条路在最常见的首次使用上关掉。存在即采信。
 */
export function readSharedUserDataPointer(): string | null {
  try {
    const raw = fs.readFileSync(sharedUserDataPointerPath(), 'utf8').trim()
    if (!raw) return null
    return path.resolve(raw)
  } catch {
    return null
  }
}
