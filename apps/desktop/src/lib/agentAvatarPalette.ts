// Curated five-colour palettes, shared by the live SVG and image-only projections. Every colour stays
// mid-light so the circle reads on light and dark surfaces; beam pairs colours[i] (body) with
// colours[(i+3)%5] (background), so each such pair is kept visibly apart. Editing the list re-colours existing agents.
export const AGENT_AVATAR_PALETTES: string[][] = [
  ['#00686c', '#32c2b9', '#edecb3', '#fad928', '#ff9915'],
  ['#264653', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
  ['#9b2c5b', '#9a031e', '#fb8b24', '#e36414', '#0f4c5c'],
  ['#2b4c7e', '#457b9d', '#a8dadc', '#e63946', '#f1c453'],
  ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6a4c93'],
  ['#2d6a4f', '#52b788', '#b7e4c7', '#d4a373', '#bc4749'],
  ['#3d348b', '#7678ed', '#f7b801', '#f18701', '#f35b04'],
  ['#06d6a0', '#118ab2', '#26547c', '#ffd166', '#ef476f'],
  ['#606c38', '#bc6c25', '#dda15e', '#e9d8a6', '#9b2226'],
  ['#ff7b54', '#ffb26b', '#ffd56f', '#939b62', '#3e6259'],
  ['#7400b8', '#5e60ce', '#4ea8de', '#56cfe1', '#80ffdb'],
  ['#800f2f', '#a4133c', '#ff4d6d', '#ff8fa3', '#ffccd5'],
  ['#f3722c', '#f8961e', '#f9c74f', '#90be6d', '#43aa8b'],
  ['#005f73', '#0a9396', '#94d2bd', '#ee9b00', '#ca6702'],
  ['#5a189a', '#7b2cbf', '#c77dff', '#ffb703', '#fb8500'],
  ['#7f5539', '#ddb892', '#a5a58d', '#b08968', '#6b705c'],
  ['#ffbe0b', '#fb5607', '#ff006e', '#8338ec', '#3a86ff'],
  ['#355070', '#6d597a', '#b56576', '#e56b6f', '#eaac8b'],
  ['#004b23', '#007200', '#38b000', '#9ef01a', '#ccff33'],
  ['#e07a5f', '#3d5a80', '#81b29a', '#98c1d9', '#f2cc8f'],
]

// FNV-1a, deliberately not beam's own hash: the palette must not correlate with beam's body/background choice.
export function agentAvatarPalette(id: string): string[] {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193)
  return AGENT_AVATAR_PALETTES[(hash >>> 0) % AGENT_AVATAR_PALETTES.length]
}
