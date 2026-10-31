import { app } from 'electron'
import { stripEmbeddedBrowserTokens } from './session/main/core/browser/browser-user-agent'

// Run before any browser context/window is created. CDP navigation can start
// before Electron's first navigation commits and bypass its per-page UA override;
// Chromium then uses this application fallback even when Session.getUserAgent()
// and WebContents.getUserAgent() both report a clean UA.
if (process.env.GUGU_SERVER_MODE !== '1') {
  app.userAgentFallback = stripEmbeddedBrowserTokens(app.userAgentFallback, app.getName())
}
