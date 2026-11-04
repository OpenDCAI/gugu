import { checkPhoneIntl } from './intl-smoke.mjs'

console.log(JSON.stringify({ node: process.version, icu: process.versions.icu, platform: process.platform, arch: process.arch, locales: checkPhoneIntl() }))
