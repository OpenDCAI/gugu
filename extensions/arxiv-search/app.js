// arXiv Search — the reference gugu tab extension.
//
// Everything an extension needs is here: a manifest declaring what it renders
// and which host it may reach, a page, and this script. No build step, no
// bundler, no framework. It runs in its own sandboxed surface, and the only
// host it can talk to is the one its manifest declares — try changing the URL
// below to another domain and watch the request fail.

const ARXIV_API = 'https://export.arxiv.org/api/query';
const ATOM = 'http://www.w3.org/2005/Atom';

const form = document.querySelector('#search-form');
const queryInput = document.querySelector('#query');
const button = document.querySelector('#search-button');
const status = document.querySelector('#status');
const results = document.querySelector('#results');

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const query = queryInput.value.trim();
  if (query) void search(query);
});

async function search(query) {
  setBusy(true);
  status.textContent = `Searching arXiv for “${query}”…`;
  results.replaceChildren();

  try {
    const url = new URL(ARXIV_API);
    url.searchParams.set('search_query', `all:${query}`);
    url.searchParams.set('start', '0');
    url.searchParams.set('max_results', '20');
    url.searchParams.set('sortBy', 'relevance');

    const response = await fetch(url);
    if (!response.ok) throw new Error(`arXiv replied ${response.status}`);

    const papers = parseAtomFeed(await response.text());
    if (papers.length === 0) {
      status.textContent = `No papers matched “${query}”.`;
      return;
    }
    status.textContent = `${papers.length} paper${papers.length === 1 ? '' : 's'} for “${query}”.`;
    results.replaceChildren(...papers.map(renderPaper));
  } catch (error) {
    status.textContent = `Search failed: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  button.disabled = busy;
  queryInput.disabled = busy;
}

function parseAtomFeed(xml) {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('arXiv returned a malformed feed');

  return [...doc.getElementsByTagNameNS(ATOM, 'entry')].map((entry) => ({
    title: collapseWhitespace(textOf(entry, 'title')),
    summary: collapseWhitespace(textOf(entry, 'summary')),
    published: textOf(entry, 'published').slice(0, 10),
    authors: [...entry.getElementsByTagNameNS(ATOM, 'author')].map((author) =>
      collapseWhitespace(textOf(author, 'name'))
    ),
    id: textOf(entry, 'id'),
  }));
}

function textOf(element, tagName) {
  return element.getElementsByTagNameNS(ATOM, tagName)[0]?.textContent ?? '';
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function renderPaper(paper) {
  const item = document.createElement('li');
  item.className = 'paper';

  const title = document.createElement('h2');
  title.className = 'paper-title';
  title.textContent = paper.title;

  const meta = document.createElement('p');
  meta.className = 'paper-meta';
  const authors = paper.authors.slice(0, 4).join(', ');
  const more = paper.authors.length > 4 ? ` +${paper.authors.length - 4}` : '';
  meta.textContent = [authors + more, paper.published].filter(Boolean).join(' · ');

  const summary = document.createElement('p');
  summary.className = 'paper-summary';
  summary.textContent = paper.summary;

  // Text nodes throughout — never innerHTML. The feed is somebody else's data,
  // and an extension that pastes it into the DOM as markup is writing the hole
  // the sandbox exists to contain.
  item.append(title, meta, summary);
  return item;
}
