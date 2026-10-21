/**
 * 扩展调试台 —— 一个 tab 里同时回答两个问题：
 *
 *   1. 「通没通」 顶上那条判决：每个**只读**动词开页就跑一遍，谁挂了就把错误原文顶上来。
 *      十个漂亮示例证明不了 API 是活的：它们各自只用两三个动词，失败时又都长着自己的
 *      空态（「这个工作副本里没有 .sql 文件」），于是**桥坏了**和**这里确实没文件**长得
 *      一模一样 —— 曾经两个 bug 就是这么藏住的。
 *
 *   2. 「长什么样」 下面那棵树：把桥当下能看到的全部事实摊开，一个字段都不压缩，
 *      可展开折叠、可过滤、可导出 JSON。摘要是**替人做的判断**；调试时要的是原始事实。
 *      形状照 UIAutomation 的 Inspect / Chrome DevTools 的 Elements：树 + 全属性 + 导出。
 *
 * 会动到外面的动词（写文件 / 起 agent / 投轮次…）一律收在底部折叠区，点了才跑 ——
 * 一个调试面板不该在你打开它的瞬间就改你的工作副本。
 *
 * ❌ 不吞异常、❌ 不给「看起来还行」的空态：取到什么显示什么，取不到就把错误摆在原位。
 */

const $ = (id) => document.getElementById(id);
const t0 = performance.now();

const state = {
  snapshot: {},
  expanded: new Set(['["上下文"]', '["agent"]', '["只读探针"]']),
  selected: null,
  filter: '',
  auto: null,
  events: [],
  probes: [],
  firstCallMs: null,
};

// ── 懒节点：展开那一刻才去取。id 与路径解耦，刷新重建后仍然对得上。 ──────────
const LAZY = new Map();
let lazySeq = 0;
function lazy(label, load) {
  const id = `lazy#${++lazySeq}`;
  LAZY.set(id, load);
  return { __lazy: id, __label: label };
}
const isLazy = (v) => v !== null && typeof v === 'object' && typeof v.__lazy === 'string';
const isError = (v) => v !== null && typeof v === 'object' && typeof v.__error === 'string';

/** 调用失败不吞：把错误原文当成那个节点的值，让它留在树上。 */
async function safe(run) {
  try {
    return await run();
  } catch (error) {
    return { __error: String(error?.message ?? error) };
  }
}

/** 只读动词的体检：成功/失败/耗时都如实记，喂给顶上的判决行和「只读探针」那一支。 */
async function probe(name, cap, run) {
  const started = performance.now();
  try {
    const value = await run();
    const ms = performance.now() - started;
    if (state.firstCallMs === null) state.firstCallMs = performance.now() - t0;
    state.probes.push({ 动词: name, 能力: cap || '—', 结果: 'ok', 耗时ms: Math.round(ms) });
    return value;
  } catch (error) {
    const ms = performance.now() - started;
    const message = String(error?.message ?? error);
    state.probes.push({ 动词: name, 能力: cap || '—', 结果: '挂了', 错误: message, 耗时ms: Math.round(ms) });
    return { __error: message };
  }
}

const keyOf = (path) => JSON.stringify(path);
function getAt(path) {
  let cur = state.snapshot;
  for (const k of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = cur[k];
  }
  return cur;
}
function setAt(path, value) {
  let cur = state.snapshot;
  for (let i = 0; i < path.length - 1; i += 1) cur = cur[path[i]];
  cur[path[path.length - 1]] = value;
}

// ── 取数据 ──────────────────────────────────────────────────────────────────

/**
 * 这一页能读的那一处文件：在会话里是它的工作副本，在对话里是对话的工作区 —— 从 context 读出来，每次调用都点名说
 * (真源原则 13)。两处都不在（坞里）就是 null。
 */
function hereOf(context) {
  if (!context || isError(context)) return null;
  if (context.session) return { session: context.session.id };
  if (context.chat) return { chat: context.chat.id };
  return null;
}

function filesNode() {
  return lazy('gugu.files.list(here)', async () => {
    const here = hereOf(state.snapshot?.上下文);
    if (!here) return '这一页不在会话里，也不在对话里：没有可列的地方';
    const entries = await safe(() => window.gugu.files.list(here));
    if (isError(entries)) return entries;
    const out = {};
    for (const entry of entries) {
      out[entry.id] = { type: entry.type, size: entry.size, 内容: lazy(`gugu.files.open(${entry.id})`, () => safe(() => readOnce(entry))) };
    }
    return out;
  });
}

