import { openedFilePath, openedOutputKey, type OpenedOutput } from '@gugu/session-core/acp/client';
import { KV } from '@main/db/kv';

/**
 * 这条会话给人打开过什么(`session_open_in_tab` 的文件 / 网页、App 的 `files.openWith`、浏览器工具新开的页)——
 * **唯一**的一份,记在会话所在的这台机器上,由宿主处理请求时记:开成了、攒着等人来看都算,没开成的不算。
 * 桌面的「输出」、手机,以及手机读文件前「打开过没有」的核对,都读这一份(`sessionTimeline.sessionOutputs`)。
 * ❌ 再让哪台桌面各记一份:那份只有它自己看得见,重启、换一台电脑、没人看着时攒下的,都会对不上。
 */
const outputsKV = new KV<Record<string, OpenedOutput[]>>('session-outputs');

/** 存盘里的一格,❌ 无限长。 */
const MAX_OUTPUTS = 50;

// 读-改-写串成一条:两次 open_in_tab 前后脚到,❌ 后一次盖掉前一次。
let writes: Promise<unknown> = Promise.resolve();

export function recordSessionOutput(sessionId: string, output: OpenedOutput): Promise<void> {
  const write = writes.then(async () => {
    const list = (await outputsKV.get(sessionId)) ?? [];
    await outputsKV.setOrThrow(sessionId, [output, ...list.filter((o) => openedOutputKey(o) !== openedOutputKey(output))].slice(0, MAX_OUTPUTS));
  });
  writes = write.catch(() => undefined);
  return write;
}

/** 最近打开的在前。 */
export async function sessionOutputs(sessionId: string): Promise<OpenedOutput[]> {
  await writes;
  return (await outputsKV.get(sessionId)) ?? [];
}

/** 这条会话真的打开过这份文件吗(用 path,或用 file:// 网址)。 */
export async function sessionOpenedFile(sessionId: string, path: string): Promise<boolean> {
  return (await sessionOutputs(sessionId)).some((output) => openedFilePath(output) === path);
}

export function forgetSessionOutputs(sessionId: string): Promise<void> {
  return outputsKV.del(sessionId);
}
