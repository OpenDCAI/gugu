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