/** 打开、读一次、关掉：文本给全文，JSON 给数据。 */
async function readOnce(entry) {
  const f = await window.gugu.files.open(entry, { readOnly: true });
  try {
    return f.type === 'json' ? JSON.parse(JSON.stringify(f.data)) : f.text;
  } finally {
    f.close();
  }
}

/**
 * 哪些 agent 此刻在界面上开着 —— 从 app 状态面里捞,不是从 agent 列表里猜。
 *
 * 返回集合而不是单个 id:工作区面板会分屏,每格各有自己的当前 tab,所以
 *「当前打开的那个 agent」天生是复数。❌ 别写成 `panes[0]`。
 * 没有 `agents:read` 时每个 tab 的 `agentId` 缺席,这里自然得到空集 —— 那是
 *「没给我看」,不是「没有 agent 开着」,两者在界面上要能分开。
 */
function openAgentIds(appState) {
  if (!appState || isError(appState) || !Array.isArray(appState.panes)) return new Set();
  return new Set(appState.panes.map((pane) => pane.activeTab?.agentId).filter(Boolean));
}

async function rebuild() {
  LAZY.clear();
  state.probes = [];

  const context = await probe('getContext', '', () => window.gugu.getContext());
  const here = hereOf(context);
  const files = here
    ? await probe('files.list', 'files:read', () => window.gugu.files.list(here))
    : (state.probes.push({ 动词: 'files.list', 能力: 'files:read', 结果: '跳过', 原因: '这一页不在会话里，也不在对话里' }), null);
  // 读一个真的存在的文件 —— 读不到时要分清是「没有文件可读」还是「读失败了」。
  const first = Array.isArray(files) ? (files.find((e) => e.type !== 'binary') ?? null) : null;
  if (first) await probe('files.open', 'files:read', () => readOnce(first));
  else state.probes.push({ 动词: 'files.open', 能力: 'files:read', 结果: '跳过', 原因: '这里没有能打开的文件' });

  const agents = await probe('listAgents', 'agents:read', () => window.gugu.listAgents());
  const appState = await probe('getAppState', '', () => window.gugu.getAppState());

  // 只有「面板 + 正开着」的 agent 读得到对话：咕咕自己不存对话内容，内容在跑着的引擎里。
  // 挑不出这样一条就如实说跳过 —— ❌ 别拿一条注定被拒的去跑，那会把一条正确的拒绝画成红叉。
  const readable = Array.isArray(agents)
    ? (agents.find((a) => a.transport === 'acp' && a.isGenerating !== null)?.agentId ?? null)
    : null;
  if (readable) await probe('readAgentHistory', 'agents:history', () => window.gugu.readAgentHistory(readable));
  else
    state.probes.push({
      动词: 'readAgentHistory',
      能力: 'agents:history',
      结果: '跳过',
      原因: Array.isArray(agents)
        ? '没有正开着的面板 agent（对话内容在跑着的引擎里，咕咕自己不存）'
        : 'listAgents 没成功，见它那一行的真错误',
    });

  state.snapshot = {
    桥: {
      apiVersion: window.gugu.apiVersion,
      首次调用ms: state.firstCallMs === null ? null : Math.round(state.firstCallMs),
      动词: Object.keys(window.gugu)
        .filter((k) => typeof window.gugu[k] === 'function')
        .sort(),
    },
    上下文: context,
    能力: isError(context) ? context : (context.capabilities ?? null),
    app状态: appState,
    agent: Array.isArray(agents)
      ? agents.map((agent) => ({
          ...agent,
          // owner 的原问：「当前打开的是哪个」。答案不在 agent 自己身上 —— 它在 app 的
          // 状态面里，而且**是复数**（分屏时每格各开一个）。这里做的是把两边对起来。
          正开着: openAgentIds(appState).has(agent.agentId),
          对话历史: lazy('readAgentHistory', () => safe(() => window.gugu.readAgentHistory(agent.agentId))),
        }))
      : agents,
    工作副本: filesNode(),
    事件: state.events,
    只读探针: state.probes,
  };

  renderVerdict();
  await materializeExpanded();
  render();
}

