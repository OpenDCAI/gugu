import { createContext,useContext } from 'react'
export const ConnectionMutationContext = createContext(true)
export const useConnectionMutationAllowed = () => useContext(ConnectionMutationContext)
