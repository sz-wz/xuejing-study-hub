import { describe, expect, it } from 'vitest'
import { normalizeAppPreferences, resolveTheme } from './app-preferences'

describe('app preferences', () => {
  it('repairs invalid persisted values without disabling user-facing defaults', () => {
    expect(normalizeAppPreferences({ theme: 'neon', motionEnabled: 'no', launchAnimationEnabled: false })).toMatchObject({
      theme: 'light',
      motionEnabled: true,
      launchAnimationEnabled: false,
      focusMinutes: 25,
      breakMinutes: 5,
      reviewQueueLimit: 6,
      reviewRemindersEnabled: true,
      uiScale: 1,
    })
    expect(normalizeAppPreferences({}).shortcuts['command-center']).toEqual({ enabled: true, accelerator: 'Ctrl+K' })
    expect(normalizeAppPreferences({}).autoSync).toMatchObject({ enabled: false, intervalMinutes: 60, syncOnLaunch: true })
  })

  it('bounds pomodoro durations to practical values', () => {
    expect(normalizeAppPreferences({ focusMinutes: 500, breakMinutes: 0 })).toMatchObject({ focusMinutes: 120, breakMinutes: 1 })
  })

  it('bounds the daily review queue and preserves the reminder switch', () => {
    expect(normalizeAppPreferences({ reviewQueueLimit: 99, reviewRemindersEnabled: false })).toMatchObject({ reviewQueueLimit: 12, reviewRemindersEnabled: false })
    expect(normalizeAppPreferences({ reviewQueueLimit: 0 })).toMatchObject({ reviewQueueLimit: 3, reviewRemindersEnabled: true })
  })

  it('normalizes UI scale for high-resolution displays', () => {
    expect(normalizeAppPreferences({ uiScale: 2 })).toMatchObject({ uiScale: 1.4 })
    expect(normalizeAppPreferences({ uiScale: .5 })).toMatchObject({ uiScale: .9 })
    expect(normalizeAppPreferences({ uiScale: 1.13 })).toMatchObject({ uiScale: 1.15 })
  })

  it('resolves system theme while preserving explicit choices', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('glass', true)).toBe('glass')
  })
})
