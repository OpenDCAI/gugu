/**
 * How a search query matches a text — one rule for every search an agent or a person makes: catalog_list's tools,
 * app_search's Apps, and the Apps page's search box (owner 10-19 「要认真做了」, ❌ a second copy anywhere).
 *
 * The query is split into words (letters and digits); a word found whole in the text scores 1. Chinese is written without
 * spaces, so 「一起玩海龟汤」 is one word and is never in a text whole (10-19: catalog_list found 0 rows for it). A Chinese
 * word not found whole scores its longest piece of two or more characters that is in the text, over its length: below the
 * 1 of a whole word, so 「海龟汤」 (3/6) still comes before a row that shares only 「一起」 (2/6). Other words match whole or
 * not at all.
 */
const HAN = /\p{Script=Han}/u

export function queryWords(query: string | undefined): string[] {
  return (query ?? '').toLocaleLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}

function wordScore(word: string, haystack: string): number {
  if (haystack.includes(word)) return 1
  if (!HAN.test(word)) return 0
  const chars = [...word]
  for (let length = chars.length - 1; length >= 2; length -= 1) {
    for (let start = 0; start + length <= chars.length; start += 1) {
      if (haystack.includes(chars.slice(start, start + length).join(''))) return length / chars.length
    }
  }
  return 0
}

/** The query's score against a text: 0 = no match. A query with no words scores 0 too; callers decide what an empty query means. */
export function queryScore(query: string | undefined, text: string): number {
  const haystack = text.toLocaleLowerCase()
  return queryWords(query).reduce((sum, word) => sum + wordScore(word, haystack), 0)
}

/**
 * The rows of the best score only (#7335): "send a file" does not bring the whole catalog for its "a"; a whole name still
 * finds that one row. No words = every row; nothing matched = none.
 */
export function bestKeywordMatches<Row>(entries: ReadonlyArray<{ row: Row; text: string }>, query: string | undefined): Row[] {
  if (queryWords(query).length === 0) return entries.map((entry) => entry.row)
  const scored = entries.map((entry) => ({ row: entry.row, hits: queryScore(query, entry.text) }))
  const best = Math.max(0, ...scored.map((entry) => entry.hits))
  return best === 0 ? [] : scored.filter((entry) => entry.hits === best).map((entry) => entry.row)
}
