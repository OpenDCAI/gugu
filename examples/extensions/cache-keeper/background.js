/**
 * cache 保温器 —— 后台页:一只钟。
 *
 * 会话的提示缓存,在它最后一次请求之后的 TTL 内是热的(订阅账号实测 1 小时)。热着再用一轮,
 * 上下文按 0.1 倍读回;凉了,就得按约 1.9 倍整份重写。所以在它快凉的时候替它发一轮最便宜的
 * ping,缓存就续上了。
 *
 * 钟为什么放在这里:会话闲 10 分钟、又不在屏上,咕咕就把它的引擎进程收了。设在 agent 自己身上
 * 的定时器跟着一起没了;而后台页没人开着也在走。一条消息会把收掉的会话按原会话拉起来。
 *
 * 一切状态(开关、看到的空闲时刻、账本)都在这里,存进自己的 data;视图只负责画。
 */

const TICK_MS = 60_000;
/** 一次热 ping 大约花上下文的 0.11 倍(车道实测 0.10–0.16)。 */
const PING_COST = 0.11;
/** 凉了再用,大约花上下文的 1.9 倍(1 小时 TTL 实测 1.79–1.95)。 */
const COLD_COST = 1.9;
/** ping 发出去 5 分钟还没见它跑完,就当这次没成。 */
const PING_SETTLE_MS = 5 * 60_000;
/** ping 失败、或 ping 之后会话报错:所有 ping 停这么久。 */
const BACKOFF_MS = 30 * 60_000;
/** 排队续上报错的会话时,两条之间隔多久 —— 别让一群会话在同一分钟里一起重写上下文。 */
const RESUME_GAP_MS = 2 * 60_000;

const PING_TEXT = '(cache 保温器)保温 ping:这一轮什么都不用做,不调用工具,只输出 [NO_REPLY]。';
const RESUME_TEXT = '(cache 保温器)你上一轮报错停下了。额度应当已经恢复:接着做被打断的那件事。';

const g = window.gugu;
let state = {
  version: 1,
  enabled: true,
  ttlMinutes: 60,
  /** agentId → true:要保温的会话。 */
  keep: {},
  /** agentId → 这个会话上看到的事实(见 observe)。 */
  agents: {},
  pausedUntil: null,
  pauseReason: null,
  /** 等着依次续上的会话。 */
  resumeQueue: [],
  nextResumeAt: 0,
  /** 账号额度快满或被拒(listAgents 的 rateLimit):{ status, until, window }。until 之前什么都不发。 */
  limit: null,
  ledger: { pings: 0, pingCost: 0, saved: 0 },
  lastError: null,
};

const now = () => Date.now();
/**
 * 提前多久 ping:钟一分钟走一次,ping 从投递到真请求出去还要一会儿(引擎被收了要先拉起来),所以 5 分钟的 TTL
 * 要提前 2 分钟;只提前 1 分钟时,mac1 上实测有一次 ping 晚到 50 秒,本身成了冷启动。1 小时的 TTL 提前 5 分钟。
 */
const leadMs = () => Math.min(5, state.ttlMinutes * 0.4) * 60_000;

async function load() {
  const raw = await g.readData('state.json');
  if (raw === null) return;
  const saved = JSON.parse(raw);
  if (saved.version !== 1) throw new Error(`state.json is version ${saved.version}; this build reads 1`);
  state = { ...state, ...saved };
  // 重启之前看到的状态不能拿来推「转成了空闲」:引擎随应用一起没了,第一眼重新看。
  // 空闲时刻留着:缓存在服务端,应用重启不会让它凉。
  for (const rec of Object.values(state.agents)) {
    rec.status = undefined;
    rec.pingPending = null;
    rec.pingLate = false;
    rec.resumePending = null;
  }
}

async function save() {
  await g.writeData('state.json', JSON.stringify(state));
  await g.broadcastToViews({ type: 'state', state, at: now() });
}

function pause(reason) {
  state.pausedUntil = now() + BACKOFF_MS;
  state.pauseReason = reason;
  state.resumeQueue = [];
}

