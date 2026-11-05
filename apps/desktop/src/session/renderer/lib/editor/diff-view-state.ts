export interface DiffSideState {
  ranges: Array<{ anchor: number; head: number }>;
  mainIndex: number;
  scrollLeft: number;
}

export interface DiffViewState {
  original: DiffSideState | null;
  modified: DiffSideState;
  scrollTop: number;
}

/** The file editor's cursor and scroll for one buffer, kept across tab switches. */
export interface FileViewState extends DiffSideState {
  scrollTop: number;
}
