import { APP_RUNTIME_GLUE_MODULE } from '@shared/extensions/app-runtime-protocol';
import type { ExtensionTemplate } from '@shared/extensions/templates';
import type { ExtensionTabContribution } from '@shared/extensions/manifest';
import type { AppPlatform } from '@shared/extensions/app-platforms';

export { EXTENSION_TEMPLATES, type ExtensionTemplate } from '@shared/extensions/templates';

/**
 * Ready-made starts for `app_create { template }` (friction F11, 09-29): an agent building a chat App (a vote)
 * wrote the same page every time — open the file, watch it, show errors, offline and gone — and took minutes over it.
 * The template writes that part; the agent fills in render() and its handlers, a few dozen lines.
 *
 * `group-json`: one tab that the chat's `.<id>.json` files open in (opensFiles.chat), no capability — the host hands
 * the page its file, so nothing is asked at install. Its app.js keeps to what the guide (apps-files) teaches.
 *
 * A board or a form is group-json with another app.js, and one person's App with a save is a page of its own with
 * `readData` / `writeData` — the guide's examples, not templates of their own (R A/B 10-06: a solo template cost more
 * turns and approvals than writing the App from nothing).
 */
/** What of a template's files the agent writes: its code, and its own CSS. The rest (the page) is the template's. */
export const TEMPLATE_AUTHOR_FILES: readonly string[] = ['app.js', 'style.css'];

/** The data files a template's App opens: `.<id>.json`, which the id's own rules make a valid suffix. */
export function templateFileSuffix(id: string): string {
  return `.${id}.json`;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();
const htmlText = (text: string) => oneLine(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>__TITLE__</title>
<link rel="stylesheet" href="style.css" />
</head>
<body>
<div id="status" role="status"></div>
<main id="app" class="stack">
  <section id="shared"></section>
  <section id="controls"></section>
</main>
<script type="module" src="app.js"></script>
</body>
</html>
`;

// The look is the host's (/_gugu/<ver>/ui.css, put first in every App page): headings, text, buttons, fields, lists,
// tables and the classes .card .row .stack .list .muted .primary .danger are gugu's already. This file is the App's own
// CSS, and wins over the host's without !important; it starts with the one rule glue.js needs.
const STYLE = `/* The look is gugu's already (ui.css, put first in every App page): write semantic HTML — guide_read "apps-ui".
   Your own CSS goes here and wins over it. */

/* The file is gone (glue.js): what is shown is no longer it — dimmed, and not to be used, until it is back. */
body[data-file="gone"] > :not([role="status"], [role="alert"]) { opacity: .45; filter: grayscale(1); }
`;

/** What the page looks like, said in app_create's answer so the agent need not read style.css. */
export const TEMPLATE_LOOK =
  'gugu\'s look is already in the page: write semantic HTML (h2, p, button / button.primary, label > input, ul.list rows, ' +
  'table, details, progress) with .card .row .stack .muted, people as <gugu-avatar user="…">, icons as <gugu-icon name="…">; ' +
  'no fonts, sizes or colours of your own (guide apps-ui)';

// F55 (S1: the first request wrote ~4.4k tokens, app.js ~1k of it) The fixed part of the page is gugu's glue.js
// (glue-entry.ts), served by the host as gugu.js is: the agent writes only its own part, app.js.
const SCRIPT = `// __NAME__ — a chat App: the chat's __SUFFIX__ files open here, and everyone (people and agents) edits the same data
// live. gugu's glue.js opens the file and shows offline and errors; this file is yours. Guide: guide_read "apps-files".
import { f, me, myName, $, $$, html, render } from '${APP_RUNTIME_GLUE_MODULE}' // gugu is global, as window is: never imported

// f.data is the file's JSON, live: read and write it as any object, spread included (assigning merges key by key;
// others' additions stay); several changes at once in f.transact(() => { ... }). What many add to (votes, cards) is a
// map keyed by id — f.data.votes[me] = choice — sorted when shown; a drag drops by that id, never an index (F90).
// Text people type in together is created as gugu.text('') (an agent writes {"$text": ""}), and bound as below.

// Who is in the chat — people and agents, { id: 'user:<uuid>', name, kind: 'human' | 'agent' }. To pick someone
// (assign a card, choose an opponent), read it here; never copy it into the file. It follows the chat as it changes.
let members = (await gugu.getContext()).chat?.members ?? []
gugu.onContextChanged((context) => {
  members = context.chat?.members ?? members
  renderShared()
})
// An agent should act (a card assigned, a move made)? Wake the one it concerns, never every agent:
// gugu.send(card.owner, 'Card "…" is yours', { refs: [{ file: f.entry }] }) — needs manifest permissions chat:relay.

function setup() {
  // A box whose value is this person's — a draft not yet submitted, a gugu.bind.text box — goes into #controls ONCE:
  // render() keeps only the box someone is in, and puts its markup's value over every other one. For example:
  //   const note = document.createElement('input')
  //   const submit = Object.assign(document.createElement('button'), { className: 'primary', textContent: 'Submit' })
  //   submit.onclick = () => { f.data.answers[me] = note.value }
  //   $('#controls').append(note, submit)
  // A titled text box several people type in at once — the file holds { title: gugu.text(''), body: gugu.text('') }:
  //   const title = document.createElement('input'), body = document.createElement('textarea')
  //   gugu.bind.text(title, f.textAt(['title'])); gugu.bind.text(body, f.textAt(['body']))
  //   $('#controls').append(title, body)
}

function renderShared() {
  // What the file holds, into #shared, on every change: render() patches it — rows as data-key="…", boxes whose value
  // is the file's. Others' words go in through html\`…\` (every \${…} escaped). It looks like gugu (guide apps-ui). Replace:
  const here = members.map((m) => html\`<li data-key="\${m.id}"><gugu-avatar user="\${m.id}" name></gugu-avatar></li>\`)
  render($('#shared'), html\`<p class="muted">Me: \${myName}</p><h5>In this chat</h5><ul class="list">\${here}</ul>
    <pre>\${JSON.stringify(f.toJSON(), null, 2)}</pre>\`)
}

setup()
f.onChange(renderShared)
f.presence.onChange(renderShared) // who else has it open: f.presence.others ({ userId, name, color, state }); yours: f.presence.set(state)
renderShared()
`;

/** The manifest tabs and the files (its page among them) `template` writes, for `name` / `id`. */
export function extensionTemplate(
  template: ExtensionTemplate,
  { id, name }: { id: string; name: string }
): { platforms: AppPlatform[]; tabs: ExtensionTabContribution[]; files: Record<string, string> } {
  switch (template) {
    case 'group-json': {
      const suffix = templateFileSuffix(id);
      return {
        platforms: ['desktop', 'phone'],
        tabs: [{ name: 'main', title: name, entry: 'main.html', opensFiles: { chat: [suffix] } }],
        files: {
          'main.html': PAGE.replace('__TITLE__', htmlText(name)),
          'app.js': SCRIPT.replaceAll('__NAME__', oneLine(name)).replaceAll('__SUFFIX__', suffix),
          'style.css': STYLE,
        },
      };
    }
  }
}
