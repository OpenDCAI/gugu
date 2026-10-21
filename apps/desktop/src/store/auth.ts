import { createContext, useContext } from 'react'
import type { SessionCoordinatorStatus } from '../lib/sessionCoordinator'

export interface AuthUser {
  id: string
  /** Session ownership is established, but the canonical identity row has not committed yet. */
  identityPending?: boolean
  gugu_number?: number | null
  email: string
  nickname: string
  avatarUrl?: string
  bio?: string | null
  // Legacy identity.users.onboarded_at value; retained in the profile model but no longer gates UI.
  onboardedAt?: string | null
}

interface AuthContextValue {
  user: AuthUser | null
  loading: boolean
  status: SessionCoordinatorStatus
  updateUser: (user: AuthUser) => void
  logout: () => Promise<{ success: boolean }>
}

export const AuthContext = createContext<AuthContextValue>({
  user: null,
  loading: true,
  status: 'boot-restoring',
  updateUser: () => {},
  logout: async () => ({ success: false }),
})

export function useAuth(): AuthContextValue {
  return useContext(AuthContext)
}
