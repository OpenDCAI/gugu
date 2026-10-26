/** Public builds have product names; development tiers keep their diagnostic names. */
export function deviceVersionLabel(tier: string | undefined, t: (key: string) => string): string {
  return tier === 'production' ? t('devices.versionNames.production')
    : tier === 'beta' ? t('devices.versionNames.beta')
      : tier || t('devices.configurationUnknown')
}
