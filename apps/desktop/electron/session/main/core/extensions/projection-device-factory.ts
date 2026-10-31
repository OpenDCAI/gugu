import { nativeImage } from 'electron';
import { createProjectionDeviceHost, type ProjectionDeviceHostOptions } from './projection-device-host';
import { extensionProjections } from './extension-projection-bridge';
import { extensionsService } from './extensions-root';
import { createProjectionImageDecoder } from './projection-image';
import { openMediaProcess } from '../../../../../native/projection-media/node/host.mjs';

export type ProjectionDeviceFactoryOptions = Pick<ProjectionDeviceHostOptions, 'identity' | 'report'> & {
  /** Trusted host configuration, never App/RPC arguments. Missing artifacts fail closed. */
  executables(): { executable: string; ffmpeg: string };
};
export function createSessionpageProjectionDeviceHost(options: ProjectionDeviceFactoryOptions) {
  return createProjectionDeviceHost({ ...options,
    assertApp(id, version) {
      const service = extensionsService();
      if (service.get(id).manifest.version !== version || !service.isEnabled(id) || !service.hasCapability(id, 'agents:tools')) {
        throw new Error('Projection App version or capability changed');
      }
    },
    createFeed(binding, source, context) {
      const binaries = options.executables();
      return extensionProjections.remoteMediaFeed(binding, source, context,
        () => createProjectionImageDecoder(nativeImage.createFromBuffer, { r: 0, g: 0, b: 0 }),
        (size, signal, onControl) => openMediaProcess({ ...binaries, ...size, fps: 15, bitrate: 2_000_000, signal, onControl }));
    },
  });
}
