import { createContext, useContext } from 'react'
import type { FirstRunHarness } from '@gugu/core/shared/firstRun'

export const FirstRunInstallContext = createContext<(ids: FirstRunHarness[]) => void>(() => {
  throw new Error('FirstRunInstallProvider is missing')
})

export const useFirstRunInstaller = () => useContext(FirstRunInstallContext)
