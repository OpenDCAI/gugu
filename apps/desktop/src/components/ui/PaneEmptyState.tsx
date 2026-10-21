// 面板空状态的统一形态：54×54 透明图标槽 + 说明文字（可选第二行引导）。
// 尺寸一律取 tokens 刻度：原先圆角 16px、字号裸写 13/11，都绕开了 --radius-*/--font-*，
// 而这组件是五处面板共用的，一处漂移就是全 app 漂移。
// 消息侧栏 / 聊天主面板 / 通讯录右栏共用——改样式只改这里。
// icon 可省(#6264 设置 → 设备):design.md 的 Reject 列表点名「icons dropped into tinted tiles」,
// 新调用点不带图标,只留说明文字;存量调用点照旧。
export function PaneEmptyState({ icon, caption, hint }: { icon?: React.ReactNode; caption: string; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
      {icon && (
        <div style={{ width: 54, height: 54, display: 'grid', placeItems: 'center' }}>
          {icon}
        </div>
      )}
      <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-secondary)', textAlign: 'center' }}>{caption}</div>
      {hint && <div style={{ fontSize: 'var(--font-caption)', color: 'var(--text-secondary)', textAlign: 'center' }}>{hint}</div>}
    </div>
  )
}