/** 刷新后，凡是还展开着的懒节点就再取一遍 —— 否则展开状态还在、内容却空了。 */
async function materializeExpanded() {
  for (let pass = 0; pass < 6; pass += 1) {
    const pending = [];
    walk(state.snapshot, [], (path, value) => {
      if (isLazy(value) && state.expanded.has(keyOf(path))) pending.push({ path, value });
    });
    if (pending.length === 0) return;
    for (const { path, value } of pending) {
      const load = LAZY.get(value.__lazy);
      setAt(path, load ? await load() : { __error: '这个懒节点的取数函数已经不在了（刷新过？）' });
    }
  }
}

/** 只走**已经取到**的部分：懒节点不因为遍历而被触发。 */
function walk(value, path, visit) {
  if (path.length > 0) visit(path, value);
  if (isLazy(value) || isError(value) || value === null || typeof value !== 'object') return;
  for (const k of Object.keys(value)) walk(value[k], [...path, k], visit);
}

// ── 判决行 ──────────────────────────────────────────────────────────────────

function renderVerdict() {
  const el = $('verdict');
  el.textContent = '';
  const broken = state.probes.filter((p) => p.结果 === '挂了');
  const head = document.createElement('span');
  const note = document.createElement('span');
  note.className = 'note muted';
  if (broken.length === 0) {
    head.className = 'good';
    head.textContent = `✓ 桥是活的（首次调用 ${state.firstCallMs === null ? '?' : Math.round(state.firstCallMs)}ms）`;
    const skipped = state.probes.filter((p) => p.结果 === '跳过');
    note.textContent = skipped.length ? `${skipped.length} 个跳过：${skipped.map((s) => s.动词).join('、')}` : '';
  } else {
    head.className = 'bad';
    head.textContent = `✗ ${broken.length} 个动词挂了：${broken.map((b) => b.动词).join('、')}`;
    note.textContent = broken[0].错误; // 最要紧的那句原文顶到最上面
  }
  el.append(head, note);

  // owner 两次撞到同一个毛病:一个调试台最该一眼给出的东西,第一次藏在折叠里,
  // 第二次掉到七条列表的最后一条、被截在可视区外。所以「当前打开的是哪个」顶到
  // 最上面这一行 —— ❌ 别再让它靠滚动或展开才看得见。
  const open = Array.isArray(state.snapshot?.agent)
    ? state.snapshot.agent.filter((a) => a && a.正开着)
    : [];
  const line = document.createElement('div');
  line.className = 'note';
  if (!hasCap('agents:read')) {
    // ❌ 不说「没有打开」—— 那是「没给我看」,两者必须分得开。
    line.classList.add('muted');
    line.textContent = '👁 当前打开：未授权（缺 agents:read）';
  } else if (open.length === 0) {
    line.classList.add('muted');
    line.textContent = '👁 当前没有打开任何 agent';
  } else {
    // 复数:工作区面板分屏时每格各开一个,如实并排列出。
    line.textContent = `👁 当前打开：${open
      .map((a) => `${a.title || a.agentId.slice(0, 8)}（${a.status ?? '状态未知'}）`)
      .join('　／　')}`;
  }
  el.append(line);

  // owner 的第二问：「他知道我打开的是哪个项目吧？」—— 以前不知道，只能拿某一格的
  // agentId 去 listAgents() 里反查。现在 app 状态直接给，所以这里也直接显示。
  // 项目与会话同一层级，就并排放同一行。
  const app = state.snapshot?.app状态;
  if (app && !isError(app)) {
    const where = document.createElement('div');
    where.className = 'note muted';
    where.textContent =
      app.activeSessionId === null
        ? '📍 当前没有会话视图在屏上'
        : `📍 项目 ${short(app.activeProjectId)} · 会话 ${short(app.activeSessionId)}`;
    el.append(where);
  }
}

