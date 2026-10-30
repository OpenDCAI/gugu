import { documentToHtml } from '../core/markdown/to-html';

/** Bound parsing work as well as the three painted lines; the original stays behind the source link. */
export function sourcePreview(text: string): { html: string; truncated: boolean } {
  const source = text.replace(/\r\n?/g, '\n').replace(/^(?:[ \t]*\n)+/, '').trimEnd();
  const excerpt = Array.from(source.split('\n').slice(0, 8).join('\n')).slice(0, 360).join('');
  return { html: documentToHtml(excerpt, { trust: 'chat', hardBreaks: true }), truncated: excerpt !== source };
}

/** Tables and fenced code do not get native line-clamp ellipses; mark their clipped preview too. */
export function mountSourcePreview(root: HTMLElement, truncated: boolean): () => void {
  root.querySelectorAll<HTMLElement>('a, button, input, [tabindex]').forEach(element => element.setAttribute('tabindex', '-1'));
  const update = () => root.toggleAttribute('data-source-truncated', truncated || root.scrollHeight > root.clientHeight + 1);
  const observer = new ResizeObserver(update);
  observer.observe(root);
  const frame = requestAnimationFrame(update);
  update();
  return () => { cancelAnimationFrame(frame); observer.disconnect(); };
}
