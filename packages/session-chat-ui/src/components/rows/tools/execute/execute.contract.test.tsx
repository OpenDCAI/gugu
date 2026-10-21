/** @jsxImportSource solid-js */
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { createChatCaches, type ChatCaches } from '@session-chat/core/caches';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import { DEFAULT_THEME } from '@session-chat/core/theme';
import type { ChatExecute } from '@session-chat/model';
import { render } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import { applyTokensWithSoftWraps } from './Execute';
import { collapseHeaderLabel } from '@session-chat/components/primitives/collapse-header.css';
import { labelShortfall } from '@session-chat/tests/contract';
import { executeBody, executeLine } from './execute.css';
import { vars } from '@session-chat/styles/theme.css';
import { executeUnitDef } from './execute.def';
import { createExecuteLines, EXECUTE_SCROLLBAR_GUTTER_X } from './execute.layout';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

/**
 * Highlight the command into `caches` before mounting, so Execute paints its
 * tokens synchronously on its cache-hit path instead of from an idle callback.
 *
 * @@@no-idle-wait (#6339) — a no-timeout `requestIdleCallback` has no delivery
 * guarantee: Chromium only runs it in an idle period, and a main thread whose frames
 * overrun their budget never gets one, while rAF keeps firing. The tester page keeps
 * every finished file's iframe alive on that same thread, so anything left running
 * there can starve it; this case once sat in that wait until the CI job limit. The
 * highlighted DOM is what the case measures, so it is produced here and checked at
 * mount as a fact rather than waited for as an event.
 */
function warmCommandHighlight(caches: ChatCaches, item: ChatExecute): void {
  const source = createExecuteLines(item)
    .filter((line) => line.kind === 'command')
    .map((line) => line.text)
    .join('\n');
  if (!caches.highlight(source, 'bash')) {
    throw new Error(`the bash highlighter produced no tokens for ${JSON.stringify(source)}`);
  }
}

function executeItem(command: string, outputText?: string): ChatExecute {
  return {
    kind: 'execute',
    id: 'execute-contract',
    command,
    ...(outputText === undefined ? {} : { outputText }),
    status: 'done',
    startedAt: 0,
  };
}

async function mountExecute(
  item: ChatExecute,
  width: number,
  expanded: boolean,
  theme: 'light' | 'dark' = 'light',
  caches: ChatCaches = createChatCaches(),
) {
  const isCollapsed = () => expanded;
  const measureCtx: MeasureCtx = {
    theme: DEFAULT_THEME,
    width,
    isCollapsed,
    expanded: isCollapsed,
    caches,
  };
  const renderCtx: RenderCtx = {
    viewState: { isCollapsed },
    measureCtx: () => measureCtx,
  };
  const host = document.createElement('div');
  host.style.width = `${width}px`;
  // Colours are class-themed rather than var-injected (see ThemeVarKey), so the
  // dark palette only exists under this class — reading colour without it would
  // read the light palette twice and call it two themes.
  if (theme === 'dark') host.classList.add('emdark');
  document.body.appendChild(host);

  const dispose = render(
    () => (
      <ThemeContext.Provider value={() => DEFAULT_THEME}>
        <CachesContext.Provider value={caches}>
          <executeUnitDef.Render data={item} ctx={renderCtx} vars={executeUnitDef.vars!} />
        </CachesContext.Provider>
      </ThemeContext.Provider>
    ),
    host,
  );

  await document.fonts.ready;
  await nextPaint();

  return { dispose, host, measureCtx };
}

