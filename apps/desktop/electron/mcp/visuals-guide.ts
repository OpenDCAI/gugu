/**
 * guide `visuals`: how an agent draws a figure that renders in a chat message or a task reply (desktop and phone). The
 * platform prompt names the two forms in one line and points here; the rules are read only by a session about to draw.
 * The SVG rules match what the renderer enforces (session-chat-ui `svgFigure`: viewBox, theme tokens, 64 KB, no script).
 */
export const VISUALS_GUIDE = {
  topic: 'visuals',
  about: 'Draw a figure in a reply: when, mermaid or svg, and the rules each renders by.',
  text: `# Figures in a reply

A fenced block renders as a figure in chat messages and task replies, on desktop and phone.

## When
Draw only when a picture shows what prose can't: structure, flow, data shape, space. One form per idea; never the same
content twice. The explanation goes in your message around the figure, not inside it.

## Which
- \`\`\`mermaid — the layout is done for you. Flowcharts with branches, sequences between parties, state machines,
  database schemas (erDiagram), timelines (gantt), class diagrams. Anything past ~5 nodes or with many labelled edges.
- \`\`\`svg — drawn by hand: how a mechanism works, a comparison, an annotated layout, a small sketch (≤6 boxes), a
  simple chart. Choose it when the picture is a metaphor or a shape, not a graph of boxes.

## SVG rules
- Root: \`<svg viewBox="0 0 680 H" xmlns="http://www.w3.org/2000/svg">\`. One unit is one pixel; 680 fills the column
  and a phone scales it down. H = bottom of the lowest element + 20. A root without a viewBox is shown as code.
- Colours only through tokens, never hex (a hex colour vanishes in the other theme):
  \`var(--fg)\` text, \`var(--muted)\` secondary text, \`var(--border)\` lines, \`var(--surface)\` box fill,
  \`var(--accent)\` the one emphasis, \`var(--success)\` / \`var(--warning)\` / \`var(--error)\` status,
  \`var(--c1)\` … \`var(--c6)\` series, used in that order. No background rectangle.
- Static and self-contained: no \`<script>\`, event handlers, \`<foreignObject>\`, external \`href\` or images, animation.
  Over 64 KB is shown as code.
- Text: font-size 14 for labels, 12 for notes. A box is at least (characters × 8, or × 15 for CJK) + 24 wide; text never
  crosses a box edge. Keep 20px clear of every edge of the viewBox; no negative coordinates.
- Arrows: one \`<marker>\` in \`<defs>\`. A line never passes through a box it does not connect — route around it with
  an L-shaped \`<path>\`. Labels sit beside a line, not on it.
- At most 4 boxes in a row at full width, 20px apart. At most 2 colour series; when colour carries meaning, add a
  one-line legend.

## Mermaid rules
- First line is the type: \`flowchart TD\` (or LR), \`sequenceDiagram\`, \`stateDiagram-v2\`, \`erDiagram\`, \`gantt\`,
  \`classDiagram\`.
- Node ids in ASCII; labels in quotes when they hold punctuation or CJK: \`A["用户登录"] --> B{"已注册?"}\`.
- It renders in strict mode: no \`click\`, callbacks or HTML labels. Do not set colours or a theme; the app themes it.
- Keep a diagram under ~30 nodes; split a bigger one into an overview and details, with a sentence between.

## Example (svg)
\`\`\`svg
<svg viewBox="0 0 680 140" xmlns="http://www.w3.org/2000/svg">
  <defs><marker id="a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto">
    <path d="M0 0L10 5L0 10z" fill="var(--muted)"/></marker></defs>
  <rect x="40" y="40" width="160" height="60" rx="8" fill="var(--surface)" stroke="var(--border)"/>
  <text x="120" y="75" text-anchor="middle" font-size="14" fill="var(--fg)">Client</text>
  <line x1="200" y1="70" x2="280" y2="70" stroke="var(--muted)" marker-end="url(#a)"/>
  <rect x="280" y="40" width="160" height="60" rx="8" fill="var(--surface)" stroke="var(--accent)"/>
  <text x="360" y="75" text-anchor="middle" font-size="14" fill="var(--fg)">Server</text>
</svg>
\`\`\`
`,
} as const;
