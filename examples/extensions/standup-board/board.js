const LANES = [
  { key: 'FIXME', title: '拦路的', color: '#f0736a', mark: /\b(FIXME|BUG)\b[:：]?\s*(.*)$/i },
  { key: 'TODO', title: '在做的', color: '#6b8afd', mark: /\bTODO\b[:：]?\s*(.*)$/i },
  { key: 'NOTE', title: '留意的', color: '#c89b3f', mark: /\b(NOTE|HACK|XXX)\b[:：]?\s*(.*)$/i },
];
const CODE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|swift|rb|css|scss|md)$/i;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'out', 'coverage', '.next']);
const $ = (id) => document.getElementById(id);
let lanes = new Map();

/**
 * The working copy this board reads: the session the tab is in — said in every call (真源原则 13), read from the
 * context once.
 */
let session = null;
async function here() {
  session ??= (await window.gugu.getContext()).session?.id ?? null;
  if (!session) throw new Error('站会板看的是一条会话的工作副本：在会话里打开它');
  return { session };
}

/** The working copy's source files (an entry's id is its path there), build output left out. */
async function codeFiles(limit) {
  const entries = await window.gugu.files.list(await here());
  return entries.filter((entry) => CODE.test(entry.id) && !entry.id.split('/').some((part) => SKIP.has(part))).slice(0, limit);
}

/** Opened read-only, read once, closed. */
async function readText(entry) {
  const f = await window.gugu.files.open(entry, { readOnly: true });
  try { return f.text; } finally { f.close(); }
}

function render() {
  const cols = $('cols');
  cols.textContent = '';
  let total = 0;
  for (const lane of LANES) {
    const items = lanes.get(lane.key) ?? [];
    total += items.length;

    const col = document.createElement('div');
    col.className = 'col';

    const head = document.createElement('div');
    head.className = 'colhead';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = lane.color;
    const label = document.createElement('span');
    label.textContent = lane.title;
    const count = document.createElement('span');
    count.className = 'count';
    count.textContent = String(items.length);
    head.append(dot, label, count);

    const list = document.createElement('div');
    list.className = 'items';
    if (items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = '空';
      list.append(empty);
    }
    for (const item of items) {
      const card = document.createElement('div');
      card.className = 'card';
      const text = document.createElement('div');
      text.className = 'text';
      text.textContent = item.text;
      const where = document.createElement('div');
      where.className = 'where';
      where.textContent = `${item.path}:${item.line}`;
      card.append(text, where);
      // 桥上没有「在编辑器里打开这一行」这个动词,所以这里不假装有:
      // 点一下复制位置,粘到哪儿都行。❌ 不做一个点了没反应的卡片。
      card.addEventListener('click', () => {
        navigator.clipboard.writeText(`${item.path}:${item.line}`).then(
          () => { $('sub').textContent = `已复制 ${item.path}:${item.line}`; },
          () => { $('sub').textContent = '复制失败'; }
        );
      });
      list.append(card);
    }

    col.append(head, list);
    cols.append(col);
  }
  $('sub').textContent = total === 0 ? '干净,一条都没有。' : `${total} 条`;
  window.gugu?.setTabBadge(total || null).catch(() => {});
  window.gugu?.setTabTitle(total === 0 ? '站会' : `站会 (${total})`).catch(() => {});
}

async function scan() {
  if (!window.gugu) { $('sub').textContent = '要在咕咕任务页里跑。'; return; }
  $('sub').textContent = '正在扫描…';
  lanes = new Map(LANES.map((lane) => [lane.key, []]));
  try {
    for (const entry of await codeFiles(60)) {
      const file = entry.id;
      const source = await readText(entry);
      const lines = source.split('\n');
      for (const [index, line] of lines.entries()) {
        if (line.length > 400) continue;
        for (const lane of LANES) {
          const match = line.match(lane.mark);
          if (!match) continue;
          const text = (match[2] ?? match[1] ?? '').trim() || line.trim();
          lanes.get(lane.key).push({ text: text.slice(0, 160), path: file, line: index + 1 });
          break;
        }
      }
    }
    render();
  } catch (error) {
    $('sub').textContent = `读不到工作副本:${error?.message ?? error}`;
    window.gugu.reportError(String(error?.message ?? error)).catch(() => {});
  }
}

function summary() {
  const parts = [];
  for (const lane of LANES) {
    const items = lanes.get(lane.key) ?? [];
    if (items.length === 0) continue;
    parts.push(`**${lane.title}（${items.length}）**`);
    for (const item of items.slice(0, 5)) {
      parts.push(`- ${item.text} — \`${item.path}:${item.line}\``);
    }
    if (items.length > 5) parts.push(`- …还有 ${items.length - 5} 条`);
    parts.push('');
  }
  return parts.length === 0 ? '工作副本里没有待办标记。' : parts.join('\n').trim();
}

/**
 * agent 干的活,是这样到达这个 tab 的。
 *
 * behavior tab-extensions:「agent 通过改动工作副本里的文件来响应;tab 自己感知到文件
 * 变化并重画」—— 这是唯一的那条通道。少了它,这一栏会一直停在打开那一刻的样子,而
 * 上面那个「重扫」按钮就成了它唯一的救命稻草(❌ 让人手动按,不是设计,是漏了)。
 *
 * 攒一下再扫:一次 git checkout 会连着推来很多条。
 */
async function watchWorkspace() {
  let timer = null;
  window.gugu.files.onChanged(await here(), () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      scan();
    }, 250);
  });
}

if (window.gugu) {
  watchWorkspace().catch((error) => window.gugu.reportError(error.message));
  window.gugu.onCommand(async (id) => {
    if (id === 'rescan') return scan();
    if (id === 'post') {
      // Into the composer of the session it reads (the toolbar click is the person's gesture): they send it.
      try {
        const agent = (await window.gugu.getContext()).session?.agentId;
        await window.gugu.dispatch(summary(), { draft: true, ...(agent ? { to: { agent } } : {}) });
      } catch (error) {
        $('sub').textContent = `放不进去:${error?.message ?? error}`;
      }
    }
  });
}
scan();