/** 把 listAgents 读到的事实并进记录;状态的转变是这里唯一的时钟来源。 */
function observe(list) {
  const seen = new Set();
  for (const a of list) {
    seen.add(a.agentId);
    const rec = (state.agents[a.agentId] ??= {
      idleSince: null, cold: false, pings: 0, totalPings: 0, saved: 0, pingPending: null, resumePending: null,
    });
    rec.title = a.title;
    rec.transport = a.transport;
    rec.updatedAt = a.updatedAt;
    if (a.contextTokens !== null) rec.contextTokens = a.contextTokens;
    const was = rec.status;
    rec.status = a.status;
    // 空闲时刻只从亲眼看到的「跑完 → 空闲」算起。第一眼(刚装上、刚重启)不推它:没看到它跑完,就不知道
    // 缓存凉没凉,不 ping,等它下次真用过再接着保温。
    if (was === undefined || a.status === was) continue;

    if (a.status === 'working') {
      const ours = rec.pingPending !== null || rec.resumePending !== null;
      const warm = rec.idleSince !== null && now() < rec.idleSince + state.ttlMinutes * 60_000;
      // 一次 ping 要是晚到、缓存已经凉了,它本身就是一次冷启动:账上照实记(mac1 实测过一次)。
      if (rec.pingPending !== null) rec.pingLate = !warm;
      if (!ours && rec.pings > 0 && warm && rec.contextTokens) {
        // 真用上了:这段保温省下的 = 一次冷启动 − 这段里的 ping。
        const saved = (COLD_COST - rec.pings * PING_COST) * rec.contextTokens;
        rec.saved += saved;
        state.ledger.saved += saved;
      }
      if (!ours) rec.pings = 0;
    } else if (a.status === 'idle') {
      rec.idleSince = now();
      rec.cold = false;
      if (rec.pingPending !== null) {
        // 晚到的那次重写了整份缓存:这段保温从它重新算起。
        rec.pings = rec.pingLate ? 0 : rec.pings + 1;
        rec.totalPings += 1;
        rec.lastPing = { at: rec.pingPending, outcome: rec.pingLate ? 'late' : 'ok' };
        state.ledger.pings += 1;
        state.ledger.pingCost += (rec.pingLate ? COLD_COST : PING_COST) * (rec.contextTokens ?? 0);
        rec.pingPending = null;
        rec.pingLate = false;
      }
      rec.resumePending = null;
    } else if (a.status === 'error') {
      if (rec.pingPending !== null) {
        rec.lastPing = { at: rec.pingPending, outcome: 'error' };
        rec.pingPending = null;
        pause(`ping 之后「${rec.title}」报错了(多半是额度)`);
      }
      if (rec.resumePending !== null) {
        rec.resumePending = null;
        pause(`续上的「${rec.title}」又报错了,额度大概还没恢复`);
      }
    }
  }
  for (const id of Object.keys(state.agents)) {
    if (!seen.has(id)) {
      delete state.agents[id];
      delete state.keep[id];
    }
  }
  // 账号额度:引擎只在变化时报,会话进程被收了读数也就没了,所以记在自己这里。哪个会话说「快满 / 被拒」到某个时刻,
  // 那之前都不发;取最晚的那个时刻。
  for (const a of list) {
    const r = a.rateLimit;
    const until = r?.resetsAt ? Date.parse(r.resetsAt) : NaN;
    if (!r || r.status === 'allowed' || !(until > now())) continue;
    if (!state.limit || until > state.limit.until) state.limit = { status: r.status, until, window: r.window };
  }
}

