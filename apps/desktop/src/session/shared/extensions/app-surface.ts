import { z } from 'zod';
import { bundlePathSchema } from './manifest';

export const surfaceBoundsSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite(),
  width: z.number().int().min(1).max(4096), height: z.number().int().min(1).max(4096) });
export type AppSurfaceBounds = z.infer<typeof surfaceBoundsSchema>;
export const surfaceScreenSchema = z.strictObject({ bounds: surfaceBoundsSchema.extend({ width: z.number().int().min(1).max(65536), height: z.number().int().min(1).max(65536) }),
  space: z.enum(['screen-dip', 'windows-screen-pixels']).default('screen-dip') });
export type AppSurfaceScreen = { bounds: AppSurfaceBounds; workArea: AppSurfaceBounds; scaleFactor: number };
const relativeWindowSchema = z.strictObject({ windowId: z.string().regex(/^[1-9][0-9]{0,31}$/) });
export const appSurfaceOptionsSchema = z.strictObject({
  entry: bundlePathSchema.refine(entry => !/[?#:%]/.test(entry), 'entry must name a bundle file'),
  bounds: surfaceBoundsSchema, data: z.unknown().optional(),
  visible: z.boolean().default(true),
  /** Creation-only: native input passthrough; never an interactive surface. */
  decorative: z.boolean().default(false),
  relativeTo: relativeWindowSchema.nullable().optional(),
});
export const appSurfaceUpdateSchema = z.strictObject({ bounds: surfaceBoundsSchema.optional(), data: z.unknown().optional(),
  visible: z.boolean().optional(), relativeTo: relativeWindowSchema.nullable().optional() });
export type AppSurfaceOptions = z.infer<typeof appSurfaceOptionsSchema>;
export type AppSurfaceUpdate = z.infer<typeof appSurfaceUpdateSchema>;
export type AppSurfaceEvent = { id: string } & (
  | { type: 'display'; shown: boolean; reason?: string }
  | { type: 'message'; message: unknown }
  | { type: 'data'; data: unknown }
  | { type: 'closed'; reason: string }
);
export interface AppSurfaceHost {
  surfaces?: {
    open(args: z.input<typeof appSurfaceOptionsSchema>): Promise<{ id: string; shown: false }>;
    screen(args: z.input<typeof surfaceScreenSchema>): Promise<AppSurfaceScreen>;
    update(args: { id: string; update: AppSurfaceUpdate }): Promise<void>;
    close(args: { id: string }): Promise<void>;
    post(args: { message: unknown }): Promise<void>;
  };
  onSurface?(listener: (event: AppSurfaceEvent) => void): () => void;
}
