/**
 * agent 用 `session_open_in_tab` 给人打开过的文件与网页 —— 这一轮的「产出」(#7193)。
 *
 * owner 2026-10-15:「用 open_in_tab 打开的文件或网页……做成类似于附件的形式,手机端就可以同步直接点开看」,
 * 样子:agent 回完话,最后那条回复下面每个产出一张卡。
 * ⇒ 一次**成功**的打开既是过程里的一步,也是这一轮交出来的东西:过程照常折(那一步留在里面,折叠头不因它
 * 消失),卡另挂在这一轮最后那条回复下面,与 Codex 同一个样子(工作记录里看得到它做了什么,最后单独给产出)。
 * owner 10-15 看了「拿出过程」那版:只打开了文件的一轮折叠头没了,卡片像是顶替了最后一条消息 ⇒ 改成留在过程里。
 * 失败的打开不挂卡,只是过程里一行普通工具调用 —— 失败要看得见原因,❌ 画成一张点不开的卡。
 *
 * 桌面(`flatten.ts`)与手机(`thread-messages.ts`)读的都是这一份:挂在哪、同一个只挂一张。
 * 哪一条调用算产出在 session-core(`openedOutputOf`),机器核对手机要读的文件时也用它。纯函数,不碰 Solid / React。
 */
import { openedOutputKey, openedOutputOf, openedFilePath } from '@gugu/session-core/acp/client';
import type { ChatItem, OpenedOutput, TranscriptItem, TranscriptTurn } from '@session-chat/model';

export type { OpenedOutput };
export { openedFilePath, openedOutputKey, openedOutputOf };

/** 子智能体自己的调用归它自己(flatten 的 isSubagentChild),它打开的东西也不挂在主对话里。 */
function isSubagentChild(item: ChatItem): boolean {
  return 'parentToolCallId' in item && Boolean(item.parentToolCallId);
}

/** 一份产出,连同记下它的那条调用(手机会话页拿调用本身去画同一张卡,见 thread-messages)。 */
export type OpenedEntry = { output: OpenedOutput; item: ChatItem };

/**
 * 同一份东西只留一张,位置按**最后一次**打开:agent 改完再开一次,它就是这一轮最新交出来的那份
 * (真实记录里同一份汇报一轮开三四次很常见)。
 */
export function dedupeOpenedOutputs(entries: readonly OpenedEntry[]): OpenedEntry[] {
  const last = new Map<string, number>();
  entries.forEach((entry, index) => last.set(openedOutputKey(entry.output), index));
  return entries.filter((entry, index) => last.get(openedOutputKey(entry.output)) === index);
}

/**
 * 每一轮打开过的东西,与传入的轮一一对应。只读,轮本身原样交给折叠与排版。
 *
 * 卡是这一轮**交出来**的东西:跑完或被停下才挂(#7305,owner 10-16「本来应该是 agent 运行完或者被中断了
 * 才有的显示,怎么运行中就显示了」)。`live` = 传进来的是还没结算的那一层(在跑、等审批 / 提问都算),一张不挂:
 * 桌面是活动层,手机是「最后一轮还没结算」(thread-messages `unsettledLastTurnId`)。
 */
export function collectOpenedOutputs(turns: readonly TranscriptTurn[], { live = false }: { live?: boolean } = {}): OpenedEntry[][] {
  return turns.map((turn) => {
    if (live) return [];
    const found: OpenedEntry[] = [];
    for (const item of turn.items as readonly ChatItem[]) {
      const output = isSubagentChild(item) ? null : openedOutputOf(item as TranscriptItem);
      if (output) found.push({ output, item });
    }
    return found;
  });
}

/**
 * 一轮画完之后挂哪几张卡:它自己的,加上被它并进来的后续轮的(`planTurnFoldRuns` 的 absorbed 紧跟在锚后面)。
 * 并成一条的几轮读起来就是一轮,卡也只在最后挂一组。
 */
export function outputsOfRun(
  opened: readonly (readonly OpenedEntry[])[],
  index: number,
  absorbed: readonly boolean[]
): OpenedEntry[] {
  const collected = [...(opened[index] ?? [])];
  for (let next = index + 1; next < opened.length && absorbed[next]; next++) collected.push(...(opened[next] ?? []));
  return dedupeOpenedOutputs(collected);
}

export type OpenedOutputLook = {
  /** 卡上那一行:文件名;网页是去掉协议头的地址。 */
  name: string;
  /** 文档、图片还是网页。 */
  kind: 'document' | 'image' | 'page';
  /** 文档的扩展名(大写,`HTML`);没有扩展名或是网页 → null。 */
  extension: string | null;
  /**
   * 只有那台电脑自己够得着的网页(localhost、内网地址):别的设备点开打不开,卡上要如实说。
   * 本机文件不算 —— 文件怎么送到别的设备是另一件事。
   */
  machineOnly: boolean;
};

function basenameOf(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? path;
}

/** 画成「图片」的扩展名(手机上点开进看图器,见 mobile/agent-watch/opened-output-open)。 */
const IMAGE_EXTENSIONS = new Set(['PNG', 'JPG', 'JPEG', 'GIF', 'WEBP', 'SVG', 'BMP', 'AVIF']);

const PRIVATE_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1?\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$|\.local$/i;

/** 卡片上怎么写这份东西。桌面与手机同一份说法。 */
export function openedOutputLook(output: OpenedOutput): OpenedOutputLook {
  const path = openedFilePath(output);
  if (path) {
    const name = basenameOf(path);
    const dot = name.lastIndexOf('.');
    const extension = dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : null;
    return {
      name,
      kind: extension && IMAGE_EXTENSIONS.has(extension) ? 'image' : 'document',
      extension,
      machineOnly: false,
    };
  }
  const url = output.kind === 'page' ? output.url : '';
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    // 不是合法网址就照原文写,❌ 编一个主机名。
  }
  return {
    name: url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/$/, '') || url,
    kind: 'page',
    extension: null,
    machineOnly: PRIVATE_HOST.test(host),
  };
}
