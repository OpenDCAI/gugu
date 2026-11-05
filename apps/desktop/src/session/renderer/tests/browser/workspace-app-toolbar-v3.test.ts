import { afterEach, expect, it } from 'vitest';
import { page } from 'vitest/browser';
import html from '../../../../../preinstalled-apps/workspace/index.html?raw';
import css from '../../../../../preinstalled-apps/workspace/style.css?raw';
import ui from '../../../app-runtime/ui/ui.css?raw';
import { until } from '../../../../../../../tests/support/awaitCondition';

let frame: HTMLIFrameElement;
afterEach(() => frame?.remove());

it.each([483, 320])('the actual Workspace document toolbar retains More inside a %spx guest', async (width) => {
  await page.viewport(1100, 800);
  frame = document.createElement('iframe');
  frame.style.cssText = `width:${width}px;height:620px;border:0`;
  document.body.append(frame);
  const doc = frame.contentDocument!;
  // This is the shipped App DOM and both shipped stylesheets. Data is the real agent-file shape:
  // file name, read/edit controls, author metadata, presence and the saved revision.
  doc.open(); doc.write(html.replace(/<link[^>]*>|<script[^>]*>[\s\S]*?<\/script>/g, '')); doc.close();
  const style = doc.createElement('style');
  style.textContent = `:root { --em-font-body:13px; --em-lh-body:20px; --em-font-caption:12px; --em-lh-caption:16px; --em-spacing-xs:4px; --em-spacing-sm:8px; --em-spacing-md:12px; --em-control-h-md:32px; --em-font-title:14px; --em-lh-title:20px; }\n${ui}\n${css}`;
  doc.head.append(style);
  doc.body.className = 'show-doc host-opened'; doc.body.dataset.state = 'doc'; doc.body.dataset.mode = 'preview';
  const get = (id: string) => doc.getElementById(id)!;
  get('page-back-label').textContent = 'Back to conversation';
  get('doc-title').textContent = 'report-e2e.md';
  get('mode-preview').textContent = 'Read'; get('mode-edit').textContent = 'Edit';
  get('doc-info').hidden = false; get('doc-info').textContent = 'Created by the agent · 1 minute ago';
  get('doc-status').textContent = '#1'; get('peers').textContent = 'AA BB';
  get('more').hidden = false; get('more').textContent = '⋯';
  get('preview').textContent = 'The actual file body';
  await until('the guest has its real width', () => doc.documentElement.clientWidth === width);
  const more = get('more').getBoundingClientRect();
  expect(more.width).toBeGreaterThan(0);
  expect(more.right).toBeLessThanOrEqual(width);
  expect(doc.documentElement.scrollWidth).toBeLessThanOrEqual(width);
  expect(get('preview').getBoundingClientRect().top).toBeLessThanOrEqual(48);
});
