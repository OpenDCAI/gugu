/**
 * Split an OS drop payload into directories and plain files.
 *
 * Directories show up in `DataTransfer.files` as ordinary `File` entries, but
 * their bytes cannot be read (`arrayBuffer()` rejects) — an attachment channel
 * that tries to persist them fails silently. The reliable directory signal is
 * the entry behind each item (`webkitGetAsEntry`), not the `File` itself.
 *
 * Items are consumed synchronously during the drop event; after the handler
 * returns, `DataTransferItem` accessors start returning null.
 */
export function splitDroppedFiles(dataTransfer: DataTransfer): {
  directories: File[];
  /** 与 `directories` 一一对应的目录项(宿主要读里面的东西时用;只在 drop 当下拿得到)。 */
  directoryEntries: FileSystemDirectoryEntry[];
  files: File[];
} {
  const directories: File[] = [];
  const directoryEntries: FileSystemDirectoryEntry[] = [];
  const files: File[] = [];

  // Environments without an items list (none known today) keep the legacy
  // behavior: everything is treated as a plain file.
  const items = Array.from(dataTransfer.items ?? []);
  if (items.length === 0) {
    return { directories, directoryEntries, files: Array.from(dataTransfer.files ?? []) };
  }

  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry && (entry as FileSystemDirectoryEntry).isDirectory === true) {
      directories.push(file);
      directoryEntries.push(entry as FileSystemDirectoryEntry);
    } else {
      files.push(file);
    }
  }
  return { directories, directoryEntries, files };
}
