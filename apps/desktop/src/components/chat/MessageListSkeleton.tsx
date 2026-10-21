const SKELETON_ROWS = [
  { side: 'other', width: '60%' },
  { side: 'me', width: '45%' },
  { side: 'other', width: '75%' },
  { side: 'me', width: '30%' },
  { side: 'other', width: '55%' },
  { side: 'me', width: '50%' },
] as const

/** 会话在加载、手上又一行可画的都没有时的占位(从 ChatAreaPanel 抽出,样式未变)。 */
export function MessageListSkeleton() {
  return (
    <div style={{ flex: 1, padding: '8px 16px', display: 'flex', flexDirection: 'column', gap: '12px', overflow: 'hidden' }}>
      {SKELETON_ROWS.map((row, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: row.side === 'me' ? 'flex-end' : 'flex-start' }}>
          <div
            data-skeleton-bubble
            style={{
              width: row.width,
              height: 28 + (i % 3) * 4,
              borderRadius: 'var(--radius-surface)',
              background: 'linear-gradient(90deg, var(--bg-elevated) 0%, var(--bg-secondary) 50%, var(--bg-elevated) 100%)',
              backgroundSize: '200% 100%',
              animation: 'skeleton-shimmer 1.4s ease-in-out infinite',
            }}
          />
        </div>
      ))}
    </div>
  )
}
