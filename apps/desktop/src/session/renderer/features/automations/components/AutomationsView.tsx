import { observer } from 'mobx-react-lite';
import { useMemo, useState } from 'react';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from '@renderer/lib/components/pagination';
import { DeviceScopeNoticeLine, DeviceScopeProvider, useSelectedRemoteDevice } from '@renderer/features/remote-hosts/device-scope-picker';
import { deviceScopeNotice } from '@renderer/features/remote-hosts/device-scope-notice';
import { automationsDeviceStore } from '@renderer/features/remote-hosts/device-scope-store';
import { LibraryHostProvider, machineLibraryHost } from '@renderer/features/library/library-host';
import { useNavigate, useParams } from '@renderer/lib/layout/navigation-provider';
import { useShowModal } from '@renderer/lib/modal/modal-provider';
import { Sheet, SheetContent } from '@renderer/lib/ui/sheet';
import { useSessionMessages } from '@renderer/localization/use-session-messages';
import type { Automation } from '@shared/core/automations/automation';
import type { BuiltinAutomationTemplate } from '../automation-template';
import { buildBuiltinAutomationCatalog } from '../builtin-catalog';
import {
  AutomationsHostProvider,
  createMachineAutomationsHost,
  LOCAL_AUTOMATIONS_HOST,
  useAutomationsHost,
  type AutomationsHost,
} from '../automations-host';
import { useAutomations } from '../use-automations';
import { AutomationDetailView } from './AutomationDetailView';
import { AutomationsHeader } from './AutomationsHeader';
import { AutomationsList } from './AutomationsList';
import { AutomationTemplatesEmptyState } from './AutomationTemplatesEmptyState';
import { CreateAutomationView } from './CreateAutomationView';
import { remoteHostsStore } from '@renderer/features/remote-hosts/remote-hosts-store';

/**
 * #6264「已安排」是分机器的(owner:「整个资源库或者其他的都是分设备的」):页头一个机器选择器,默认本机;
 * 选了别的机器,列表、新建、改、立即运行、停止、删除都是那台机器上的,由那台机器自己的调度器按时跑。
 * 换机器 = 换一份页面(key 按机器),上一台的搜索词、打开着的抽屉不带到下一台。
 */
export const AutomationsView = observer(function AutomationsView() {
  const selected = useSelectedRemoteDevice(automationsDeviceStore);
  const deviceId = selected?.deviceId ?? null;
  const label = selected?.device.label ?? '';
  const online = selected?.device.isOnline ?? false;
  const lastSeenAt = selected?.device.lastSeenAt ?? null;
  const hostKind = selected?.device.hostKind;
  const host = useMemo<AutomationsHost>(
    () =>
      deviceId
        ? createMachineAutomationsHost({ deviceId, deviceLabel: label, online, lastSeenAt })
        : LOCAL_AUTOMATIONS_HOST,
    [deviceId, label, online, lastSeenAt]
  );
  // 新建 / 改的表单里「用哪家、哪个模型」问的也是那台机器(与新建框选别的机器同一个来源:LibraryHost)。
  const library = useMemo(
    () =>
      machineLibraryHost(deviceId ? { deviceId, deviceLabel: label, online, lastSeenAt, hostKind } : null),
    [deviceId, label, online, lastSeenAt, hostKind]
  );
  return (
    <AutomationsHostProvider value={host} key={host.key}>
      <LibraryHostProvider value={library}>
        <AutomationsViewBody />
      </LibraryHostProvider>
    </AutomationsHostProvider>
  );
});