/** id 太长会把这一行挤爆；❌ 不省略成空 —— 那样「没给」和「短」就分不开了。 */
function short(id) {
  if (typeof id !== 'string' || !id) return '（无）';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

/** 当下真正握着的能力(撤销之后的那一份),不是 manifest 里声明的那一份。 */
function hasCap(word) {
  const caps = state.snapshot?.上下文?.capabilities;
  if (!Array.isArray(caps)) return false;
  return caps.includes(word) || caps.includes(`${word}:all`);
}

// ── 画树 ────────────────────────────────────────────────────────────────────

function preview(value) {
  if (isLazy(value)) return { text: `⟨展开取 · ${value.__label}⟩`, cls: 'meta' };
  if (isError(value)) return { text: value.__error, cls: 'err' };
  if (value === null) return { text: 'null', cls: 'null' };
  if (Array.isArray(value)) return { text: `[${value.length}]`, cls: 'meta' };
  if (typeof value === 'object') {
    const keys = Object.keys(value);
    // agent 那一条的摘要行直接把状态带出来 —— 否则「它现在什么情况」要逐个展开才看得到，
    // 而这正是一个调试台最该一眼给出的东西。
    const isAgent = typeof value.agentId === 'string' && 'status' in value;
    if (isAgent) {
      const bits = [
        typeof value.title === 'string' ? value.title : value.agentId.slice(0, 8),
        value.status ?? '状态未知',
        value.transport === 'acp' ? '面板' : '终端',
      ];
      if (value.正开着 === true) bits.push('👁 当前打开');
      if (value.isGenerating === true) bits.push('⏳ 生成中');
      if (value.pendingPermissionCount) bits.push(`待批 ${value.pendingPermissionCount}`);
      if (value.queuedPromptCount) bits.push(`排队 ${value.queuedPromptCount}`);
      return { text: `{${keys.length}} ${bits.join(' · ')}`, cls: 'meta' };
    }
    const hint = typeof value.title === 'string' ? ` ${value.title}` : '';
    return { text: `{${keys.length}}${hint}`, cls: 'meta' };
  }
  if (typeof value === 'string') return { text: value, cls: 'str' };
  if (typeof value === 'number') return { text: String(value), cls: 'num' };
  if (typeof value === 'boolean') return { text: String(value), cls: 'bool' };
  return { text: String(value), cls: '' };
}

const expandable = (v) =>
  isLazy(v) || (!isError(v) && v !== null && typeof v === 'object' && Object.keys(v).length > 0);

/** 过滤：命中的行 + 它的所有祖先。❌ 不连带整棵子树 —— 那样过滤等于没过滤。 */
function filterPaths() {
  if (!state.filter) return null;
  const needle = state.filter.toLowerCase();
  const keep = new Set();
  walk(state.snapshot, [], (path, value) => {
    const hay = `${path[path.length - 1]} ${preview(value).text}`.toLowerCase();
    if (!hay.includes(needle)) return;
    for (let i = 1; i <= path.length; i += 1) keep.add(keyOf(path.slice(0, i)));
  });
  return keep;
}

function render() {
  const host = $('tree');
  host.textContent = '';
  const keep = filterPaths();

  const emit = (value, path, depth) => {
    const pk = keyOf(path);
    if (keep && !keep.has(pk)) return;

    const row = document.createElement('div');
    row.className = 'node' + (state.selected === pk ? ' sel' : '');
    row.style.paddingLeft = `${depth * 12 + 4}px`;

    const open = state.expanded.has(pk);
    const twisty = document.createElement('span');
    twisty.className = 'twisty' + (expandable(value) ? '' : ' leaf');
    twisty.textContent = open ? '▾' : '▸';
    twisty.addEventListener('click', (e) => {
      e.stopPropagation();
      void toggle(path, value);
    });

    const k = document.createElement('span');
    k.className = 'k';
    k.textContent = path[path.length - 1];

    const sep = document.createElement('span');
    sep.className = 'sep';
    sep.textContent = ':';

    const p = preview(value);
    const v = document.createElement('span');
    v.className = `v ${p.cls}`;
    v.textContent = p.text;

    row.append(twisty, k, sep, v);
    row.addEventListener('click', () => {
      state.selected = pk;
      $('selpath').textContent = path.join(' › ');
      render();
    });
    host.appendChild(row);

    if (!open || isLazy(value) || isError(value) || value === null || typeof value !== 'object') return;
    for (const childKey of Object.keys(value)) emit(value[childKey], [...path, childKey], depth + 1);
  };

  for (const rootKey of Object.keys(state.snapshot)) emit(state.snapshot[rootKey], [rootKey], 0);
  if (host.children.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = state.filter ? `没有命中「${state.filter}」的节点` : '空';
    host.appendChild(hint);
  }
}

async function toggle(path, value) {
  const pk = keyOf(path);
  if (state.expanded.has(pk)) {
    state.expanded.delete(pk);
    render();
    return;
  }
  state.expanded.add(pk);
  if (isLazy(value)) {
    const load = LAZY.get(value.__lazy);
    setAt(path, load ? await load() : { __error: '这个懒节点的取数函数已经不在了' });
  }
  render();
}

// ── 导出 / 工具条 ───────────────────────────────────────────────────────────

/** 导出用的可读快照：没展开的懒节点如实标注，❌ 不冒充成空。 */
function plain(value) {
  if (isLazy(value)) return `⟨未展开 · ${value.__label}⟩`;
  if (isError(value)) return { 错误: value.__error };
  if (Array.isArray(value)) return value.map(plain);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = plain(value[k]);
    return out;
  }
  return value;
}

