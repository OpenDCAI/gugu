import { startStartupMotion, deferStartupMotion, subscribeStartupContentReady, discardStartupMotion } from './startup-motion'
import { bootstrapAndroidStartup, isAndroidStartupRuntime } from '../platform/androidStartupHandoff'

// This HTML entry has no React import graph; the brand can play before React starts.
if (isAndroidStartupRuntime()) {
  void bootstrapAndroidStartup({
    defer: deferStartupMotion, start: startStartupMotion,
    onContentReady: subscribeStartupContentReady, discard: discardStartupMotion,
  })
} else startStartupMotion()
