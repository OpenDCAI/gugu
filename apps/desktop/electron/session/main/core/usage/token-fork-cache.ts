import { canonicalizeCodexForks } from './token-forks';
import type { ParsedLogFile } from './token-log-file';
import { asRecord, type TokenEntry } from './token-readers/types';

type File = { path: string; parsed: ParsedLogFile };
type Component = { files: File[]; counts: number[]; signatures: string[]; output: Map<string, readonly TokenEntry[]> };

/** Unchanged fork components reuse their normalized entries; unrelated sessions never get refolded. */
export function createCodexForkCache() {
  let previous = new Map<string, Component>();
  return (files: readonly File[]): Map<string, readonly TokenEntry[]> => {
    const links = new Map<string, string[]>(), scopes = new Map<string, string>();
    const signatures = new Map<string, string>();
    const add = (key: string, value: string) => { const list = links.get(key); if (list) list.push(value); else links.set(key, [value]); };
    for (const file of files) {
      const state = asRecord(file.parsed.state);
      const scope = typeof state?.scope === 'string' ? state.scope : `file:${file.path}`;
      const parent = typeof state?.forkedFrom === 'string' ? state.forkedFrom : '';
      scopes.set(file.path, scope); signatures.set(file.path, JSON.stringify([scope, parent]));
      if (!links.has(scope)) links.set(scope, []);
      if (parent) { add(scope, parent); add(parent, scope); }
    }
    const componentOf = new Map<string, number>();
    let nextId = 0;
    for (const scope of links.keys()) {
      if (componentOf.has(scope)) continue;
      const pending = [scope], id = nextId++;
      while (pending.length) {
        const current = pending.pop()!;
        if (componentOf.has(current)) continue;
        componentOf.set(current, id); pending.push(...(links.get(current) ?? []));
      }
    }
    const groups = new Map<number, File[]>();
    for (const file of files) {
      const id = componentOf.get(scopes.get(file.path)!)!, group = groups.get(id);
      if (group) group.push(file); else groups.set(id, [file]);
    }
    const next = new Map<string, Component>(), output = new Map<string, readonly TokenEntry[]>();
    for (const group of groups.values()) {
      // Preserve full canonicalizer input order, including duplicate-scope tie breaking.
      const key = JSON.stringify(group.map((file) => file.path)), cached = previous.get(key);
      const unchanged = cached && group.every((file, i) => file.parsed === cached.files[i].parsed
        && file.parsed.entries.length === cached.counts[i] && signatures.get(file.path) === cached.signatures[i]);
      const component = unchanged ? cached : { files: group, counts: group.map((file) => file.parsed.entries.length),
        signatures: group.map((file) => signatures.get(file.path)!), output: canonicalizeCodexForks(group) };
      next.set(key, component);
      for (const [path, entries] of component.output) output.set(path, entries);
    }
    previous = next;
    return output;
  };
}