function flash(message) {
  const el = $('selpath');
  const before = el.textContent;
  el.textContent = message;
  setTimeout(() => {
    el.textContent = before;
  }, 1600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    flash(`已复制 ${text.length} 字符`);
    return;
  } catch {
    // 剪贴板权限可能被拒 —— 退回到选中一个 textarea 让人手动 ⌘C，❌ 不假装成功。
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;left:0;bottom:0;width:100%;height:80px;z-index:9';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand && document.execCommand('copy');
  ta.remove();
  flash(ok ? `已复制 ${text.length} 字符` : '复制被拒 —— 展开节点手动选文本');
}

function expandAllLoaded() {
  walk(state.snapshot, [], (path, value) => {
    if (expandable(value) && !isLazy(value)) state.expanded.add(keyOf(path));
  });
  render();
}

function copyAll() {
  return copyText(JSON.stringify(plain(state.snapshot), null, 2));
}

// ── 事件：payload 原文进树，不做摘要 ────────────────────────────────────────

function pushEvent(type, payload) {
  state.events.unshift({ 时刻: new Date().toISOString(), 类型: type, 载荷: payload });
  if (state.events.length > 100) state.events.length = 100;
  if (state.snapshot.事件) {
    state.snapshot.事件 = state.events;
    render();
  }
}

// ── 会动东西的动作 ──────────────────────────────────────────────────────────

function action(id, label, run) {
  $(id).addEventListener('click', async () => {
    const out = $('action-out');
    out.textContent = `${label}…`;
    out.className = 'out muted';
    try {
      out.textContent = `✓ ${label}：${await run()}`;
      out.className = 'out good';
    } catch (error) {
      out.textContent = `✗ ${label}：${error?.message ?? error}`;
      out.className = 'out bad';
    }
  });
}

if (!window.gugu) {
  $('verdict').textContent = '✗ window.gugu 不存在 —— 这一页不是跑在咕咕的扩展沙箱里';
  $('verdict').className = 'verdict bad';
} else {
  $('refresh').addEventListener('click', () => void rebuild());
  $('expand').addEventListener('click', expandAllLoaded);
  $('collapse').addEventListener('click', () => {
    state.expanded.clear();
    render();
  });
  $('copy').addEventListener('click', () => void copyAll());
  $('copysel').addEventListener('click', () => {
    if (!state.selected) return flash('先点一个节点');
    return void copyText(JSON.stringify(plain(getAt(JSON.parse(state.selected))), null, 2));
  });
  $('filter').addEventListener('input', (e) => {
    state.filter = e.target.value.trim();
    render();
  });
  $('auto').addEventListener('click', () => {
    const btn = $('auto');
    if (state.auto) {
      clearInterval(state.auto);
      state.auto = null;
      btn.setAttribute('aria-pressed', 'false');
      return;
    }
    state.auto = setInterval(() => void rebuild(), 3000);
    btn.setAttribute('aria-pressed', 'true');
  });

  action('do-write', 'files.open', async () => {
    const name = 'gugu-ext-debug.probe';
    const stamp = `写于 ${new Date().toISOString()}\n`;
    const here = hereOf(state.snapshot?.上下文);
    if (!here) throw new Error('这一页不在会话里，也不在对话里：没有可写的地方');
    const entry = (await window.gugu.files.list(here)).find((e) => e.name === name) ?? (await window.gugu.files.create({ ...here, name }, ''));
    const f = await window.gugu.files.open(entry);
    f.delete(0, f.length);
    f.insert(0, stamp);
    f.close();
    // 关掉再打开读回来 —— 只看「没抛错」证明不了它真的写进去了。
    const back = await readOnce(entry);
    return back === stamp ? `${name} 写入并读回一致` : `${name} 写了，但读回的内容对不上`;
  });
  action('do-compose', 'compose', async () => {
    const here = hereOf(state.snapshot?.上下文);
    if (!here) throw new Error('这一页不在会话里，也不在对话里：没有能放进去的输入框');
    await window.gugu.compose('这句来自扩展调试台。', here);
    return '已放进对话的输入框（没发，按发送才发）';
  });
  action('do-open', 'openBrowserTab', async () => {
    await window.gugu.openBrowserTab('https://example.com/');
    return '宿主应已开出一个浏览器 tab';
  });
  action('do-error', 'reportError', async () => {
    await window.gugu.reportError('这是调试台故意报的一个错。');
    return 'tab 上应出现错误标记';
  });
  action('do-title', 'setTabTitle/Badge', async () => {
    await window.gugu.setTabTitle('调试台 ✓');
    await window.gugu.setTabBadge(3);
    return '标题应变成「调试台 ✓」，角标应显示 3';
  });
  action('do-net', 'fetch(声明过的 host)', async () => {
    const response = await fetch('https://example.com/', { cache: 'no-store' });
    return `HTTP ${response.status}（声明过的 host 才该通）`;
  });

  // 这三个会真的起/停 agent、花额度 —— 只在人点的时候跑，且只动**自己起的**那一条。
  // ❌ 别对 listAgents()[0] 动手：声明了 :all 的话，排第一的很可能是别的项目里正在
  // 干活的真 agent —— 一个调试面板不该往别人的会话里投轮次、更不该把它停掉。
  let ownAgentId = null;
  action('do-spawn', 'spawnAgent', async () => {
    const { agentId } = await window.gugu.spawnAgent('这是扩展调试台起的一个 agent，回一句「收到」就好。', { title: '调试台起的' });
    ownAgentId = agentId;
    void rebuild();
    return `起来了：${agentId.slice(0, 8)}…（左边多出一条会话，标题前有个小方块图标，悬停显示「由扩展「…」发起」）`;
  });
  action('do-send', 'messageAgent', async () => {
    if (!ownAgentId) return '先按上面的「起一个 agent」—— 只往自己起的那条投，不碰别人的';
    const { id } = await window.gugu.messageAgent(ownAgentId, '这一轮来自扩展调试台。');
    return `已投给自己起的 ${ownAgentId.slice(0, 8)}…（消息 ${id.slice(0, 8)}…）`;
  });
  action('do-stop', 'stopAgent', async () => {
    if (!ownAgentId) return '先按上面的「起一个 agent」—— 只停自己起的那条，不碰别人的';
    await window.gugu.stopAgent(ownAgentId);
    void rebuild();
    return `已停自己起的 ${ownAgentId.slice(0, 8)}…（它照样留在左边，标记不会因为停了就没）`;
  });

  window.gugu.onContextChanged((context) => {
    pushEvent('onContextChanged', context);
    state.snapshot.上下文 = context;
    state.snapshot.能力 = context.capabilities ?? null;
    render();
  });
  // 听这一页所在的那一处（点名说）；context 换了地方就换着听。
  let unwatch = null;
  let watching = null;
  const watchHere = (context) => {
    const here = hereOf(context);
    const key = here ? JSON.stringify(here) : null;
    if (key === watching) return;
    unwatch?.();
    watching = key;
    unwatch = here ? window.gugu.files.onChanged(here, (change) => pushEvent('files.onChanged', change)) : null;
  };
  window.gugu.getContext().then(watchHere, (error) => pushEvent('getContext', error.message));
  window.gugu.onContextChanged(watchHere);
  // 这两条是「app 的状态面」的推送半边：不订它就只能反复点刷新。
  window.gugu.onAppStateChanged((next) => {
    pushEvent('onAppStateChanged', next);
    if (!state.snapshot) return;
    state.snapshot.app状态 = next;
    // 「正开着」是两边对出来的,所以状态面一动就得重算 —— 只换掉 app状态 那一支,
    // agent 行上的标记会留在上一次的答案上,而那正是这块面板要回答的问题。
    const open = openAgentIds(next);
    if (Array.isArray(state.snapshot.agent)) {
      for (const agent of state.snapshot.agent) agent.正开着 = open.has(agent.agentId);
    }
    renderVerdict();
    render();
  });
  window.gugu.onAgentsChanged((agentIds) => pushEvent('onAgentsChanged', agentIds));
  window.gugu.onCommand((commandId) => {
    pushEvent('onCommand', { commandId });
    if (commandId === 'rerun') void rebuild();
    if (commandId === 'expand-all') expandAllLoaded();
    if (commandId === 'collapse-all') {
      state.expanded.clear();
      render();
    }
    if (commandId === 'copy-json') void copyAll();
  });

  void rebuild();
}
