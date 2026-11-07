/** Public directory fields contain no account or authorization data. */
export type IntegrationCatalogMetadata = {
  categoryId: string;
  aliases?: readonly string[];
};

/** Older or third-party hosts may omit these optional public fields. */
export function readIntegrationCatalogMetadata(value: unknown) {
  if (!value || typeof value !== 'object' || !('categoryId' in value) || typeof value.categoryId !== 'string') return undefined;
  const aliases = 'aliases' in value && Array.isArray(value.aliases) ? value.aliases.filter((alias): alias is string => typeof alias === 'string') : undefined;
  return { categoryId: value.categoryId, ...(aliases ? { aliases } : {}) };
}
