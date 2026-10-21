const FLAGS = ['g', 'i', 'm', 's', 'u'];
const active = new Set(['g']);
const $ = (id) => document.getElementById(id);

const flagsEl = $('flags');
for (const flag of FLAGS) {
  const el = document.createElement('div');
  el.className = 'flag';
  el.textContent = flag;
  el.setAttribute('aria-pressed', String(active.has(flag)));
  el.addEventListener('click', () => {
    if (active.has(flag)) active.delete(flag); else active.add(flag);
    el.setAttribute('aria-pressed', String(active.has(flag)));
    run();
  });
  flagsEl.append(el);
}

const SAMPLE = {
  pattern: '(\\w+)@(\\w+\\.\\w{2,})',
  subject: [
    '联系人导出 2026-08',
    'ada@example.com   —— 负责发布',
    'grace@hopper.dev  —— 负责编译器',
    '备用:noreply@gugu.local(不要投递)',
  ].join('\n'),
};

function escapeHtml(text) {
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

function run() {
  const source = $('pattern').value;
  const subject = $('subject').value;
  const status = $('status');
  const groups = $('groups');
  groups.textContent = '';

  if (!source) {
    $('out').textContent = subject;
    status.className = 'status';
    status.textContent = '写一个模式,匹配会实时高亮。';
    title(null);
    return;
  }

  let re;
  try {
    re = new RegExp(source, [...active].join(''));
  } catch (error) {
    status.className = 'status bad';
    status.textContent = String(error.message ?? error);
    $('out').textContent = subject;
    title(null);
    return;
  }

  let html = '';
  let last = 0;
  let count = 0;
  let firstGroups = null;
  const global = active.has('g');
  // 非全局时 exec 不推进 lastIndex —— 手动只取一次,免得转成死循环。
  for (const match of global ? subject.matchAll(re) : [re.exec(subject)].filter(Boolean)) {
    const start = match.index ?? 0;
    html += escapeHtml(subject.slice(last, start));
    html += '<mark>' + escapeHtml(match[0] || '') + '</mark>';
    last = start + (match[0]?.length || 0);
    count += 1;
    if (!firstGroups && match.length > 1) firstGroups = match.slice(1);
    // 零宽匹配会让 last 停在原地,matchAll 自己会推进,这里只防重复渲染。
    if (!match[0]) break;
  }
  html += escapeHtml(subject.slice(last));
  $('out').innerHTML = html || '<span style="opacity:.5">（无文本）</span>';

  status.className = 'status';
  status.textContent = count === 0 ? '没有匹配。' : `${count} 处匹配。`;

  if (firstGroups) {
    for (const [index, value] of firstGroups.entries()) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `$${index + 1} = ${value ?? '(未参与)'}`;
      groups.append(chip);
    }
  }
  title(count);
}

// 标题跟着匹配数走:切到别的 tab 时,tab 条上仍看得见上次的结果。
function title(count) {
  if (!window.gugu) return;
  window.gugu.setTabTitle(count === null ? '正则' : `正则 (${count})`).catch(() => {});
  window.gugu.setTabBadge(count && count > 0 ? count : null).catch(() => {});
}

$('pattern').addEventListener('input', run);
$('subject').addEventListener('input', run);

if (window.gugu) {
  window.gugu.onCommand((id) => {
    if (id === 'sample') {
      $('pattern').value = SAMPLE.pattern;
      $('subject').value = SAMPLE.subject;
    } else if (id === 'clear') {
      $('pattern').value = '';
      $('subject').value = '';
    }
    run();
  });
}

$('pattern').value = SAMPLE.pattern;
$('subject').value = SAMPLE.subject;
run();
