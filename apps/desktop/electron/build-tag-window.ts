import type { BrowserWindow, Size } from 'electron'
import { BUILD_TAG_WINDOW_NAME } from '@shared/aux-window'
import type { SpecialAuxWindow } from './aux-window'
import { hideChild, showChildAbove } from './child-window'
import { hardenWebPreferences } from './devtools-lock'

/**
 * 构建角标保留右下角的位置,但不能画在宿主 DOM 里遮住网页占位。
 * 网页是原生 WebContentsView,角标也是它上面的一扇小子窗;只占实际文字的大小,其余区域照常点击。
 * 内容由主窗 React portal 绘制,preferred-size-changed 同步展开/收起后的真实尺寸。
 */
export function createBuildTagAuxWindow(parent: BrowserWindow): SpecialAuxWindow {
  return {
    name: BUILD_TAG_WINDOW_NAME,
    options: () => ({
      parent,
      width: 1,
      height: 1,
      useContentSize: true,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      roundedCorners: false,
      webPreferences: hardenWebPreferences({
        sandbox: false,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        enablePreferredSizeMode: true,
      }),
    }),
    adopt: (child) => {
      let size: Size | null = null
      const place = () => {
        if (child.isDestroyed() || parent.isDestroyed() || !size) return
        const bounds = parent.getContentBounds()
        child.setBounds({
          x: bounds.x + bounds.width - size.width - 2,
          y: bounds.y + bounds.height - size.height - 2,
          ...size,
        })
        const wanted = () => !parent.isDestroyed() && parent.isVisible() && !parent.isMinimized()
        if (!wanted()) hideChild(child)
        // 与 agent 原生浮层同样处理(child-window.ts)。
        else if (!child.isVisible()) showChildAbove(child, parent, wanted)
      }
      child.webContents.on('preferred-size-changed', (_event, preferred) => {
        if (!Number.isFinite(preferred.width) || !Number.isFinite(preferred.height) || preferred.width <= 0 || preferred.height <= 0) return
        size = { width: Math.ceil(preferred.width), height: Math.ceil(preferred.height) }
        place()
      })
      parent.on('move', place)
      parent.on('resize', place)
      parent.on('show', place)
      parent.on('hide', place)
      parent.on('minimize', place)
      parent.on('restore', place)
      child.once('closed', () => {
        parent.removeListener('move', place)
        parent.removeListener('resize', place)
        parent.removeListener('show', place)
        parent.removeListener('hide', place)
        parent.removeListener('minimize', place)
        parent.removeListener('restore', place)
      })
    },
  }
}
