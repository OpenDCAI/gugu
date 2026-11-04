import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { Plugin } from 'vite'

/** A vector poster is parsed with HTML, before React, JS chunks or async fonts. */
export function startupFirstFrame(enabled: boolean): Plugin {
  const posterFile = fileURLToPath(new URL('../../apps/desktop/src/lib/startup-motion-poster.svg', import.meta.url))
  return {
    name: 'gugu-startup-first-frame',
    transformIndexHtml(html) {
      // The desktop commit remains independently deployable. Android explicitly
      // creates its held host through the native handoff, added in its own commit.
      if (!enabled) return html.replace(/<div data-gugu-boot[^>]*><!--gugu-startup-poster--><\/div>/, '')
      return html.replace('<!--gugu-startup-poster-->', readFileSync(posterFile, 'utf8'))
    },
  }
}
