import type { AcpChatStore } from './acp-chat-store';

/**
 * 不在屏上、仍留着转录的会话最多几条;再往前看过的放掉转录(`AcpChatStore.releaseTranscript`),回来时重读。
 * 最近来回切的那几条切回去是现成的。要挡住的是「打开过多少条会话,渲染进程就留多少份转录」——
 * store 跟着会话的 tab 活到会话删除为止(product spec「切走的会话」)。
 */
export const KEPT_HIDDEN_TRANSCRIPTS = 3;

type ShownStore = Pick<AcpChatStore, 'isTransient' | 'releaseTranscript'>;

/** 上过屏的会话 store,最近的在前。侧边聊天不进来(它放掉就没了);store dispose 时摘掉。 */
const shown: ShownStore[] = [];

export function noteTranscriptShown(store: ShownStore): void {
  if (store.isTransient) return;
  forgetTranscriptShown(store);
  shown.unshift(store);
  // 每次从头过一遍:上一次没放成的(那时还在加载 / 还挂在屏上),这一次再放。
  for (const older of shown.slice(KEPT_HIDDEN_TRANSCRIPTS + 1)) older.releaseTranscript();
}

export function forgetTranscriptShown(store: ShownStore): void {
  const index = shown.indexOf(store);
  if (index >= 0) shown.splice(index, 1);
}
