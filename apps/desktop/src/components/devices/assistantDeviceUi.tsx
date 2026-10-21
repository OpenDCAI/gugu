/** #7199 助理 App「能力 · 设备」两块共用的小件。 */

/** Solar「smartphone」linear(与设置左栏「这台手机」同一个字形;图标表里没有它)。 */
export function PhoneGlyph({ size = 18 }: { size?: number }) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <g fill="none" stroke="currentColor" strokeWidth="1.5">
        <path d="M4 10c0-3.771 0-5.657 1.172-6.828S8.229 2 12 2s5.657 0 6.828 1.172S20 6.229 20 10v4c0 3.771 0 5.657-1.172 6.828S15.771 22 12 22s-5.657 0-6.828-1.172S4 17.771 4 14z" />
        <path strokeLinecap="round" d="M15 19H9" />
      </g>
    </svg>
  )
}