describe('Execute command wrapping contract', () => {
  it('preserves highlighted tokens when wraps land on and within token boundaries', () => {
    const element = document.createElement('div');

    applyTokensWithSoftWraps(
      element,
      [
        { content: 'ab', htmlStyle: { color: 'rgb(255, 0, 0)' } },
        { content: 'cdef', htmlStyle: { color: 'rgb(0, 0, 255)' } },
        { content: 'gh' },
      ],
      [2, 5],
    );

    expect(element.textContent).toBe('ab\ncde\nfgh');
    expect(
      [...element.querySelectorAll('span')].map((span) => [span.textContent, span.style.color]),
    ).toEqual([
      ['ab', 'rgb(255, 0, 0)'],
      ['cde', 'rgb(0, 0, 255)'],
      ['f', 'rgb(0, 0, 255)'],
    ]);
  });

  it('matches the measured height to Chromium natural layout at punctuation boundaries', async () => {
    const item = executeItem('echo (alpha)[beta]{gamma};delta|epsilon&&zeta||eta');
    const caches = createChatCaches();
    warmCommandHighlight(caches, item);
    const mounted = await mountExecute(item, 306, true, 'light', caches);

    try {
      const command = mounted.host.querySelector(`.${executeLine}`) as HTMLElement;
      // The wraps under test are the ones painted into highlighted tokens. Unpainted,
      // the line would be measured against its plain-text fallback instead.
      expect(
        command.querySelector('span'),
        'Execute did not paint the warmed highlight at mount (cache key drifted?)',
      ).not.toBeNull();
      const measuredHeight = command.offsetHeight;

      // Reading offsetHeight forces layout, so the natural height is read synchronously.
      command.style.height = 'auto';

      expect(command.offsetHeight).toBe(measuredHeight);
      expect(command.textContent?.split('\n')).toHaveLength(
        measuredHeight / DEFAULT_THEME.fonts.code.lineHeight,
      );
    } finally {
      mounted.dispose();
      mounted.host.remove();
    }
  });

  it('wraps a long shell command without horizontal overflow and exposes it when expanded', async () => {
    const item = executeItem(
      "sed -n '1,220p' package.json && printf '\\n---README---\\n' && sed -n '1,260p' README.md",
    );
    const mounted = await mountExecute(item, 320, true);

    try {
      const card = mounted.host.firstElementChild as HTMLElement;
      const body = mounted.host.querySelector(`.${executeBody}`) as HTMLElement;
      const command = mounted.host.querySelector(`.${executeLine}`) as HTMLElement;

      expect(card.offsetHeight).toBe(
        executeUnitDef.measure(item, mounted.measureCtx, executeUnitDef.vars!),
      );
      expect(command.offsetHeight).toBeGreaterThan(DEFAULT_THEME.fonts.code.lineHeight);
      expect(command.scrollHeight).toBe(command.offsetHeight);
      expect(command.scrollWidth).toBeLessThanOrEqual(command.clientWidth + 1);
      expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1);
      expect(body.scrollHeight).toBe(body.clientHeight);
    } finally {
      mounted.dispose();
      mounted.host.remove();
    }
  });

  // #4981:折叠档不再摊开命令 —— 命令走表头那颗片。这条原来断言「折叠预览正好两行代码」,
  // 那正是 owner 指着说「shell 参数特别裸露地暴露出来」的那个形状,所以断言跟着形状一起换。
  it('collapses to the header alone and puts the command in the chip', async () => {
    const command = `printf ${'a'.repeat(180)}`;
    const mounted = await mountExecute(executeItem(command), 280, false);

    try {
      const body = mounted.host.querySelector(`.${executeBody}`) as HTMLElement | null;
      // body 要么不渲染,要么零高 —— 两种都算「折叠档一行命令都不摊开」。
      expect(body?.clientHeight ?? 0).toBe(0);

      const chip = mounted.host.querySelector('[data-slot="tool-call-query"]') as HTMLElement;
      expect(chip).toBeTruthy();
      // 片带的是命令原文(不含 `$` 提示符),而不是某个概括词。
      expect(chip.textContent).toBe(command);
      // 一行,且被行宽收住 —— 否则一条长命令会把退出状态顶出固定高度的表头。
      expect(chip.scrollWidth).toBeGreaterThan(chip.clientWidth);
      expect(chip.offsetHeight).toBeLessThan(DEFAULT_THEME.fonts.body.lineHeight * 2);
    } finally {
      mounted.dispose();
      mounted.host.remove();
    }
  });

  // 上一条只量了片,没量标签 —— 于是真机上「执行」被挤成「执 / 行」两行谁也没发现
  // (owner 验收截图 2026-09-04)。
  //
  // ⚠️ 标签必须是**中文**这条判据才判得动:CJK 的 min-content 是一个字,英文是一个词。
  // 第一版用了默认译文(英文),把断行规则改回去照样绿 —— 一条永远不会红的判据。
  // 这里显式喂中文 inputSummary,把「标签是 CJK」这一个自由度补上。
  //
  // 守的那条规矩已经从 execute 自己的 `keep-all` 换成了共享表头的 `collapseHeaderLabel`
  // (一行 + 省略号,#4981):`keep-all` 只挡住中文拆字,英文照旧在空格处折行。判据因此
  // 改指共享那个类,牙口不变 —— 去掉 `white-space: nowrap` 这一条当场红。
  it('keeps a CJK header label on one line when a long command squeezes it', async () => {
    const item: ChatExecute = {
      ...executeItem(
        "ls -la && git log --oneline --all -5 && find . -maxdepth 3 -type f -print",
      ),
      inputSummary: '执行',
    };
    const mounted = await mountExecute(item, 280, false);

    try {
      const header = mounted.host.querySelector('[data-slot="collapse-header"]') as HTMLElement;
      const label = header.querySelector(`.${collapseHeaderLabel}`) as HTMLElement;
      expect(label).toBeTruthy();
      expect(label.textContent?.trim()).toBe('执行');
      // 一行 = 标签自身高度不超过一个正文行高。断成「执 / 行」会翻倍,立刻红。
      expect(label.offsetHeight).toBeLessThanOrEqual(DEFAULT_THEME.fonts.body.lineHeight);
    } finally {
      mounted.dispose();
      mounted.host.remove();
    }
  });

  // 上一条只量了**高**(没折行),没量**宽** —— 于是真机上「执行」被省略号吃成「执.」
  // 谁也没发现(owner 验收 case4,2026-09-05 截图)。一行且被截断,高度判据照样绿。
  //
  // 病理是 flex 的收缩按「基准宽 x 收缩系数」分摊:命令片的基准宽是标签的上百倍,
  // 但标签那一份摊下来仍有十几 px,而标签总共才二十几 px ⇒ 两个字被吃掉一个。
  // ⇒ 片必须**先**让位。判据钉的是结果(标签一个字都不许少),不是实现手段。
  it('never ellipsizes the header verb, however long the command', async () => {
    const item: ChatExecute = {
      ...executeItem(
        `git -C /Users/apple/.gugu-4981/task-home diff -- README.md && ${'echo x && '.repeat(40)}true`
      ),
      inputSummary: '执行',
    };
    const mounted = await mountExecute(item, 280, false);

    try {
      const header = mounted.host.querySelector('[data-slot="collapse-header"]') as HTMLElement;
      const label = header.querySelector(`.${collapseHeaderLabel}`) as HTMLElement;
      const chip = header.querySelector('[data-slot="tool-call-query"]') as HTMLElement;
      expect(label.textContent?.trim()).toBe('执行');
      // 阳控:片确实挤不下 —— 否则没人跟标签抢地方,下面那条判据证明不了什么。
      expect(chip.scrollWidth).toBeGreaterThan(chip.clientWidth);
      // ❌ 「scrollWidth ≤ clientWidth + 1」:两个都是取整的,少 0.09px 读出来是 28 对 28,
      // 而省略号只要少一点点就画 —— 那条判据一直绿着,「执…」就在真机上(owner 2026-10-16)。
      // 量的是排出来的宽比它自己要的宽少多少,0.01 只给浮点噪声。
      expect(labelShortfall(label)).toBeLessThanOrEqual(0.01);
    } finally {
      mounted.dispose();
      mounted.host.remove();
    }
  });

  it('breaks an unspaced command token once expanded', async () => {
    const item = executeItem(`printf ${'a'.repeat(180)}`);
    const mounted = await mountExecute(item, 280, true);

    try {
      const body = mounted.host.querySelector(`.${executeBody}`) as HTMLElement;
      const command = mounted.host.querySelector(`.${executeLine}`) as HTMLElement;

      // 软换行仍然是真的在做:180 个不带空格的字符必须折成多行,
      // 而不是横向溢出到读者看不见的地方。
      expect(command.offsetHeight).toBeGreaterThan(DEFAULT_THEME.fonts.code.lineHeight);
      expect(command.scrollHeight).toBe(command.offsetHeight);
      expect(command.scrollWidth).toBeLessThanOrEqual(command.clientWidth + 1);
      expect(body.offsetWidth - body.clientWidth).toBe(EXECUTE_SCROLLBAR_GUTTER_X);
    } finally {
      mounted.dispose();
      mounted.host.remove();
    }
  });

  it('reserves the measured gutter when expanded content needs a vertical scrollbar', async () => {
    const item = executeItem(`printf ${'a'.repeat(720)}`);
    const mounted = await mountExecute(item, 320, true);

    try {
      const body = mounted.host.querySelector(`.${executeBody}`) as HTMLElement;
      const command = mounted.host.querySelector(`.${executeLine}`) as HTMLElement;

      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      expect(body.offsetWidth - body.clientWidth).toBe(EXECUTE_SCROLLBAR_GUTTER_X);
      expect(command.scrollWidth).toBeLessThanOrEqual(command.clientWidth + 1);
    } finally {
      mounted.dispose();
      mounted.host.remove();
    }
  });

  it('preserves horizontal scrolling for column-oriented command output', async () => {
    const item = executeItem('printf output', 'column-a column-b column-c '.repeat(12));
    const mounted = await mountExecute(item, 320, true);

    try {
      const body = mounted.host.querySelector(`.${executeBody}`) as HTMLElement;
      expect(body.scrollWidth).toBeGreaterThan(body.clientWidth);
    } finally {
      mounted.dispose();
      mounted.host.remove();
    }
  });
});

