import type { IconComponent } from '@/lib/icons'
import type { TriggerConfig } from '@shared/core/automations/config';

export type BuiltinAutomationTemplate = {
  id: string;
  category: string;
  name: string;
  description: string;
  icon: IconComponent;
  defaultTrigger: TriggerConfig;
  defaultSessionConfig: {
    initialPrompt: string;
  };
};
