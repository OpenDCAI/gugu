import React from 'react'
import { publicAssetPath } from '@gugu/core/shared/ui/publicAssets'
import { i18n } from '../i18n/runtime'

// @@@packaged-file-assets - Packaged Electron loads dist/index.html via file://, so public assets must not start at filesystem root.
const APP_LOGO_URL = publicAssetPath('/assets/app/gugu-icon-512.png')

interface AppErrorBoundaryState {
  error: Error | null
}

interface AppErrorBoundaryCopy {
  brandName: string
  title: string
  description: string
  reload: string
  diagnostics: string
}

// 词表拿不到时的最后一层文案。只在「i18n 本身坏了 + 树已经崩了」同时成立时出现 —— 那一刻没有任何
// 更好的来源,英文硬编码好过空白屏(#5610 §2.5)。
const LAST_RESORT_COPY: AppErrorBoundaryCopy = {
  brandName: 'Gugu',
  title: 'Something went wrong',
  description: 'The app hit an error and stopped rendering this screen. Reload to recover. Restart the app if the problem continues.',
  reload: 'Reload',
  diagnostics: 'Developer diagnostics (error stack, development builds only)',
}

// 文案在**出错那一刻**才取、且不经 hook:这个边界是整棵树的根,它之上没有别的边界。从前外壳是个用
// useTranslation 的函数组件 —— 正常渲染每一帧都跑那个 hook,i18n 初始化顺序一变(runtime.ts 的副作用
// 装默认实例),外壳自己抛、上面无人接 → 才是真白屏(#5610 §2.5)。现在正常路径不碰 i18n。
function boundaryCopy(): AppErrorBoundaryCopy {
  try {
    const t = (key: string) => i18n.t(key, { ns: 'main' })
    return {
      brandName: t('brand.name'),
      title: t('errorBoundary.title'),
      description: t('errorBoundary.description'),
      reload: t('errorBoundary.reload'),
      diagnostics: t('errorBoundary.diagnostics'),
    }
  } catch {
    return LAST_RESORT_COPY
  }
}

export class AppErrorBoundary extends React.Component<React.PropsWithChildren, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): AppErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    // @@@2116 - detailed diagnostics (stack + component stack) go to the log only; the
    // user-facing fallback stays a plain-language message with a recovery action.
    console.error('[app] render failed', error, info)
  }

  private handleReload = (): void => {
    window.location.reload()
  }

  render() {
    if (!this.state.error) return this.props.children
    const copy = boundaryCopy()
    // @@@no-prod-stack (#3) - the raw error.stack is a dev aid that can carry UUID-shaped prop
    // values and local source URLs; gate it behind DEV so production users never see it. Even in
    // DEV it is collapsed disclosure, never the primary UI (#2116).
    const isDev = import.meta.env.DEV
    return (
      <div
        style={{
          minHeight: '100vh',
          padding: 32,
          boxSizing: 'border-box',
          background: 'var(--bg-primary)',
          color: 'var(--text-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: 'var(--font-family-system)',
        }}
      >
        {/* @@@2116 - the fallback replaces the whole chrome including the frameless title bar;
            keep a drag strip so the window can still be moved while broken. */}
        <div
          style={
            {
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              height: 40,
              zIndex: 0,
              WebkitAppRegion: 'drag',
            } as React.CSSProperties
          }
        />
        <div
          style={{
            position: 'relative',
            zIndex: 1,
            width: 'min(720px, 100%)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-xl)',
            background: 'var(--bg-elevated)',
            padding: 24,
            boxShadow: 'var(--shadow-popover)',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
            {/* 装饰图：紧邻文本已给出品牌名，alt 留空避免读屏重复 */}
            <img
              src={APP_LOGO_URL}
              alt=""
              draggable={false}
              style={{ width: 28, height: 28, objectFit: 'contain', display: 'block' }}
            />
            <span style={{ fontSize: 'var(--font-heading)', lineHeight: 'var(--lh-heading)', fontWeight: 600 }}>{copy.brandName}</span>
          </div>
          <div style={{ fontSize: 'var(--font-title)', lineHeight: 'var(--lh-title)', fontWeight: 600, marginBottom: 8 }}>{copy.title}</div>
          <div style={{ fontSize: 'var(--font-body)', color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 'var(--lh-body)' }}>
            {copy.description}
          </div>
          <button
            type="button"
            className="gg-fill"
            onClick={this.handleReload}
            style={{
              appearance: 'none',
              border: 'none',
              borderRadius: 'var(--radius-control)',
              background: 'var(--primary)',
              color: 'var(--primary-fg)',
              fontSize: 'var(--font-body)',
              lineHeight: 'var(--lh-body)',
              fontWeight: 600,
              minHeight: 'var(--control-h-xl)',
              padding: '0 16px',
              cursor: 'pointer',
            }}
          >
            {copy.reload}
          </button>
          {isDev && (
            <details style={{ marginTop: 16 }}>
              <summary
                style={{ fontSize: 'var(--font-body)', lineHeight: 'var(--lh-body)', color: 'var(--text-secondary)', cursor: 'pointer', userSelect: 'none' }}
              >
                {copy.diagnostics}
              </summary>
              <pre
                style={{
                  margin: '10px 0 0',
                  padding: 12,
                  borderRadius: 'var(--radius-control)',
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-subtle)',
                  color: 'var(--danger-fg)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  fontFamily: 'var(--font-family-mono)',
                  fontSize: 'var(--text-code)',
                  lineHeight: 'var(--lh-body)',
                }}
              >
                {this.state.error.stack || this.state.error.message}
              </pre>
            </details>
          )}
        </div>
      </div>
    )
  }
}
