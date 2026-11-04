import type { Text } from '@codemirror/state';
import type { IPosition } from 'monaco-editor';

/** Both editors count UTF-16 columns. CM's Text removes CRLF separators. */
export function modelPosition(doc: Text, position: number): IPosition;
export function modelPosition(doc: Text, position: IPosition): number;
export function modelPosition(doc: Text, position: number | IPosition): IPosition | number {
  if (typeof position === 'number') {
    const line = doc.lineAt(position);
    return { lineNumber: line.number, column: position - line.from + 1 };
  }
  return doc.line(position.lineNumber).from + position.column - 1;
}
