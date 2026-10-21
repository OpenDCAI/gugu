import { ChevronDown, FolderClosed } from '@/lib/icons'
import { observer } from 'mobx-react-lite';
import React, { useState } from 'react';
import {
  asMounted,
  getProjectManagerStore,
} from '@renderer/features/projects/stores/project-selectors';
import { isImplicitSessionHomeProject } from '@renderer/features/sessions/session-home-project-constants';
import { machineRegistry } from '@renderer/lib/machine-routing';
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxTrigger,
  ComboboxValue,
} from '@renderer/lib/ui/combobox';
import { useSessionMessages } from '@renderer/localization/use-session-messages';

interface ProjectOption {
  value: string;
  label: string;
}

function ProjectIcon() {
  const Icon = FolderClosed;
  return <Icon className="text-foreground-muted h-4 w-4 shrink-0" />;
}

interface ProjectSelectorProps {
  value: string | undefined;
  onChange: (projectId: string) => void;
  trigger?: React.ReactNode;
  /** #6264 只列这台机器上的项目(null = 这台电脑);不给 = 全部。 */
  machine?: string | null;
}

export const ProjectSelector = observer(function ProjectSelector({
  value,
  onChange,
  trigger,
  machine,
}: ProjectSelectorProps) {
  const { translate } = useSessionMessages();
  const [open, setOpen] = useState(false);

  const options: ProjectOption[] = Array.from(getProjectManagerStore().projects.entries()).flatMap(
    ([id, store]) => {
      if (isImplicitSessionHomeProject(store)) return [];
      if (machine !== undefined && machineRegistry.machineOf(id) !== machine) return [];
      const mounted = asMounted(store);
      return mounted
        ? [{ value: id, label: mounted.data.name }]
        : [];
    }
  );

  const selectedOption = options.find((o) => o.value === value) ?? null;

  function handleValueChange(item: ProjectOption | null) {
    if (!item) return;
    onChange(item.value);
    setOpen(false);
  }

  return (
    <Combobox
      items={[{ value: 'options', items: options }]}
      value={selectedOption}
      onValueChange={handleValueChange}
      open={open}
      onOpenChange={setOpen}
      isItemEqualToValue={(a: ProjectOption, b: ProjectOption) => a.value === b.value}
      filter={(item: ProjectOption, query) =>
        item.label.toLowerCase().includes(query.toLowerCase())
      }
      autoHighlight
    >
      {trigger ?? (
        <ComboboxTrigger className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-border bg-transparent px-2.5 py-2 text-sm outline-none hover:bg-row-hover data-popup-open:bg-row-selected">
          {selectedOption && <ProjectIcon />}
          <ComboboxValue placeholder={translate('createTask.selectProject')} />
          <ChevronDown className="ml-auto size-4 shrink-0 text-foreground-passive" />
        </ComboboxTrigger>
      )}
      <ComboboxContent className="w-auto min-w-(--anchor-width)">
        <ComboboxInput showTrigger={false} placeholder={translate('createTask.searchProjects')} />
        <ComboboxList className="pb-0">
          {(group: { value: string; items: ProjectOption[] }) => (
            <ComboboxGroup key={group.value} items={group.items} className="py-1">
              <ComboboxCollection>
                {(item: ProjectOption) => (
                  <ComboboxItem key={item.value} value={item} className="flex items-center gap-2">
                    <ProjectIcon />
                    {item.label}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
});
