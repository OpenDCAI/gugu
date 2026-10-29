/** Local preview feed and shared input semantics. Remote video uses the media track, never this bitmap feed. */
export const PROJECTION_FRAME_BYTES = 512 * 1024;
export const PROJECTION_TEXT_LENGTH = 64 * 1024;

export type ProjectionFrame = {
  /** Increasing within this source. A reconnect requires a newly published frame. */
  sequence: number;
  /** The source's input coordinate space; the encoded image may have a different pixel density. */
  width: number;
  height: number;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  data: string;
};

type Modifiers = Array<'alt' | 'control' | 'meta' | 'shift'>;
export type ProjectionInput =
  | { kind: 'pointer'; action: 'move' | 'down' | 'up'; x: number; y: number; button: 'left' | 'middle' | 'right'; modifiers?: Modifiers }
  | { kind: 'wheel'; x: number; y: number; deltaX: number; deltaY: number; modifiers?: Modifiers }
  | { kind: 'key'; action: 'down' | 'up'; key: string; modifiers?: Modifiers }
  | { kind: 'text'; text: string; source?: 'typing' | 'ime' | 'paste' };

/** Pointer coordinates are normalized in the frame's input space, independent of view size and pixel density. */
export type ProjectionViewerPacket =
  | { type: 'ack'; generation: string; frame: number }
  | { type: 'input'; generation: string; frame: number; sequence: number; input: ProjectionInput };

export type ProjectionHostPacket =
  | { type: 'state'; generation: string; state: 'connecting' | 'live' | 'closed'; reason?: string }
  | { type: 'frame'; generation: string; frame: ProjectionFrame };

export type ProjectionSourceEvent =
  | { type: 'refresh'; id: string }
  | { type: 'close'; id: string }
  | { type: 'cancel'; id: string; requestId: string }
  | { type: 'disconnect'; id: string; requestId: string; viewer: string }
  | { type: 'input'; id: string; requestId: string; viewer: string; input: ProjectionInput; frame: Pick<ProjectionFrame, 'sequence' | 'width' | 'height'> };

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid projection packet');
  return value as Record<string, unknown>;
};

export function projectionFrame(raw: unknown): ProjectionFrame {
  const value = record(raw);
  const positive = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
  if (typeof value.data !== 'string' || typeof value.mime !== 'string') throw new Error('Invalid projection frame');
  const paddedBytes = value.data.length / 4 * 3;
  const bytes = paddedBytes - (value.data.endsWith('==') ? 2 : value.data.endsWith('=') ? 1 : 0);
  if (!positive(value.sequence) || !positive(value.width) || !positive(value.height)
    || value.width > 8192 || value.height > 8192 || value.width * value.height > 16_777_216
    || !['image/png', 'image/jpeg', 'image/webp'].includes(value.mime)
    || !value.data.length || value.data.length % 4 !== 0 || bytes > PROJECTION_FRAME_BYTES
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.data)) throw new Error('Invalid projection frame');
  // Snapshot the scalar fields: a producer retaining its object cannot change an admitted frame.
  return { sequence: value.sequence, width: value.width, height: value.height, mime: value.mime as ProjectionFrame['mime'], data: value.data };
}

export function projectionInput(raw: unknown): ProjectionInput {
  const value = record(raw);
  const point = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  const modifiers = value.modifiers;
  if (modifiers !== undefined && (!Array.isArray(modifiers) || modifiers.length > 4
    || modifiers.some(v => !['alt', 'control', 'meta', 'shift'].includes(v)))) {
    throw new Error('Invalid projection modifiers');
  }
  const withModifiers = modifiers ? { modifiers: [...modifiers as Modifiers] } : {};
  switch (value.kind) {
    case 'pointer':
      if (point(value.x) && point(value.y) && typeof value.action === 'string' && ['move', 'down', 'up'].includes(value.action)
        && typeof value.button === 'string' && ['left', 'middle', 'right'].includes(value.button)) return {
        kind: value.kind, action: value.action as 'move' | 'down' | 'up', x: value.x, y: value.y,
        button: value.button as 'left' | 'middle' | 'right', ...withModifiers,
      };
      break;
    case 'wheel':
      if (point(value.x) && point(value.y) && typeof value.deltaX === 'number' && typeof value.deltaY === 'number'
        && Number.isFinite(value.deltaX) && Number.isFinite(value.deltaY)
        && Math.abs(value.deltaX) <= 10_000 && Math.abs(value.deltaY) <= 10_000) return {
        kind: value.kind, x: value.x, y: value.y, deltaX: value.deltaX, deltaY: value.deltaY, ...withModifiers,
      };
      break;
    case 'key':
      if (typeof value.action === 'string' && ['down', 'up'].includes(value.action)
        && typeof value.key === 'string' && value.key.length > 0 && value.key.length <= 128) return {
        kind: value.kind, action: value.action as 'down' | 'up', key: value.key, ...withModifiers,
      };
      break;
    case 'text':
      if (typeof value.text === 'string' && value.text.length <= PROJECTION_TEXT_LENGTH
        && (value.source === undefined || value.source === 'typing' || value.source === 'ime' || value.source === 'paste')) {
        return { kind: value.kind, text: value.text, ...(value.source === undefined ? {} : { source: value.source }) };
      }
      break;
  }
  throw new Error('Invalid projection input');
}

export function projectionViewerPacket(raw: unknown): ProjectionViewerPacket {
  const value = record(raw);
  if (typeof value.generation !== 'string' || !value.generation || value.generation.length > 128
    || typeof value.frame !== 'number' || !Number.isSafeInteger(value.frame) || value.frame < 1) {
    throw new Error('Invalid projection viewer packet');
  }
  if (value.type === 'ack') return { type: value.type, generation: value.generation, frame: value.frame };
  if (value.type === 'input' && typeof value.sequence === 'number' && Number.isSafeInteger(value.sequence) && value.sequence > 0) {
    return { type: value.type, generation: value.generation, frame: value.frame, sequence: value.sequence, input: projectionInput(value.input) };
  }
  throw new Error('Invalid projection viewer packet');
}
