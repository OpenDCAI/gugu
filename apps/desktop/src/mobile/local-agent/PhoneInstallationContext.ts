import { createContext } from 'react'

/** Native side effects require this owner to be bound to the actual phone installation. */
export const PhoneInstallationContext = createContext<string | null>(null)
