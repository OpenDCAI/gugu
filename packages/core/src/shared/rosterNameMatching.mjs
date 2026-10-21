const ASCII_WORD = /^[A-Za-z0-9_]$/
const WHITE_SPACE = /^\p{White_Space}$/u

function isAsciiOnly(value) {
  return Array.from(value).every((character) => character.codePointAt(0) <= 0x7f)
}

function codePointBefore(text, index) {
  if (index <= 0) return undefined
  const last = text.charCodeAt(index - 1)
  return last >= 0xdc00 && last <= 0xdfff && index >= 2 ? text.slice(index - 2, index) : text[index - 1]
}

function codePointAt(text, index) {
  if (index >= text.length) return undefined
  const first = text.charCodeAt(index)
  return first >= 0xd800 && first <= 0xdbff && index + 1 < text.length ? text.slice(index, index + 2) : text[index]
}

function hasAsciiWordBoundary(text, start, end) {
  const before = codePointBefore(text, start)
  const after = codePointAt(text, end)
  return (before === undefined || !ASCII_WORD.test(before)) && (after === undefined || !ASCII_WORD.test(after))
}

// Shared with the #2773 agent outbox guard. Keep its proven NFC/longest-name/ASCII-boundary/CJK-adjacency
// behavior intact; the human composer adds only the opening-slot and fuzzy-normalization policy below.
export function findRosterNameHits(users, content) {
  const text = String(content ?? '').normalize('NFC')
  const byName = new Map()
  for (const user of users) {
    if (!user.display_name) continue
    const name = String(user.display_name).normalize('NFC')
    if (Array.from(name).length < 2) continue
    const entry = byName.get(name) ?? { memberIds: new Set(), agentIds: new Set() }
    entry.memberIds.add(String(user.id))
    if (user.type === 'agent') entry.agentIds.add(String(user.id))
    byName.set(name, entry)
  }
  const candidates = [...byName.entries()]
    .map(([name, entry]) => ({
      name,
      memberIds: [...entry.memberIds].sort(),
      agentIds: [...entry.agentIds].sort(),
    }))
    .sort((left, right) => (
      Array.from(right.name).length - Array.from(left.name).length ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
      (left.memberIds[0] < right.memberIds[0] ? -1 : left.memberIds[0] > right.memberIds[0] ? 1 : 0)
    ))
  const claimed = []
  const hits = []
  for (const candidate of candidates) {
    let from = 0
    let matched = false
    for (;;) {
      const start = text.indexOf(candidate.name, from)
      if (start < 0) break
      const end = start + candidate.name.length
      from = start + 1
      if (claimed.some(([claimedStart, claimedEnd]) => start < claimedEnd && end > claimedStart)) continue
      if (isAsciiOnly(candidate.name) && !hasAsciiWordBoundary(text, start, end)) continue
      claimed.push([start, end])
      matched = true
    }
    if (matched && candidate.agentIds.length) hits.push({ name: candidate.name, ids: candidate.agentIds })
  }
  return hits
}

function normalizedName(value) {
  return Array.from(String(value ?? '').normalize('NFKC').toLowerCase())
    .filter((character) => !WHITE_SPACE.test(character))
    .join('')
}

function allowedEditDistance(length) {
  if (length < 4) return 0
  return length < 8 ? 1 : 2
}

function boundedDamerauLevenshtein(left, right, limit) {
  if (Math.abs(left.length - right.length) > limit) return limit + 1
  let previousPrevious = null
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i]
    let rowMinimum = current[0]
    for (let j = 1; j <= right.length; j += 1) {
      const substitution = previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      let value = Math.min(current[j - 1] + 1, previous[j] + 1, substitution)
      if (
        previousPrevious && i > 1 && j > 1 &&
        left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]
      ) {
        value = Math.min(value, previousPrevious[j - 2] + 1)
      }
      current[j] = value
      rowMinimum = Math.min(rowMinimum, value)
    }
    if (rowMinimum > limit) return limit + 1
    previousPrevious = previous
    previous = current
  }
  return previous[right.length]
}

function compactOpening(value) {
  const characters = []
  const separatorBefore = []
  let separated = false
  for (const character of Array.from(String(value ?? '').normalize('NFKC').toLowerCase())) {
    if (WHITE_SPACE.test(character)) {
      separated = true
      continue
    }
    separatorBefore.push(separated)
    characters.push(character)
    separated = false
  }
  return { characters, separatorBefore }
}

export function buildRosterNameIndex(members) {
  const byName = new Map()
  for (const member of members) {
    const name = normalizedName(member.name)
    if (Array.from(name).length < 2) continue
    const entry = byName.get(name) ?? { name, memberIds: new Set(), agentIds: new Set() }
    entry.memberIds.add(String(member.id))
    if (member.type === 'agent') entry.agentIds.add(String(member.id))
    byName.set(name, entry)
  }
  return [...byName.values()]
    .map((entry) => ({
      name: entry.name,
      characters: Array.from(entry.name),
      memberIds: [...entry.memberIds].sort(),
      agentIds: [...entry.agentIds].sort(),
      ascii: isAsciiOnly(entry.name),
    }))
    .sort((left, right) => (
      right.characters.length - left.characters.length ||
      (left.name < right.name ? -1 : left.name > right.name ? 1 : 0) ||
      (left.memberIds[0] < right.memberIds[0] ? -1 : left.memberIds[0] > right.memberIds[0] ? 1 : 0)
    ))
}

export function resolveOpeningAgentCall(index, content) {
  const opening = compactOpening(content)
  if (!opening.characters.length) return []
  const matches = []
  for (const candidate of index) {
    const limit = allowedEditDistance(candidate.characters.length)
    const minimumLength = Math.max(1, candidate.characters.length - limit)
    const maximumLength = Math.min(opening.characters.length, candidate.characters.length + limit)
    let bestDistance = limit + 1
    for (let length = minimumLength; length <= maximumLength; length += 1) {
      const next = opening.characters[length]
      if (candidate.ascii && next !== undefined && !opening.separatorBefore[length] && ASCII_WORD.test(next)) continue
      const distance = boundedDamerauLevenshtein(
        candidate.characters,
        opening.characters.slice(0, length),
        limit,
      )
      bestDistance = Math.min(bestDistance, distance)
    }
    if (bestDistance <= limit) matches.push({ candidate, distance: bestDistance })
  }
  matches.sort((left, right) => (
    left.distance - right.distance ||
    right.candidate.characters.length - left.candidate.characters.length ||
    (left.candidate.name < right.candidate.name ? -1 : left.candidate.name > right.candidate.name ? 1 : 0)
  ))
  const best = matches[0]
  if (!best) return []
  const ambiguous = matches.some((match) => (
    match.candidate.name !== best.candidate.name &&
    match.distance === best.distance &&
    match.candidate.characters.length === best.candidate.characters.length
  ))
  return ambiguous ? [] : best.candidate.agentIds
}
