/**
 * 位置与设备状态(location.get / location.geocode / battery.get),经原生助手(Location.swift / System.swift)。
 * 定位授权:macOS 不一定给命令行的原生助手弹授权框 —— 「连接」后状态还是「没决定」就如实说没连上、告诉人去哪打开,
 * ❌ 当成连上(连上了却一调就 os_permission,比连不上更糟)。电池不要授权,一点就连上。
 */
import { MAC_PRIVACY, fail, num, ok, type ActionDef, type ActionFamily, type Args, type FamilyContext, type Outcome } from '../catalog'

const LOCATION_SETTINGS = MAC_PRIVACY('Privacy_LocationServices')

async function connectLocation(ctx: FamilyContext): Promise<Outcome> {
  const r = await ctx.deps.macHelper().call<{ status: string }>('permissions.request', { kind: 'location' }, { signal: ctx.signal, timeoutMs: 120_000 })
  switch (r.status) {
    case 'granted':
      return ok(null)
    case 'services_off':
      return fail('os_permission', '这台 Mac 的「定位服务」总开关是关的：去 系统设置 → 隐私与安全性 → 定位服务 把它打开、并允许咕咕，再点一次「连接」')
    case 'not_determined':
      return fail('os_permission', 'macOS 没有给出答复（可能根本没弹出定位授权框）。如果这台电脑上弹了窗，点「允许」后再点一次「连接」；没看到弹窗的话，去 系统设置 → 隐私与安全性 → 定位服务，找到咕咕并打开，再点一次「连接」')
    default:
      return fail('os_permission', 'macOS 没允许咕咕使用定位：去 系统设置 → 隐私与安全性 → 定位服务 里打开咕咕，再点一次「连接」')
  }
}

const coordinateProblem = (args: Args): string | null => {
  const lat = num(args, 'latitude')
  const lon = num(args, 'longitude')
  if (lat === undefined || lon === undefined) return 'latitude and longitude are required numbers (WGS-84 degrees)'
  if (lat < -90 || lat > 90) return `latitude must be within [-90, 90], got ${lat}`
  if (lon < -180 || lon > 180) return `longitude must be within [-180, 180], got ${lon}`
  return null
}

const ADDRESS_FIELDS = 'name, street, sub_locality, locality (city), administrative_area (state/province), postal_code, country, country_code, formatted, time_zone'

const locationGet: ActionDef = {
  name: 'location.get',
  group: 'location',
  title: '获取当前位置',
  titleEn: 'Get location',
  description: `Where this Mac is right now (Location Services; Wi-Fi based, so accuracy is typically tens to hundreds of meters). Takes up to ~25 s. Returns latitude, longitude, accuracy_m, altitude_m (when known), timestamp (local ISO), and address: the reverse-geocoded place (${ADDRESS_FIELDS}) — address is null with address_error when the lookup failed (it needs the internet); the coordinates are still valid.`,
  risk: 'medium',
  confirm: 'never',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, ctx) {
    ctx.note('正在定位…')
    return ok(await ctx.deps.macHelper().call('location.get', {}, { signal: ctx.signal, timeoutMs: 45_000 }))
  },
}

const locationGeocode: ActionDef = {
  name: 'location.geocode',
  group: 'location',
  title: '坐标查地址',
  titleEn: 'Reverse geocode',
  description: `Turn coordinates into an address (reverse geocoding via Apple; needs the internet, not this Mac's location). Pass latitude [-90, 90] and longitude [-180, 180] in WGS-84 degrees. Returns found plus ${ADDRESS_FIELDS}; found: false when there is no address there (e.g. open sea).`,
  risk: 'low',
  confirm: 'never',
  input_schema: {
    type: 'object',
    required: ['latitude', 'longitude'],
    properties: {
      latitude: { type: 'number', minimum: -90, maximum: 90, description: 'WGS-84 latitude in degrees' },
      longitude: { type: 'number', minimum: -180, maximum: 180, description: 'WGS-84 longitude in degrees' },
    },
    additionalProperties: false,
  },
  validate: coordinateProblem,
  async run(args, ctx) {
    return ok(await ctx.deps.macHelper().call('location.geocode', { latitude: num(args, 'latitude'), longitude: num(args, 'longitude') }, { signal: ctx.signal, timeoutMs: 30_000 }))
  },
}

/** 原生助手 battery.status 回的样子(System.swift)。 */
interface BatteryStatus {
  has_battery: boolean
  batteries: Array<{
    name: string
    percent: number | null
    charging: boolean
    charged: boolean
    power_source: string
    minutes_to_empty?: number
    minutes_to_full?: number
    health?: string
  }>
  providing_power_source: string
  low_power_mode: boolean
  thermal_state: string
}

/** IOKit 的电源名(kIOPSACPowerValue …)→ 短词。 */
const POWER_SOURCE: Record<string, string> = { 'AC Power': 'ac', 'Battery Power': 'battery', 'UPS Power': 'ups' }

function batteryResult(s: BatteryStatus) {
  const power = POWER_SOURCE[s.providing_power_source] ?? (s.providing_power_source || null)
  const common = { power_source: power, low_power_mode: s.low_power_mode, thermal_state: s.thermal_state }
  const b = s.batteries[0]
  if (!s.has_battery || !b) {
    return { has_battery: false, ...common, note: 'This Mac has no battery (a desktop Mac); it runs on mains power.' }
  }
  const state = b.charging ? 'charging' : power === 'battery' ? 'on_battery' : b.charged ? 'charged' : 'plugged_in'
  return {
    has_battery: true,
    percent: b.percent,
    state,
    charging: b.charging,
    minutes_to_empty: b.minutes_to_empty ?? null,
    minutes_to_full: b.minutes_to_full ?? null,
    ...(b.health ? { health: b.health } : {}),
    ...common,
  }
}

const batteryGet: ActionDef = {
  name: 'battery.get',
  group: 'device',
  title: '查电量',
  titleEn: 'Battery status',
  description: 'Battery and power state of this Mac: has_battery, percent (0-100), state (charging / plugged_in / charged / on_battery), minutes_to_empty / minutes_to_full (null while macOS is still estimating), health, power_source (ac / battery), low_power_mode, thermal_state (nominal / fair / serious / critical). A desktop Mac returns has_battery: false.',
  risk: 'low',
  confirm: 'never',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  async run(_args, ctx) {
    const status = await ctx.deps.macHelper().call<BatteryStatus>('battery.status', {}, { signal: ctx.signal, timeoutMs: 15_000 })
    return ok(batteryResult(status))
  },
}

export function createDeviceFamily(): ActionFamily {
  return {
    groups: [
      {
        id: 'location',
        platforms: ['darwin'],
        needs: 'macHelper',
        iconApp: '/System/Applications/Maps.app',
        settingsUrl: LOCATION_SETTINGS,
        osPermission: '系统设置 → 隐私与安全性 → 定位服务 → 打开咕咕',
        probe: connectLocation,
      },
      { id: 'device', platforms: ['darwin'], needs: 'macHelper', iconApp: '/System/Applications/System Settings.app' },
    ],
    actions: [locationGet, locationGeocode, batteryGet],
  }
}