/** 勾着的、停在报错上的会话,按最近交过轮的先后排队,间隔 RESUME_GAP_MS 一个一个续。 */
function queueErrored() {
  state.resumeQueue = Object.entries(state.agents)
    .filter(([id, rec]) => state.keep[id] && rec.status === 'error')
    .sort(([, a], [, b]) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .map(([id]) => id);
  state.nextResumeAt = 0;
}

/** 每分钟一次:到期的保温、排队的续上,一次只动一个会话。 */
async function tick() {
  if (!state.enabled) return;
  const t = now();
  if (state.limit) {
    // 额度快满或被拒:ping 会花掉别的会话真要用的额度,续上也续不动 —— 等这个窗口重置。
    if (t < state.limit.until) return;
    // 重置了:报错停下的会话错开续上,别让一群会话在同一分钟里各自重写一遍上下文。
    state.limit = null;
    queueErrored();
  }
  if (state.pausedUntil !== null) {
    if (t < state.pausedUntil) return;
    state.pausedUntil = null;
    state.pauseReason = null;
  }
  const entries = Object.entries(state.agents);
  for (const [, rec] of entries) {
    if (rec.pingPending !== null && t - rec.pingPending > PING_SETTLE_MS) {
      rec.lastPing = { at: rec.pingPending, outcome: 'no-answer' };
      rec.pingPending = null;
      pause(`ping「${rec.title}」5 分钟没跑完`);
      return;
    }
  }
  if (entries.some(([, rec]) => rec.pingPending !== null || rec.resumePending !== null)) return;

  if (state.resumeQueue.length > 0 && t >= state.nextResumeAt) {
    const id = state.resumeQueue.shift();
    const rec = state.agents[id];
    if (rec?.status === 'error') {
      rec.resumePending = t;
      state.nextResumeAt = t + RESUME_GAP_MS;
      await deliver(id, rec, RESUME_TEXT, 'resumePending');
      return;
    }
  }

  let due = null;
  for (const [id, rec] of entries) {
    if (!state.keep[id] || rec.status !== 'idle' || rec.idleSince === null || rec.cold) continue;
    const expiry = rec.idleSince + state.ttlMinutes * 60_000;
    if (t >= expiry) {
      rec.cold = true; // 已经凉了:再 ping 就是一次冷启动,不划算。等它下次真用过再保温。
      continue;
    }
    if (t >= expiry - leadMs() && (due === null || expiry < due.expiry)) due = { id, rec, expiry };
  }
  if (due) {
    due.rec.pingPending = t;
    await deliver(due.id, due.rec, PING_TEXT, 'pingPending');
  }
}

async function deliver(id, rec, text, pendingField) {
  try {
    await g.messageAgent(id, text);
  } catch (error) {
    rec[pendingField] = null;
    if (pendingField === 'pingPending') rec.lastPing = { at: now(), outcome: 'failed', error: String(error?.message ?? error) };
    pause(`发给「${rec.title}」失败:${error?.message ?? error}`);
  }
}

let running = null;
/** 读一遍、并一遍、走一步、存一遍。同一时刻只跑一遍;跑的时候又来的,跑完再补一遍。 */
function cycle() {
  if (running) {
    running.again = true;
    return running.done;
  }
  running = { again: false, done: null };
  running.done = (async () => {
    do {
      running.again = false;
      try {
        observe(await g.listAgents());
        await tick();
        state.lastError = null;
      } catch (error) {
        state.lastError = String(error?.message ?? error);
      }
      await save();
    } while (running.again);
    running = null;
  })();
  return running.done;
}

g.onViewMessage((message) => {
  switch (message?.type) {
    case 'keep':
      if (message.on) state.keep[message.agentId] = true;
      else delete state.keep[message.agentId];
      break;
    case 'enabled':
      state.enabled = Boolean(message.on);
      break;
    case 'ttl':
      state.ttlMinutes = message.minutes === 5 ? 5 : 60;
      break;
    case 'resume-errored':
      queueErrored();
      break;
    case 'unpause':
      state.pausedUntil = null;
      state.pauseReason = null;
      break;
    case 'hello':
      break;
    default:
      return;
  }
  void cycle();
});

let changed = null;
g.onAgentsChanged(() => {
  // 一串变化合成一次读:它只说「有东西动了」,细节 listAgents 自己去问。
  clearTimeout(changed);
  changed = setTimeout(() => void cycle(), 500);
});

load()
  .catch((error) => {
    state.lastError = `读不出上次的状态:${error?.message ?? error}`;
  })
  .then(() => cycle())
  .then(() => setInterval(() => void cycle(), TICK_MS));
