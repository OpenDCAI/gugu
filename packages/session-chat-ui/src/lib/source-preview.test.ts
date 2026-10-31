// @vitest-environment jsdom
import { expect, it } from 'vitest';
import { sourcePreview } from './source-preview';

it('renders the bounded opening as Markdown, including table and code structure', () => {
  expect(sourcePreview('**Opening** with `code`').html).toContain('<strong>Opening</strong>');
  expect(sourcePreview('| Key | Value |\n| --- | --- |\n| A | B |').html).toContain('<table');
  expect(sourcePreview('```ts\nconst value = 1;\n```').html).toContain('<code');
});
it('bounds long structures before parsing and marks that the original continues', () => {
  for (const text of ['**Opening** '.repeat(100) + 'TAIL_MARKER', '```\n' + 'line\n'.repeat(100) + 'TAIL_MARKER']) {
    const preview = sourcePreview(text);
    expect(preview.truncated).toBe(true);
    expect(preview.html).not.toContain('TAIL_MARKER');
  }
});
it('preserves the indentation that makes the opening a Markdown code block', () => {
  expect(sourcePreview('\n    const value = 1;').html).toContain('<pre');
});
it('uses chat trust rather than executing source HTML', () => {
  const preview = sourcePreview('<script>alert(1)</script>');
  const root = document.createElement('div');
  root.innerHTML = preview.html;
  expect(root.querySelector('script')).toBeNull();
  expect(root.textContent).toBe('<script>alert(1)</script>');
});