function AutomationsViewBody() {
  const { automations, toggleEnabled, destroy } = useAutomations();
  const host = useAutomationsHost();
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const [creating, setCreating] = useState(false);
  const [initialTemplate, setInitialTemplate] = useState<BuiltinAutomationTemplate | undefined>();
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null);
  const showConfirm = useShowModal('confirmActionModal');
  const { navigate } = useNavigate();
  const { params, setParams } = useParams('automations');
  const { translate } = useSessionMessages();
  const templates = useMemo(() => buildBuiltinAutomationCatalog(translate), [translate]);

  const automationData = automations.data;
  const effectiveAutomations = useMemo(
    () => (automationData ?? []).filter((a) => a.name.toLowerCase().includes(search.toLowerCase())),
    [automationData, search]
  );
  const pageSize = 25;
  const lastPage = Math.max(0, Math.ceil(effectiveAutomations.length / pageSize) - 1);
  const currentPage = Math.min(page, lastPage);
  if (page !== currentPage) setPage(currentPage);
  const pageAutomations = effectiveAutomations.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  const hasLoadedAutomations = automationData !== undefined;
  // 看的是别的机器、它此刻给不出东西:说一句人话;离线时照旧画上次读到的、只读。
  const notice = deviceScopeNotice(
    { remote: host.remote, error: automations.error, hasData: hasLoadedAutomations, now: Date.now(), cloud: remoteHostsStore.cloudScope(host.remote?.deviceId) },
    translate
  );
  const readOnly = !!notice?.readOnly;
  const isEmpty = automationData !== undefined && automationData.length === 0;
  const hasSearchResults = effectiveAutomations.length > 0;

  const liveAutomation = params.automationId
    ? (automations.data?.find((a) => a.id === params.automationId) ?? null)
    : null;

  function closeSheet() {
    setParams({ automationId: undefined });
    setCreating(false);
    setInitialTemplate(undefined);
  }

  function openCreateSheet(template?: BuiltinAutomationTemplate) {
    setInitialTemplate(template);
    setCreating(true);
  }

  function handleToggleEnabled(automation: Automation, enabled: boolean) {
    if (readOnly) return;
    void toggleEnabled.mutateAsync({ id: automation.id, enabled });
  }

  function handleDelete(automation: Automation) {
    setPendingDelete(automation);
    closeSheet();
  }

  function handleSheetOpenChangeComplete(open: boolean) {
    if (open || !pendingDelete) return;

    // The sheet is modal and makes sibling portals inert. Wait until it has fully closed before
    // opening the global confirmation dialog so that the dialog remains interactive.
    const automation = pendingDelete;
    setPendingDelete(null);
    showConfirm({
      title: translate('automations.deleteTitle'),
      description: translate('automations.deleteDescription', { name: automation.name }),
      confirmLabel: translate('automations.delete'),
      onSuccess: () => {
        void destroy
          .mutateAsync(automation.id)
          .catch(() => setParams({ automationId: automation.id }));
      },
      onClose: () => setParams({ automationId: automation.id }),
    });
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-background text-foreground">
      <div className="h-6 shrink-0 [-webkit-app-region:drag]" />
      <div className="mx-auto grid min-h-0 w-full max-w-4xl flex-1 grid-cols-1 gap-8">
        <div className="relative min-h-0 w-full min-w-0 overflow-y-auto px-8">
          <div className="w-full py-8">
            <DeviceScopeProvider store={automationsDeviceStore}>
              <AutomationsHeader
                search={search}
                onSearchChange={(value) => { setSearch(value); setPage(0); }}
                createPending={readOnly}
                onNewAutomation={() => openCreateSheet()}
              />
            </DeviceScopeProvider>
            {notice && <DeviceScopeNoticeLine notice={notice} onRetry={() => void automations.refetch()} />}
            {notice && !hasLoadedAutomations ? null : isEmpty ? (
              <AutomationTemplatesEmptyState
                templates={templates}
                onSelectTemplate={openCreateSheet}
              />
            ) : hasSearchResults ? (
              <>
                <AutomationsList
                  automations={pageAutomations}
                  onEdit={(automation) => navigate('automations', { automationId: automation.id })}
                  onToggleEnabled={handleToggleEnabled}
                />
                {lastPage > 0 && (
                  <Pagination className="border-t py-1">
                    <PaginationContent>
                      <PaginationItem>
                        <PaginationPrevious
                          onClick={currentPage > 0 ? () => setPage(currentPage - 1) : undefined}
                          aria-disabled={currentPage === 0}
                          className={currentPage === 0 ? 'pointer-events-none opacity-50' : ''}
                        />
                      </PaginationItem>
                      <PaginationItem>
                        <span className="px-2 text-xs text-foreground-muted">
                          {translate('automations.page', { page: currentPage + 1 })}
                        </span>
                      </PaginationItem>
                      <PaginationItem>
                        <PaginationNext
                          onClick={currentPage < lastPage ? () => setPage(currentPage + 1) : undefined}
                          aria-disabled={currentPage === lastPage}
                          className={currentPage === lastPage ? 'pointer-events-none opacity-50' : ''}
                        />
                      </PaginationItem>
                    </PaginationContent>
                  </Pagination>
                )}
              </>
            ) : hasLoadedAutomations ? (
              <div className="py-8 text-sm text-foreground-muted">
                {translate('automations.searchEmpty')}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      <Sheet
        open={liveAutomation !== null || creating}
        onOpenChange={(open) => !open && closeSheet()}
        onOpenChangeComplete={handleSheetOpenChangeComplete}
      >
        <SheetContent showCloseButton={false}>
          {creating && (
            <CreateAutomationView
              readOnly={readOnly}
              onClose={closeSheet}
              onSaved={closeSheet}
              initialTemplate={initialTemplate}
            />
          )}
          {liveAutomation && (
            <AutomationDetailView
              readOnly={readOnly}
              automation={liveAutomation}
              onClose={closeSheet}
              onDelete={handleDelete}
              onToggleEnabled={handleToggleEnabled}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
