// Curated five-colour palettes, shared by the live SVG and image-only projections. The first is the
// boringavatars.com palette and sets the bounds: no colour sits closer to the dark page (#121212) or to white
// than its darkest and lightest colour, so every circle edge reads at least as well as before on both themes.
// Beam pairs colours[i] (body) with colours[(i+3)%5] (background), so each such pair is kept visibly apart.
// Editing the list re-colours existing agents.
export const AGENT_AVATAR_PALETTES: string[][] = [
  ['#00686c', '#32c2b9', '#edecb3', '#fad928', '#ff9915'],
  ['#41626f', '#2a9d8f', '#e9c46a', '#f4a261', '#e76f51'],
  ['#a33462', '#b22832', '#fb8b24', '#e36414', '#2d6576'],
  ['#3d5e92', '#457b9d', '#a8dadc', '#e63946', '#f1c453'],
  ['#ff595e', '#ffca3a', '#8ac926', '#1982c4', '#6d4f96'],
  ['#2d6a4f', '#52b788', '#b7e4c7', '#d4a373', '#bc4749'],
  ['#5853ad', '#7678ed', '#f7b801', '#f18701', '#f35b04'],
  ['#06d6a0', '#118ab2', '#33618a', '#ffd166', '#ef476f'],
  ['#606c38', '#e9d8a6', '#dda15e', '#bc6c25', '#aa3233'],
  ['#ff7b54', '#ffb26b', '#ffd56f', '#939b62', '#41655c'],
  ['#872ace', '#5e60ce', '#4ea8de', '#56cfe1', '#80ffdb'],
  ['#a5374c', '#b22647', '#ff4d6d', '#ff8fa3', '#ffccd5'],
  ['#f3722c', '#f8961e', '#f9c74f', '#90be6d', '#43aa8b'],
  ['#10667a', '#0a9396', '#94d2bd', '#ee9b00', '#ca6702'],
  ['#773ebd', '#8134c6', '#c77dff', '#ffb703', '#fb8500'],
  ['#7f5539', '#ddb892', '#a5a58d', '#b08968', '#6b705c'],
  ['#ffbe0b', '#fb5607', '#ff006e', '#8338ec', '#3a86ff'],
  ['#456182', '#6d597a', '#b56576', '#e56b6f', '#eaac8b'],
  ['#2a6a40', '#007200', '#38b000', '#9ef01a', '#c7fa29'],
  ['#e07a5f', '#426086', '#81b29a', '#98c1d9', '#f2cc8f'],
]

// FNV-1a, deliberately not beam's own hash: the palette must not correlate with beam's body/background choice.
export function agentAvatarPalette(id: string): string[] {
  let hash = 0x811c9dc5
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 0x01000193)
  return AGENT_AVATAR_PALETTES[(hash >>> 0) % AGENT_AVATAR_PALETTES.length]
}

/** The circle mask is luminance: opaque white keeps the face, independent of theme. */
export const BORING_MASK_FILL = '#FFFFFF'

/** Eyes and mouth on the body colour: white once it reaches 3:1 (WCAG non-text contrast), else black. Beam's own YIQ test
 *  keeps black on mid-dark reds, oranges and browns, where the face reads as a hole. */
export function boringFaceFeatureColor(body: string): '#FFFFFF' | '#000000' {
  const channel = (i: number) => { const v = parseInt(body.slice(i, i + 2), 16) / 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
  const luminance = 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
  return 1.05 / (luminance + 0.05) >= 3 ? '#FFFFFF' : '#000000'
}
