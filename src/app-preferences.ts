import { DEFAULT_SHORTCUT_PREFERENCES, normalizeShortcutPreferences, type ShortcutPreferences } from './shortcut-preferences'
import { DEFAULT_AUTO_SYNC_PREFERENCES, normalizeAutoSyncPreferences, type AutoSyncPreferences } from './background-sync'

export type ThemePreference = 'light' | 'dark' | 'glass' | 'system'
export type CelebrationMode = 'full' | 'light' | 'off'

export type AppPreferences = {
  theme: ThemePreference
  motionEnabled: boolean
  launchAnimationEnabled: boolean
  celebrationMode: CelebrationMode
  focusMinutes: number
  breakMinutes: number
  reviewQueueLimit: number
  reviewRemindersEnabled: boolean
  uiScale: number
  shortcuts: ShortcutPreferences
  autoSync: AutoSyncPreferences
}

export const DEFAULT_APP_PREFERENCES: AppPreferences = {
  theme: 'light',
  motionEnabled: true,
  launchAnimationEnabled: true,
  celebrationMode: 'full',
  focusMinutes: 25,
  breakMinutes: 5,
  reviewQueueLimit: 6,
  reviewRemindersEnabled: true,
  uiScale: 1,
  shortcuts: DEFAULT_SHORTCUT_PREFERENCES,
  autoSync: DEFAULT_AUTO_SYNC_PREFERENCES,
}

function boundedMinutes(value: unknown, fallback: number, minimum: number, maximum: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : fallback
}

export function normalizeAppPreferences(value: unknown): AppPreferences {
  if (!value || typeof value !== 'object') return DEFAULT_APP_PREFERENCES
  const source = value as Partial<AppPreferences>
  const theme = ['light', 'dark', 'glass', 'system'].includes(source.theme ?? '')
    ? source.theme as ThemePreference
    : DEFAULT_APP_PREFERENCES.theme
  return {
    theme,
    motionEnabled: typeof source.motionEnabled === 'boolean' ? source.motionEnabled : true,
    launchAnimationEnabled: typeof source.launchAnimationEnabled === 'boolean' ? source.launchAnimationEnabled : true,
    celebrationMode: ['full', 'light', 'off'].includes(source.celebrationMode ?? '') ? source.celebrationMode as CelebrationMode : 'full',
    focusMinutes: boundedMinutes(source.focusMinutes, 25, 5, 120),
    breakMinutes: boundedMinutes(source.breakMinutes, 5, 1, 30),
    reviewQueueLimit: boundedMinutes(source.reviewQueueLimit, 6, 3, 12),
    reviewRemindersEnabled: typeof source.reviewRemindersEnabled === 'boolean' ? source.reviewRemindersEnabled : true,
    uiScale: typeof source.uiScale === 'number' && Number.isFinite(source.uiScale) ? Math.min(1.4, Math.max(.9, Math.round(source.uiScale * 20) / 20)) : 1,
    shortcuts: normalizeShortcutPreferences(source.shortcuts),
    autoSync: normalizeAutoSyncPreferences(source.autoSync),
  }
}

export function resolveTheme(theme: ThemePreference, systemDark: boolean): Exclude<ThemePreference, 'system'> {
  return theme === 'system' ? (systemDark ? 'dark' : 'light') : theme
}
