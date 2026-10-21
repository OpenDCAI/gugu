/** @jsxImportSource solid-js */
/**
 * 附件卡片的三枚字形(#7193):文档、图片、网页。
 *
 * 字形取自 Solar(与产品其余地方同一套,`packages/session-ui/src/icon-bodies.ts` 的 `FileText` / `Globe`,
 * 原样抄过来;图片是 `Image`)。这个包不能引 `@gugu/session-ui`(那边依赖这边,引过去就成环),所以像这里其它字形一样留一份。
 * 改字形时两边一起改。
 */
const SIZE = { width: '18', height: '18', viewBox: '0 0 24 24', 'aria-hidden': true as const };

export function IconDocument() {
  return (
    <svg {...SIZE}>
      <g fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M3 10c0-3.771 0-5.657 1.172-6.828S7.229 2 11 2h2c3.771 0 5.657 0 6.828 1.172S21 6.229 21 10v4c0 3.771 0 5.657-1.172 6.828S16.771 22 13 22h-2c-3.771 0-5.657 0-6.828-1.172S3 17.771 3 14z" />
        <path stroke-linecap="round" d="M8 12h8M8 8h8m-8 8h5" />
      </g>
    </svg>
  );
}

export function IconGlobe() {
  return (
    <svg {...SIZE}>
      <g fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M22 12a10 10 0 1 1-20.001 0A10 10 0 0 1 22 12Z" />
        <path d="M16 12c0 1.313-.104 2.614-.305 3.827c-.2 1.213-.495 2.315-.867 3.244c-.371.929-.812 1.665-1.297 2.168c-.486.502-1.006.761-1.531.761s-1.045-.259-1.53-.761c-.486-.503-.927-1.24-1.298-2.168c-.372-.929-.667-2.03-.868-3.244A23.6 23.6 0 0 1 8 12c0-1.313.103-2.614.304-3.827s.496-2.315.868-3.244c.371-.929.812-1.665 1.297-2.168C10.955 2.26 11.475 2 12 2s1.045.259 1.53.761c.486.503.927 1.24 1.298 2.168c.372.929.667 2.03.867 3.244C15.897 9.386 16 10.687 16 12Z" />
        <path stroke-linecap="round" d="M2 12h20" />
      </g>
    </svg>
  );
}

export function IconImage() {
  return (
    <svg {...SIZE}>
      <g fill="none" stroke="currentColor" stroke-width="1.5">
        <path d="M2 12c0-4.714 0-7.071 1.464-8.536C4.93 2 7.286 2 12 2s7.071 0 8.535 1.464C22 4.93 22 7.286 22 12s0 7.071-1.465 8.535C19.072 22 16.714 22 12 22s-7.071 0-8.536-1.465C2 19.072 2 16.714 2 12Z" />
        <circle cx="16" cy="8" r="2" />
        <path stroke-linecap="round" d="m2 12.5l1.752-1.533a2.3 2.3 0 0 1 3.14.105l4.29 4.29a2 2 0 0 0 2.564.222l.299-.21a3 3 0 0 1 3.731.225L21 18.5" />
      </g>
    </svg>
  );
}

/** 行尾的「点进去」:`icon-bodies.ts` 的 `ChevronRight`。 */
export function IconChevronRight() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m9 5l6 7l-6 7" />
    </svg>
  );
}

/** 「打开方式 ▾」的下拉箭头:`icon-bodies.ts` 的 `ChevronDown`。 */
export function IconChevronDown() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="m19 9l-7 6l-7-6" />
    </svg>
  );
}
