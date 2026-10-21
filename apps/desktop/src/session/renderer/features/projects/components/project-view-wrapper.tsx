import type { ReactNode } from 'react';

interface ProjectViewWrapperProps {
  children: ReactNode;
  projectId: string;
}

/** Renders nothing of its own: it exists so the view registry can type the project view's params. */
export function ProjectViewWrapper({ children }: ProjectViewWrapperProps) {
  return <>{children}</>;
}