// ── Exit status ───────────────────────────────────────────────────────────────
//
// Read in real Chromium layout, and read as *content*: what the row says and what
// colour it says it in. A correctly-sized empty box satisfies every border-box
// geometry assertion there is, so the height readings here are the noise floor
// every arm must hold — not the result. The result is that the number reaches the
// screen and that a failing command does not look like a successful one.

function execWithExit(
  exitStatus: ChatExecute['exitStatus'],
  status: ChatExecute['status'] = 'done'
): ChatExecute {
  return {
    kind: 'execute',
    id: 'execute-exit',
    command: 'pnpm build',
    status,
    startedAt: 0,
    ...(exitStatus === undefined ? {} : { exitStatus }),
  };
}

/**
 * What `fgError` actually resolves to in this host's cascade.
 *
 * Resolved by the same engine that painted the badge rather than hand-converted
 * from the token table, so the comparison stays true when the token's value
 * changes and stays honest across the two themes, whose error colours differ.
 */
function errorTokenColour(host: HTMLElement): string {
  const probe = document.createElement('span');
  probe.style.color = String(vars.fgError);
  host.appendChild(probe);
  const colour = getComputedStyle(probe).color;
  probe.remove();
  return colour;
}

describe('Execute exit status contract', () => {
  for (const theme of ['light', 'dark'] as const) {
    describe(theme, () => {
      async function readExitStatus(item: ChatExecute) {
        const mounted = await mountExecute(item, 320, false, theme);
        const badge = mounted.host.querySelector<HTMLElement>('[data-slot="execute-exit-status"]');
        // Address the header by its own identity, not by the toggle wiring: these
        // fixtures are short commands with no output, so they hide nothing and
        // correctly render no `data-collapse-id` (#3589). Reading the header
        // through that attribute made the locator vanish for exactly the rows
        // this contract is about.
        const header = mounted.host.querySelector<HTMLElement>('[data-slot="collapse-header"]')!;
        return {
          mounted,
          text: badge?.textContent ?? null,
          colour: badge ? getComputedStyle(badge).color : null,
          rowH: (mounted.host.firstElementChild as HTMLElement).offsetHeight,
          measured: executeUnitDef.measure(item, mounted.measureCtx, executeUnitDef.vars!),
          // Read from *inside* the header, because the root cannot report this.
          // `executeRoot` carries both the engine's height and `overflow: hidden`,
          // so a badge that grows the header is clipped and every root-level
          // height reading still agrees — the same blind spot tool-group's panel
          // has. Overflow inside the header is where a height change shows up.
          headerOverflowY: header.scrollHeight - header.clientHeight,
          badgeSpillY: badge
            ? badge.getBoundingClientRect().bottom - header.getBoundingClientRect().bottom
            : 0,
        };
      }

      it('puts a non-zero exit code on screen in the failure colour, changing no height', async () => {
        const running = await readExitStatus(execWithExit(undefined, 'running'));
        const ok = await readExitStatus(execWithExit({ exitCode: 0, signal: null }));
        const failed = await readExitStatus(execWithExit({ exitCode: 1, signal: null }));

        try {
          // Three states, three different statements — not one silence. The row is
          // readable collapsed: none of this is behind the chevron.
          expect(running.text).toBeNull();
          expect(ok.text).toBe('exit 0');
          expect(failed.text).toBe('exit 1');

          // Failure is a different colour from success, and it is the colour the
          // error mark already carries. Without this pair an implementation that
          // paints every exit code alike passes everything above while leaving a
          // failed command indistinguishable from a clean one — which is the
          // defect. Both directions can go red: paint zero red and the first
          // assertion fails, paint one grey and the second does.
          expect(failed.colour).not.toBe(ok.colour);
          expect(failed.colour).toBe(errorTokenColour(failed.mounted.host));
          expect(ok.colour).not.toBe(errorTokenColour(ok.mounted.host));

          // Noise floor: the reading rides in the header's existing line, so all
          // three states measure and render to one and the same height, and the
          // badge stays inside the header it joined rather than being clipped by
          // the root on its way out.
          expect(new Set([running.rowH, ok.rowH, failed.rowH]).size).toBe(1);
          expect(running.measured).toBe(failed.measured);
          expect(failed.rowH).toBe(failed.measured);
          expect(failed.headerOverflowY).toBe(0);
          expect(failed.badgeSpillY).toBeLessThanOrEqual(0);
        } finally {
          for (const state of [running, ok, failed]) {
            state.mounted.dispose();
            state.mounted.host.remove();
          }
        }
      });

      it('names the signal when a command was killed rather than inventing a code', async () => {
        const killed = await readExitStatus(execWithExit({ exitCode: null, signal: 'SIGTERM' }));
        try {
          expect(killed.text).toBe('signal SIGTERM');
          expect(killed.colour).toBe(errorTokenColour(killed.mounted.host));
        } finally {
          killed.mounted.dispose();
          killed.mounted.host.remove();
        }
      });

      // A signal can arrive alongside a zero code. Reading the code first prints
      // the word for success in the failure colour and never mentions the thing
      // that actually ended the process — two halves of one row contradicting
      // each other. `terminalExitSchema` allows the combination, so it needs a
      // criterion rather than an assumption about what hosts emit.
      it('reports the signal, not the code, when a killed process still carried one', async () => {
        const both = await readExitStatus(execWithExit({ exitCode: 0, signal: 'SIGKILL' }));
        try {
          expect(both.text).toBe('signal SIGKILL');
          expect(both.colour).toBe(errorTokenColour(both.mounted.host));
        } finally {
          both.mounted.dispose();
          both.mounted.host.remove();
        }
      });

      // A long label must not be able to carry the reading off the row with it.
      // Measured before this was a slot of its own: at 320px a header-filling
      // inputSummary wrapped the label and pushed the mark onto a second line
      // inside a 32px header, flush against `executeRoot`'s clip — one pixel from
      // vanishing, with the row height still reading a perfect 32. That is why
      // this asserts the badge's own rect against the header's rather than any
      // height: the height cannot see it.
      it('keeps the reading on the row when the label is long enough to wrap', async () => {
        const mounted = await mountExecute(
          {
            ...execWithExit({ exitCode: 1, signal: null }),
            inputSummary:
              "sed -n '/^## Repository Structure$/,/^## Build & Development Commands$/p' AGENTS.md",
          },
          320,
          false,
          theme
        );
        try {
          const header = mounted.host.querySelector<HTMLElement>('[data-slot="collapse-header"]')!;
          const badge = mounted.host.querySelector<HTMLElement>(
            '[data-slot="execute-exit-status"]'
          );
          expect(badge, 'the row stopped reporting the exit status entirely').not.toBeNull();
          const headerRect = header.getBoundingClientRect();
          const badgeRect = badge!.getBoundingClientRect();
          expect(badgeRect.height, 'the mark collapsed to nothing').toBeGreaterThan(0);
          // The discriminator is *where on the row* it sits, not whether it is
          // inside it. Displaced onto the label's second line the mark still
          // ends exactly at the clip edge — bottom-vs-bottom reads 0, which any
          // "is it contained" assertion accepts. Its centre is what moves: on
          // the row's own centreline when it is a sibling of the label, ~8px
          // below it when the label's wrapping is free to carry it down.
          const badgeCentre = badgeRect.top + badgeRect.height / 2;
          const headerCentre = headerRect.top + headerRect.height / 2;
          expect(
            Math.abs(badgeCentre - headerCentre),
            'the long label displaced the exit status off the row centreline'
          ).toBeLessThanOrEqual(1);
          expect(
            badgeRect.right - headerRect.right,
            'the exit status spilled past the right edge of the row'
          ).toBeLessThanOrEqual(0);
        } finally {
          mounted.dispose();
          mounted.host.remove();
        }
      });

      // Not knowing is its own state and must render as nothing. These two rows are
      // exactly the ones a "default to zero" implementation would silently mark
      // clean: a finished command whose terminal was never observed, and one that
      // ended carrying neither a code nor a signal.
      it('says nothing at all when the exit is not known, rather than implying success', async () => {
        const unobserved = await readExitStatus(execWithExit(undefined));
        const neither = await readExitStatus(execWithExit({ exitCode: null, signal: null }));
        try {
          expect(unobserved.text).toBeNull();
          expect(neither.text).toBeNull();
          expect(unobserved.rowH).toBe(unobserved.measured);
        } finally {
          for (const state of [unobserved, neither]) {
            state.mounted.dispose();
            state.mounted.host.remove();
          }
        }
      });
    });
  }
});
