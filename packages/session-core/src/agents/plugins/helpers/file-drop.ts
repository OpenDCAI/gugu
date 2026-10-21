import type { PluginFs } from '../../runtime/fs';
import type { PluginScope } from '../capabilities/plugins';
import { removeLegacyGuguFiles } from './hook-config';

export function createFileDropPlugin(opts: {
  relativePath: string;
  content: string | ((ctx: { platform: NodeJS.Platform }) => string);
  /** 这个文件改名前的路径 —— 写新文件后删掉(只删带旧钩子标记的),免得 agent 同时加载两份。 */
  legacyRelativePaths?: readonly string[];
}) {
  const getContent = typeof opts.content === 'string' ? () => opts.content as string : opts.content;

  return {
    async installPlugin(fs: PluginFs, _scope: PluginScope): Promise<string[]> {
      const content = getContent({ platform: process.platform });
      await fs.write(opts.relativePath, content);
      await removeLegacyGuguFiles(fs, opts.legacyRelativePaths ?? []);
      return [opts.relativePath];
    },
    async uninstallPlugin(fs: PluginFs, _scope: PluginScope): Promise<void> {
      await fs.delete(opts.relativePath);
      await removeLegacyGuguFiles(fs, opts.legacyRelativePaths ?? []);
    },
    async isPluginInstalled(fs: PluginFs, _scope: PluginScope): Promise<boolean> {
      return fs.exists(opts.relativePath);
    },
    async getPluginVersion(_fs: PluginFs, _scope: PluginScope): Promise<string> {
      return '1.0.0';
    },
    async getPluginPath(_fs: PluginFs, _scope: PluginScope): Promise<string> {
      return opts.relativePath;
    },
  };
}
