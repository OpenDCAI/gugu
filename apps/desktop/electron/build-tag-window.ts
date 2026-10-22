import type { BrowserWindow, Size } from 'electron'
import { openWindowLayer, WINDOW_LAYER_RANK, type WindowLayerContent } from './window-layers'

const current = new WeakMap<BrowserWindow, WindowLayerContent['webContents']>()

/**
 * 构建角标保留右下角的位置,但不能画在宿主 DOM 里遮住网页占位。
 * 网页是原生 WebContentsView,角标是窗口里叠在它上面的一层(window-layers.ts);只占实际文字的大小,其余区域照常点击。
 * 内容由主窗 React portal 绘制,preferred-size-changed 同步展开/收起后的真实尺寸;内容清空(大小 0)就收起。
 */
export function openBuildTagLayer(parent: BrowserWindow, content: WindowLayerContent): void {
  const { webContents } = content
  // 一扇窗一枚角标:界面重新认领时(开发时热更新)会再开一层,换掉旧的(界面那边 ❌ 自己 close,见 window-layers.ts)。
  const previous = current.get(parent)
  if (previous && !previous.isDestroyed()) previous.close()
  current.set(parent, webContents)
  const view = openWindowLayer(parent, content, WINDOW_LAYER_RANK.buildTag)
  let size: Size | null = null
  const place = () => {
    if (parent.isDestroyed() || webContents.isDestroyed() || !size) return
    const [width, height] = parent.getContentSize()
    view.setBounds({ x: width - size.width - 2, y: height - size.height - 2, ...size })
    view.setVisible(true)
  }
  webContents.on('preferred-size-changed', (_event, preferred) => {
    if (!Number.isFinite(preferred.width) || !Number.isFinite(preferred.height)) return
    if (preferred.width <= 0 || preferred.height <= 0) {
      size = null
      view.setVisible(false)
      return
    }
    size = { width: Math.ceil(preferred.width), height: Math.ceil(preferred.height) }
    place()
  })
  parent.on('resize', place)
  webContents.once('destroyed', () => parent.removeListener('resize', place))
}
