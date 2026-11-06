import { localizedManifestText } from '@shared/extensions/catalog';
import { rpc } from '@renderer/lib/ipc';
import { showModal } from '@renderer/lib/modal/modal-provider';
import { log } from '@renderer/utils/logger';
import { askOpener, chooseOpener, fileOpenersFor, openWithKey, type FileOpenerCandidate } from '@shared/extensions/file-openers';
import { opensInEditor } from '@renderer/features/sessions/file-view/file-view-kinds';
import { installedExtensionsStore } from './installed-extensions-store';

/**
 * `candidate`: the App that opens it without asking — the one a link's place is told to (several: the person picks, and
 * no App is told, as in a chat).
 */
export type SessionOpener = { tabKind: string; candidate?: FileOpenerCandidate } | { preview: true } | { cancelled: true };

/**
 * Who opens a session's file (真源 §2.4, 主人 09-29 — 打开方式和操作系统一个道理): nobody claims it —
 * the file preview; one App — that App; several — the person's 「始终用它」 for that suffix, or
 * 「用哪个打开」 asks. Cancelled opens nothing. `ask`
 * (「用别的 App 打开」, an App's `files.openWith(file, { ask: true })`): every App that opens it, the person picks.
 */
export function pickSessionOpener(filePath: string, ask = false): Promise<SessionOpener> {
  const candidates = fileOpenersFor(filePath, installedExtensionsStore.manifests, 'session').filter((candidate) =>
    installedExtensionsStore.isEnabled(candidate.extensionId) && (candidate.suffix !== '*' || opensInEditor(filePath))
  );
  const remembered = (suffix: string) => installedExtensionsStore.openWithDefaults[openWithKey('session', suffix)] ?? null;
  const choice = ask ? askOpener(candidates) : chooseOpener(candidates, remembered);
  if (choice.kind === 'none') return Promise.resolve({ preview: true });
  if (choice.kind === 'one') return Promise.resolve({ tabKind: choice.candidate.tabKind, candidate: choice.candidate });
  return new Promise((resolve) => {
    showModal('openWithChooserModal', {
      fileName: filePath.split(/[\\/]/).pop() ?? filePath,
      candidates: choice.candidates.map(({ tabKind, tabTitle, app, onlyTab }) => ({ tabKind, tabTitle, appName: localizedManifestText(app, installedExtensionsStore.locale).name, onlyTab })),
      onSuccess: ({ tabKind, always }) => {
        if (always) {
          const key = openWithKey('session', choice.suffix);
          installedExtensionsStore.noteOpenWithDefault(key, tabKind!);
          void rpc.extensions.setOpenWithDefault({ key, tabKind: tabKind! }).then((result) => {
            if (!result.success) log.warn('The open-with choice was not kept:', result.error);
          });
        }
        resolve({ tabKind: tabKind! });
      },
      onClose: () => resolve({ cancelled: true }),
    });
  });
}
