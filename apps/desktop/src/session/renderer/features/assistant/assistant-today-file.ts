// #7199 「今天」页读的那一份:助理写在和主人那条私聊文件夹里的 today.json(共用地图 §4)。
// 简报正文是它发进私聊的消息(给人看的只经消息落库);这份只放页面要的结构,用 messageId 指回那条消息。
// 小组件不是助理写的一段 JS:一张 = 一段 markdown,到点由它重写那一段。
// 日程进展(dayInProgress)与灵感(ideas)也是它写的:由它把连接器、本机日历、对话合成一份,
// 我们的「服务端」就是它(连接应用 + 这台电脑能做的事 + 手机 + 聊天),页面只照着画、按此刻的钟点算「即将开始 / 进行中」。
// 纯函数,单测在 assistant-today-file.test.ts。

export const TODAY_FILE_NAME = 'today.json';

export const BATCH_KINDS = ['morning', 'evening', 'diary'] as const;
export type BatchKind = (typeof BATCH_KINDS)[number];

export type TodayCard = { id: string; title: string; markdown: string };
export type TodayBatch = {
  id: string;
  kind: BatchKind;
  /** 这一批属于哪一天(主人那边的日历日,YYYY-MM-DD)。 */
  localDate: string;
  pushedAt: string | null;
  /** 私聊里那条正文消息;没有 = null。 */
  messageId: string | null;
  cards: TodayCard[];
};
export const WIDGET_STATES = ['creating', 'ready', 'failed'] as const;
export type WidgetState = (typeof WIDGET_STATES)[number];
export type TodayWidget = {
  id: string;
  title: string;
  markdown: string;
  updatedAt: string | null;
  /** 刚加上它还在写第一版(creating)/ 写好了(ready,没写 = ready)/ 这一张没写成(failed)。 */
  state: WidgetState;
  /** 它给自己排的更新节奏,一句人话(「每天 8:00」);没写 = null。 */
  schedule: string | null;
};

/** 今天的一件事。时间是带时区的 ISO;全天的不看钟点。会议链接只认 https。 */
export type DayEvent = {
  id: string;
  title: string;
  start: string | null;
  end: string | null;
  allDay: boolean;
  description: string;
  joinUrl: string | null;
  /** 那本日历的颜色(#RRGGBB),画在行首那根竖条上;没写 = 默认色。 */
  color: string | null;
  /** 从哪来的,一句人话(「Google 日历」「这台 Mac 的日历」「聊天里说的」)。 */
  source: string | null;
};
/** 日程进展:它排的是哪一天(主人那边的日历日)的,和那一天的事。 */
export type TodayDay = { localDate: string; updatedAt: string | null; events: DayEvent[] };

/** 一条灵感:点了就把 prompt 接进输入框(只填不发)。分组 = category 那句人话,按第一次出现的先后。 */
export type TodayIdea = { id: string; title: string; description: string; prompt: string; emoji: string | null; category: string | null };
export type TodayIdeas = { updatedAt: string | null; items: TodayIdea[] };

/**
 * 自己读自己的一块(日程进展 / 灵感):没写 / 读懂了 / 这一块读不懂(如实说哪一格)。
 * 只拖累自己那一块,❌ 把整页变成「读不懂」—— 简报还在,日程那一张说清哪一格不对就够了。
 */
export type TodayPart<T> = { state: 'none' } | { state: 'ok'; value: T } | { state: 'invalid'; problem: string };

export type TodayFile = { version: 1; batches: TodayBatch[]; widgets: TodayWidget[]; day: TodayPart<TodayDay>; ideas: TodayPart<TodayIdeas> };

export type TodayParse = { ok: true; file: TodayFile } | { ok: false; problem: string };

type Obj = Record<string, unknown>;
const isObj = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class Problem extends Error {}
function str(obj: Obj, key: string, at: string): string {
  const value = obj[key];
  if (typeof value !== 'string' || !value.trim()) throw new Problem(`${at}.${key}`);
  return value;
}
function optStr(obj: Obj, key: string, at: string): string | null {
  const value = obj[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new Problem(`${at}.${key}`);
  return value;
}
function list(obj: Obj, key: string, at: string): unknown[] {
  const value = obj[key] ?? [];
  if (!Array.isArray(value)) throw new Problem(`${at}.${key}`);
  return value;
}
function optTime(obj: Obj, key: string, at: string): string | null {
  const value = optStr(obj, key, at);
  if (value !== null && Number.isNaN(Date.parse(value))) throw new Problem(`${at}.${key}`);
  return value;
}
function optBool(obj: Obj, key: string, at: string): boolean {
  const value = obj[key];
  if (value === undefined || value === null) return false;
  if (typeof value !== 'boolean') throw new Problem(`${at}.${key}`);
  return value;
}
const COLOR = /^#[0-9a-fA-F]{6}$/;
function httpsUrl(value: string | null, at: string): string | null {
  if (value === null || value === '') return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Problem(at);
  }
  if (url.protocol !== 'https:') throw new Problem(at);
  return url.toString();
}

