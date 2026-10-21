/** @jsxImportSource solid-js */
import { CachesContext } from '@session-chat/components/contexts/CachesContext';
import { ThemeContext } from '@session-chat/components/contexts/ThemeContext';
import { executeLine, executeRoot } from '@session-chat/components/rows/tools/execute/execute.css';
import { executeUnitDef } from '@session-chat/components/rows/tools/execute/execute.def';
import {
  SUBAGENT_HEADER_GAP,
  SUBAGENT_INDICATOR_W,
} from '@session-chat/components/rows/tools/subagent/subagent.css';
import { createChatCaches } from '@session-chat/core/caches';
import type { MeasureCtx, RenderCtx } from '@session-chat/core/define';
import { DEFAULT_THEME } from '@session-chat/core/theme';
import type { ChatExecute, ChatSubagentToolCall } from '@session-chat/model';
import type { ItemNode } from '@session-chat/state/flatten';
import { render } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import { toolGroupRoot } from './tool-group.css';
import { toolGroupUnitDef } from './tool-group.def';

const nextPaint = (): Promise<void> =>
  new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

function subagent(id: string): ChatSubagentToolCall {
  return {
    kind: 'subagent',
    id,
    name: id,
    status: 'done',
    phase: 'completed',
  };
}

async function mountToolGroup(node: ItemNode, width: number) {
  const caches = createChatCaches();
  const isCollapsed = () => true;
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
  document.body.appendChild(host);

  const dispose = render(
    () => (
      <ThemeContext.Provider value={() => DEFAULT_THEME}>
        <CachesContext.Provider value={caches}>
          <toolGroupUnitDef.Render data={node} ctx={renderCtx} vars={toolGroupUnitDef.vars!} />
        </CachesContext.Provider>
      </ThemeContext.Provider>
    ),
    host,
  );

  await document.fonts.ready;
  await nextPaint();

  return { dispose, host, measureCtx };
}

describe('ToolGroup child width contract', () => {
  it('deducts every nested subagent offset from child measurement and rendering', async () => {
    const execute: ChatExecute = {
      kind: 'execute',
      id: 'nested-execute',
      command: `printf ${'a'.repeat(65)}`,
      status: 'done',
      startedAt: 0,
    };
    const node: ItemNode = {
      item: subagent('outer-subagent'),
      children: [
        {
          item: subagent('inner-subagent'),
          children: [{ item: execute, children: [] }],
        },
      ],
    };
    const width = 306;
    const mounted = await mountToolGroup(node, width);

    try {
      const root = mounted.host.querySelector(`.${toolGroupRoot}`) as HTMLElement;
      const card = mounted.host.querySelector(`.${executeRoot}`) as HTMLElement;
      const command = mounted.host.querySelector(`.${executeLine}`) as HTMLElement;
      const childWidth = width - 2 * (SUBAGENT_INDICATOR_W + SUBAGENT_HEADER_GAP);
      const childMeasureCtx = { ...mounted.measureCtx, width: childWidth };
      const expectedExecuteHeight = executeUnitDef.measure(
        execute,
        childMeasureCtx,
        executeUnitDef.vars!,
      );

      expect(card.offsetWidth).toBe(childWidth);
      expect(card.offsetHeight).toBe(expectedExecuteHeight);
      expect(expectedExecuteHeight).toBeGreaterThan(
        executeUnitDef.measure(execute, mounted.measureCtx, executeUnitDef.vars!),
      );
      expect(root.offsetHeight).toBe(
        toolGroupUnitDef.measure(node, mounted.measureCtx, toolGroupUnitDef.vars!),
      );
      expect(command.scrollWidth).toBeLessThanOrEqual(command.clientWidth + 1);

      const measuredCommandHeight = command.offsetHeight;
      command.style.height = 'auto';
      await nextPaint();
      expect(command.offsetHeight).toBe(measuredCommandHeight);
    } finally {
      mounted.dispose();
      mounted.host.remove();
    }
  });
});
