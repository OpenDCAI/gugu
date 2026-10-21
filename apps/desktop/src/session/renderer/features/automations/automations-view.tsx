import { type ReactNode } from 'react';
import { ShellTitlebar } from '@renderer/lib/components/titlebar/shell-titlebar';
import { AutomationsBreadcrumb } from './components/AutomationsBreadcrumb';
import { AutomationsView } from './components/AutomationsView';

export function AutomationsViewWrapper({
  children,
  automationId: _automationId,
}: {
  children: ReactNode;
  automationId?: string;
}) {
  return <>{children}</>;
}

export function AutomationsTitlebar() {
  return <ShellTitlebar leftSlot={<AutomationsBreadcrumb />} />;
}

export function AutomationsMainPanel() {
  return <AutomationsView />;
}

export const automationsView = {
  WrapView: AutomationsViewWrapper,
  TitlebarSlot: AutomationsTitlebar,
  MainPanel: AutomationsMainPanel,
};
