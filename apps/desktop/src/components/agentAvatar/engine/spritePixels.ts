/** Fade only the body-facing strip; preserve the fabric colour and the outside silhouette. */
export function featherWingRoot(data: Uint8ClampedArray, w: number, h: number, side: -1 | 1, width: number) {
  for (let y = 0; y < h; y++) {
    let edge = side < 0 ? w - 1 : 0
    while (edge >= 0 && edge < w && data[(y * w + edge) * 4 + 3] < 16) edge += side
    for (let x = 0; x < w; x++) {
      const distance = side < 0 ? edge - x : x - edge
      const t = Math.max(0, Math.min(1, distance / width))
      const i = (y * w + x) * 4 + 3
      data[i] = Math.round(data[i] * t * t * (3 - 2 * t))
    }
  }
}
