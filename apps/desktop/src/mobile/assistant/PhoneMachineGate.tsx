import type { ReactNode } from 'react'
import type { PhoneReadiness } from './phoneMachine'

/** Cloud reads have their own loading/error states and never prepare a host. */
export function PhoneMachineGate({ children }: { readiness: PhoneReadiness; name: string; children: ReactNode }) {
  return <>{children}</>
}
