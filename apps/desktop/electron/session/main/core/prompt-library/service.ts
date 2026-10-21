import type { IInitializable } from '@gugu/session-shared';
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { KV } from '@main/db/kv';
import { appSettings } from '@main/db/schema';
import {
  PROMPT_LIBRARY_SEED_VERSION,
  promptLibrarySchema,
  type PromptLibraryPrompt,
} from '@shared/prompt-library';

type PromptLibraryKV = {
  prompts: PromptLibraryPrompt[];
  seedVersion: number;
};

const promptLibraryKV = new KV<PromptLibraryKV>('prompt-library');

export class PromptLibraryService implements IInitializable {
  private seedPromise: Promise<void> | null = null;

  private async readPrompts(): Promise<PromptLibraryPrompt[]> {
    const prompts = await promptLibraryKV.get('prompts');
    const parsed = promptLibrarySchema.safeParse(prompts ?? []);
    return parsed.success ? parsed.data : [];
  }

  private async readLegacyAppSetting(key: string): Promise<unknown | null> {
    const rows = await db
      .select({ value: appSettings.value })
      .from(appSettings)
      .where(eq(appSettings.key, key))
      .limit(1);
    const raw = rows[0]?.value;
    if (!raw) return null;

    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }

  private async deleteLegacyPromptSettings(): Promise<void> {
    await db.delete(appSettings).where(eq(appSettings.key, 'promptLibrary'));
    await db.delete(appSettings).where(eq(appSettings.key, 'promptLibrarySeedVersion'));
    await db.delete(appSettings).where(eq(appSettings.key, 'reviewPrompt'));
  }

  private async seedIfNeeded(): Promise<void> {
    if (this.seedPromise) return this.seedPromise;

    this.seedPromise = (async () => {
      const seedVersion = await promptLibraryKV.get('seedVersion');
      if ((seedVersion ?? 0) >= PROMPT_LIBRARY_SEED_VERSION) {
        await this.deleteLegacyPromptSettings();
        return;
      }

      const existingPrompts = await this.readPrompts();
      const legacyPromptLibrary = promptLibrarySchema.safeParse(
        await this.readLegacyAppSetting('promptLibrary')
      );
      const legacyReviewPrompt = await this.readLegacyAppSetting('reviewPrompt');
      const prompts = [...existingPrompts];
      if (legacyPromptLibrary.success) {
        for (const legacyPrompt of legacyPromptLibrary.data) {
          if (!prompts.some((prompt) => prompt.id === legacyPrompt.id)) {
            prompts.push(legacyPrompt);
          }
        }
      }
      // 不再给新用户塞一条预设(10-07 资源库体检:中文界面里第一屏就是一条英文的「Review prompt」,
      // 空状态那句已经说清这页是干什么的)。老版本里用户**自己改过**的那条 review prompt 仍照搬过来 —— 那是他的内容。
      const legacyReview = typeof legacyReviewPrompt === 'string' && legacyReviewPrompt.trim()
        && !prompts.some((prompt) => prompt.id === 'review-prompt')
        ? [{ id: 'review-prompt', title: 'Review prompt', prompt: legacyReviewPrompt.trim() }]
        : [];
      const nextPrompts = [...legacyReview, ...prompts];

      if (nextPrompts.length > 0) {
        await promptLibraryKV.set('prompts', nextPrompts);
      }
      await promptLibraryKV.set('seedVersion', PROMPT_LIBRARY_SEED_VERSION);
      await this.deleteLegacyPromptSettings();
    })().finally(() => {
      this.seedPromise = null;
    });

    await this.seedPromise;
  }

  async initialize(): Promise<void> {
    await this.seedIfNeeded();
  }

  async getPrompts(): Promise<PromptLibraryPrompt[]> {
    await this.seedIfNeeded();
    return this.readPrompts();
  }

  async updatePrompts(prompts: PromptLibraryPrompt[]): Promise<void> {
    const validated = promptLibrarySchema.parse(prompts);
    await promptLibraryKV.set('prompts', validated);
  }
}

export const promptLibraryService = new PromptLibraryService();
