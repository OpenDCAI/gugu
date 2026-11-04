import { afterEach, expect, it } from 'vitest';
import { userEvent } from 'vitest/browser';
import hostCss from '@/styles/tokens.css?inline';
import sessionCss from '@renderer/index.css?inline';

const owned: HTMLElement[] = [];
afterEach(() => {
  owned.splice(0).forEach(node => node.remove());
  delete document.documentElement.dataset.theme;
  document.documentElement.className = '';
});
function probe(parent: HTMLElement, classes = '', tag = 'div') {
  const node = document.createElement(tag);
  node.className = classes;
  node.textContent = 'Border probe';
  parent.appendChild(node);
  return node;
}
function resolved(node: HTMLElement, variable: string) {
  const reference = document.createElement('i');
  reference.style.borderTopColor = `var(${variable})`;
  node.parentElement!.appendChild(reference);
  const color = getComputedStyle(reference).borderTopColor;
  reference.remove();
  return color;
}

for (const theme of ['light', 'dark']) {
  for (const reverse of [false, true]) {
    it(`keeps semantic borders and explicit states in ${theme}, reverse CSS order ${reverse}`, async () => {
      document.documentElement.dataset.theme = theme;
      document.documentElement.className = theme === 'light' ? 'emlight' : 'emdark';
      for (const css of reverse ? [sessionCss, hostCss] : [hostCss, sessionCss]) {
        const sheet = document.createElement('style');
        sheet.textContent = css;
        document.head.appendChild(sheet);
        owned.push(sheet);
      }
      const host = document.createElement('section');
      document.body.appendChild(host);
      owned.push(host);
      const plain = probe(host, 'border-t');
      expect(getComputedStyle(plain).borderTopWidth).toBe('1px');
      expect(getComputedStyle(plain).borderTopColor).toBe(resolved(plain, '--border-color'));
      expect(getComputedStyle(plain).borderTopColor).not.toBe(getComputedStyle(plain).color);
      const skin = probe(host, `gugu-skin ${theme === 'light' ? 'emlight' : 'emdark'}`);
      const scoped = probe(skin, 'border-t');
      expect(getComputedStyle(scoped).borderTopColor).toBe(resolved(scoped, '--border'));
      const current = probe(host, 'border border-current');
      expect(getComputedStyle(current).borderTopColor).toBe(getComputedStyle(current).color);
      const transparent = probe(host, 'border border-transparent');
      expect(getComputedStyle(transparent).borderTopColor).toBe('rgba(0, 0, 0, 0)');
      const semantic = probe(host, 'border border-[var(--border-strong)]');
      expect(getComputedStyle(semantic).borderTopColor).toBe(resolved(semantic, '--border-strong'));
      const hover = probe(host, 'border hover:border-[var(--border-strong)]');
      await userEvent.hover(hover);
      expect(getComputedStyle(hover).borderTopColor).toBe(resolved(hover, '--border-strong'));
      const focus = probe(host, 'border focus:border-[var(--border-strong)]', 'input');
      await userEvent.click(focus);
      expect(focus).toBe(document.activeElement);
      expect(getComputedStyle(focus).borderTopColor).toBe(resolved(focus, '--border-strong'));
      const error = probe(host, 'border aria-invalid:border-[var(--danger)]');
      error.setAttribute('aria-invalid', 'true');
      expect(getComputedStyle(error).borderTopColor).toBe(resolved(error, '--danger'));
      const explicit = probe(host);
      explicit.style.border = '7px solid currentColor';
      expect(getComputedStyle(explicit).borderTopColor).toBe(getComputedStyle(explicit).color);
      expect(getComputedStyle(explicit).borderTopWidth).toBe('7px');
      const noBorder = probe(host);
      expect(getComputedStyle(noBorder).borderTopWidth).toBe('0px');
    });
  }
}
