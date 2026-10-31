import { cloneElement, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ArrowBigUp, ChevronRight, ChevronRightIcon, GitBranch, SquarePen, SquarePenFilled } from './icons';

const svg = (element: Parameters<typeof renderToStaticMarkup>[0]) => renderToStaticMarkup(element);

describe('shared icon SVG contracts', () => {
  it('retains actual custom stroke widths, absolute widths and upstream classes', () => {
    const modifier = svg(createElement(ArrowBigUp, { size: 11, strokeWidth: 2.25, className: 'modifier' }));
    expect(modifier).toContain('stroke-width="2.25"');
    expect(modifier).toContain('class="lucide lucide-arrow-big-up modifier"');
    const branch = svg(createElement(GitBranch, { size: 12, strokeWidth: 2, absoluteStrokeWidth: true, color: 'red' }));
    expect(branch).toContain('stroke-width="4"');
    expect(branch).toContain('stroke="red"');
    expect(branch).toContain('fill="none"');
  });

  it('keeps icons leaf-shaped when a render protocol injects children', () => {
    const icon = cloneElement(createElement(GitBranch), {}, 'injected default icon');
    expect(() => svg(icon)).not.toThrow();
    expect(svg(icon)).not.toContain('injected default icon');
  });

  it('preserves the shared Solar arrow alias and both pen states', () => {
    expect(ChevronRightIcon).toBe(ChevronRight);
    expect(svg(createElement(SquarePenFilled))).not.toBe(svg(createElement(SquarePen)));
  });
});