/** 一块自己读:没有这个键 = none;读不懂只记在这一块上。 */
function part<T>(raw: Obj, key: string, read: (value: Obj, at: string) => T): TodayPart<T> {
  const value = raw[key];
  if (value === undefined || value === null) return { state: 'none' };
  try {
    if (!isObj(value)) throw new Problem(key);
    return { state: 'ok', value: read(value, key) };
  } catch (error) {
    if (error instanceof Problem) return { state: 'invalid', problem: error.message };
    throw error;
  }
}

function readDay(value: Obj, at: string): TodayDay {
  const localDate = str(value, 'localDate', at);
  if (!DATE.test(localDate)) throw new Problem(`${at}.localDate`);
  return {
    localDate,
    updatedAt: optTime(value, 'updatedAt', at),
    events: list(value, 'events', at).map((item, index): DayEvent => {
      const eventAt = `${at}.events[${index}]`;
      if (!isObj(item)) throw new Problem(eventAt);
      const allDay = optBool(item, 'allDay', eventAt);
      const start = optTime(item, 'start', eventAt);
      if (!allDay && start === null) throw new Problem(`${eventAt}.start`);
      const color = optStr(item, 'color', eventAt);
      if (color !== null && !COLOR.test(color)) throw new Problem(`${eventAt}.color`);
      return {
        id: str(item, 'id', eventAt),
        title: str(item, 'title', eventAt),
        start,
        end: optTime(item, 'end', eventAt),
        allDay,
        description: optStr(item, 'description', eventAt) ?? '',
        joinUrl: httpsUrl(optStr(item, 'joinUrl', eventAt), `${eventAt}.joinUrl`),
        color,
        source: optStr(item, 'source', eventAt),
      };
    }),
  };
}

function readIdeas(value: Obj, at: string): TodayIdeas {
  return {
    updatedAt: optTime(value, 'updatedAt', at),
    items: list(value, 'items', at).map((item, index): TodayIdea => {
      const ideaAt = `${at}.items[${index}]`;
      if (!isObj(item)) throw new Problem(ideaAt);
      return {
        id: str(item, 'id', ideaAt),
        title: str(item, 'title', ideaAt),
        description: optStr(item, 'description', ideaAt) ?? '',
        prompt: str(item, 'prompt', ideaAt),
        emoji: optStr(item, 'emoji', ideaAt),
        category: optStr(item, 'category', ideaAt),
      };
    }),
  };
}

/**
 * 读 today.json 的文本。格式不对就如实说哪一格不对(`batches[0].kind`)—— ❌ 跳过坏的那几条装作没有:
 * 那会让「它写坏了」看起来像「它什么都没写」。多出来的字段不管(它以后可以多写)。
 */
export function parseTodayFile(text: string): TodayParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, problem: 'json' };
  }
  try {
    if (!isObj(raw)) throw new Problem('root');
    if (raw.version !== 1) throw new Problem('version');
    const batches = list(raw, 'batches', 'root').map((item, index): TodayBatch => {
      const at = `batches[${index}]`;
      if (!isObj(item)) throw new Problem(at);
      const kind = item.kind;
      if (!BATCH_KINDS.includes(kind as BatchKind)) throw new Problem(`${at}.kind`);
      const localDate = str(item, 'localDate', at);
      if (!DATE.test(localDate)) throw new Problem(`${at}.localDate`);
      return {
        id: str(item, 'id', at),
        kind: kind as BatchKind,
        localDate,
        pushedAt: optStr(item, 'pushedAt', at),
        messageId: optStr(item, 'messageId', at),
        cards: list(item, 'cards', at).map((card, cardIndex) => {
          const cardAt = `${at}.cards[${cardIndex}]`;
          if (!isObj(card)) throw new Problem(cardAt);
          return { id: str(card, 'id', cardAt), title: str(card, 'title', cardAt), markdown: optStr(card, 'markdown', cardAt) ?? '' };
        }),
      };
    });
    const widgets = list(raw, 'widgets', 'root').map((item, index): TodayWidget => {
      const at = `widgets[${index}]`;
      if (!isObj(item)) throw new Problem(at);
      const state = item.state ?? 'ready';
      if (!WIDGET_STATES.includes(state as WidgetState)) throw new Problem(`${at}.state`);
      return {
        id: str(item, 'id', at),
        title: str(item, 'title', at),
        markdown: optStr(item, 'markdown', at) ?? '',
        updatedAt: optStr(item, 'updatedAt', at),
        state: state as WidgetState,
        schedule: optStr(item, 'schedule', at),
      };
    });
    return { ok: true, file: { version: 1, batches, widgets, day: part(raw, 'dayInProgress', readDay), ideas: part(raw, 'ideas', readIdeas) } };
  } catch (error) {
    if (error instanceof Problem) return { ok: false, problem: error.message };
    throw error;
  }
}

