import type {
  RecordEntry,
  SessionRecordLocator,
  SessionRecordResume,
  SessionRecordSource,
  SessionRecordSourceEvents
} from '../contract';
import { locateImages, readRecordImage } from './record-images';
import { emitJsonLines, pollInterval, warnOf, type SessionRecordSourceOptions } from './shared';
import { TailReader, type TailResume } from './tail-reader';

/**
 * 一份只追加的 JSONL 文件的尾读源(codex、copilot):找到文件 → 整份读或接着续读点读 → 尾读。
 *
 * 各家只给:找文件、一条记录怎么解，以及(可选)随读随记、跟着续读点一起存的一份状态
 * (codex 的序号:它的条目 key 由「从头数到这里」派生)。
 */
export type JsonlTailFormat<S> = {
  /** 写进告警和 fingerprint 里的那一家。 */
  name: string;
  /** 续读点里这份数据的版本。形状或读法变了就升，老存档一律作废重读。 */
  resumeVersion: number;
  resolve(): Promise<string>;
  /** 从头读时的状态。文件被换掉、整份重读时回到它。 */
  initial(): S;
  /** 一条记录 → 条目;回 null = 坏行。`state` 可以就地改。 */
  decode(record: Record<string, unknown>, state: S): RecordEntry[] | null;
};

type ResumeData<S> = { version: number; path: string; tail: TailResume; state: S };

export function createJsonlTailSource<S>(
  locator: SessionRecordLocator,
  options: SessionRecordSourceOptions | undefined,
  format: JsonlTailFormat<S>
): SessionRecordSource {
  const warn = warnOf(options);
  let reader: TailReader | null = null;
  let path: string | null = null;
  let state = format.initial();
  let sink: SessionRecordSourceEvents | null = null;
  let stopped = false;

  const emit = (lines: string[], offsets: number[]) => {
    if (stopped || !sink) return;
    const events = sink;
    const file = path;
    emitJsonLines(lines, format.name, warn, (entries) => events.onEntries(entries), (record) => format.decode(record, state),
      file ? (entries, index) => locateImages(entries, lines[index], offsets[index], file) : undefined);
  };

  return {
    locator,
    async start(events, resume) {
      sink = events;
      const found = await format.resolve();
      if (stopped) return; // 找文件的工夫里已经被拆了
      path = found;
      reader = new TailReader(
        found,
        pollInterval(options),
        {
          onLines: emit,
          onRestart: (reason) => {
            state = format.initial();
            events.onReset(reason);
          }
        },
        warn
      );
      const data = resume?.data as ResumeData<S> | undefined;
      const canResume = data?.version === format.resumeVersion && data.path === found;
      // 状态必须在 `resumeFrom` **之前**装回去:它当场就把「存档之后、重开之前」写进来的行读出来解码。
      // 先读后装 ⇒ 那一段按初始状态编号，键与存档里前几轮撞车，被上层去重表当成重复整条丢掉(#6357)。
      state = canResume ? structuredClone(data!.state) : format.initial();
      const resumed = canResume ? await reader.resumeFrom(data!.tail, emit) : false;
      if (!resumed) {
        // 要过存档、却没能续上 ⇒ 必须显式作废上层那份状态:不说的话整份重读会被旧去重表全部吃掉，
        // 留下一份过期且不再更新的历史。
        if (resume) events.onReset('source_replaced');
        state = format.initial();
        await reader.readFromStart(emit);
      }
      reader.start();
    },
    catchUp: async () => reader?.catchUp(),
    readImage: readRecordImage,
    async resumePoint() {
      if (!reader || !path) return null;
      const tail = await reader.resumePoint();
      if (!tail) return null;
      const data: ResumeData<S> = { version: format.resumeVersion, path, tail, state: structuredClone(state) };
      return { data, fingerprint: `${format.name}:${path}:${tail.ino}:${tail.size}:${tail.mtimeMs}` } satisfies SessionRecordResume;
    },
    stop() {
      stopped = true;
      reader?.stop();
      reader = null;
      sink = null;
    }
  };
}