/** 页面读到的那一份:还没有这个文件(第一天)/ 读懂了 / 有但读不懂(如实说是哪一格,❌ 当成空)。 */
export type TodayRead = { state: 'none' } | { state: 'ok'; file: TodayFile; updatedAt: string } | { state: 'invalid'; problem: string };

/** 它早晚改这一份;没有「文件夹变了」的推送到页面这边,每分钟再问一次(与「动态」页刷新信息流同一个节奏)。 */
export const TODAY_REFRESH_MS = 60_000;

/** 读不到是哪一步(读法的 kind:signed-out / list / file-service / not-text,见 chat-folder-text.ts)。 */
export class TodayReadError extends Error {
  constructor(
    readonly kind: string,
    message: string
  ) {
    super(message);
    this.name = 'TodayReadError';
  }
}

/** 读到的文本 → 页面要的那一种;没有这个文件 = none。 */
export function todayReadOf(file: { text: string; updatedAt: string } | null): TodayRead {
  if (!file) return { state: 'none' };
  const parsed = parseTodayFile(file.text);
  return parsed.ok ? { state: 'ok', file: parsed.file, updatedAt: file.updatedAt } : { state: 'invalid', problem: parsed.problem };
}

/** 信息流的顺序:新的一天在上;同一天里晚的在上(日记 > 晚报 > 早报,有 pushedAt 的按它)。 */
export function feedOrder(batches: readonly TodayBatch[]): TodayBatch[] {
  const rank: Record<BatchKind, number> = { morning: 0, evening: 1, diary: 2 };
  return [...batches].sort(
    (a, b) =>
      b.localDate.localeCompare(a.localDate) ||
      (b.pushedAt ?? '').localeCompare(a.pushedAt ?? '') ||
      rank[b.kind] - rank[a.kind]
  );
}

/** 段头的日期:今天 / 昨天 / 别的日子(按主人这台电脑的日历日比)。 */
export function dayOf(localDate: string, now: Date): 'today' | 'yesterday' | 'other' {
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  if (localDate === iso(now)) return 'today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  return localDate === iso(yesterday) ? 'yesterday' : 'other';
}

/** 日记:today.json 里 kind = diary 的那几批,新的在上(与信息流同一个先后)。 */
export function diaryBatches(file: TodayFile): TodayBatch[] {
  return feedOrder(file.batches.filter((batch) => batch.kind === 'diary'));
}

export type DiaryMonth = { key: string; year: number; month: number; batches: TodayBatch[] };

/** 按月分组(「日记」页:2026年10月 / 2026年9月……),组内保持传进来的先后。 */
export function diaryMonths(batches: readonly TodayBatch[]): DiaryMonth[] {
  const months: DiaryMonth[] = [];
  for (const batch of batches) {
    const key = batch.localDate.slice(0, 7);
    let group = months.find((month) => month.key === key);
    if (!group) {
      group = { key, year: Number(key.slice(0, 4)), month: Number(key.slice(5, 7)), batches: [] };
      months.push(group);
    }
    group.batches.push(batch);
  }
  return months;
}

/**
 * 卡片上那几行预览:一篇日记的正文(各段 markdown 接起来)去掉标记,只留字。没有正文(正文在聊天里)= ''。
 * 只为预览:标题井号、粗斜体、行内代码、链接只留文字、列表 / 引用的行首记号、多余空白。
 */
export function diaryPreview(batch: Pick<TodayBatch, 'cards'>): string {
  return batch.cards
    .map((card) => card.markdown)
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export type IdeaGroup = { label: string | null; items: TodayIdea[] };

/** 灵感按 category 分组,组的先后 = 第一次出现的先后;没写分组的归进 label = null 那一组(排在最后)。 */
export function ideaGroups(items: readonly TodayIdea[]): IdeaGroup[] {
  const groups: IdeaGroup[] = [];
  let loose: IdeaGroup | null = null;
  for (const item of items) {
    if (item.category === null || !item.category.trim()) {
      loose ??= { label: null, items: [] };
      loose.items.push(item);
      continue;
    }
    let group = groups.find((candidate) => candidate.label === item.category);
    if (!group) {
      group = { label: item.category, items: [] };
      groups.push(group);
    }
    group.items.push(item);
  }
  return loose ? [...groups, loose] : groups;
}
