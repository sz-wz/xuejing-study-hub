import { describe, expect, it } from 'vitest'
import { DEFAULT_SHORTCUT_PREFERENCES, acceleratorFromEvent, displayAccelerator, normalizeShortcutPreferences, resolveConfiguredShortcut, shortcutConflict } from './shortcut-preferences'

describe('自定义快捷键', () => {
  it('兼容旧设置并修复无效组合', () => {
    const normalized = normalizeShortcutPreferences({ 'command-center': { enabled: false, accelerator: 'K' }, 'nav-1': { enabled: true, accelerator: 'Ctrl+Alt+H' } })
    expect(normalized['command-center']).toEqual({ enabled: false, accelerator: 'Ctrl+K' })
    expect(normalized['nav-1']).toEqual({ enabled: true, accelerator: 'Ctrl+Alt+H' })
  })

  it('从键盘事件录制规范组合并格式化标点键', () => {
    expect(acceleratorFromEvent({ key: ',', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBe('Ctrl+Comma')
    expect(displayAccelerator('Ctrl+Comma')).toBe('Ctrl+,')
    expect(acceleratorFromEvent({ key: 'a', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false })).toBeNull()
  })

  it('检测启用快捷键冲突并允许禁用单项', () => {
    const preferences = normalizeShortcutPreferences(DEFAULT_SHORTCUT_PREFERENCES)
    expect(shortcutConflict(preferences, 'nav-1', 'Ctrl+K')?.id).toBe('command-center')
    preferences['command-center'].enabled = false
    expect(shortcutConflict(preferences, 'nav-1', 'Ctrl+K')).toBeNull()
  })

  it('运行时使用用户绑定，输入框只允许命令中心动作', () => {
    const preferences = normalizeShortcutPreferences({ ...DEFAULT_SHORTCUT_PREFERENCES, 'nav-2': { enabled: true, accelerator: 'Ctrl+Alt+L' } })
    const event = { key: 'l', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false }
    expect(resolveConfiguredShortcut(preferences, event)).toBe('nav-2')
    expect(resolveConfiguredShortcut(preferences, event, true)).toBeNull()
    preferences['nav-2'].enabled = false
    expect(resolveConfiguredShortcut(preferences, event)).toBeNull()
  })

  it('修改绑定后旧组合立即失效，新组合立即生效', () => {
    const preferences = normalizeShortcutPreferences({
      ...DEFAULT_SHORTCUT_PREFERENCES,
      'nav-3': { enabled: true, accelerator: 'Ctrl+Alt+W' },
    })
    expect(resolveConfiguredShortcut(preferences, { key: '3', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBeNull()
    expect(resolveConfiguredShortcut(preferences, { key: 'w', ctrlKey: true, altKey: true, shiftKey: false, metaKey: false })).toBe('nav-3')
  })

  it('持久化配置中出现重复启用组合时只保留前一项', () => {
    const preferences = normalizeShortcutPreferences({
      'command-center': { enabled: true, accelerator: 'Ctrl+K' },
      'nav-1': { enabled: true, accelerator: 'Ctrl+K' },
    })
    expect(preferences['command-center'].enabled).toBe(true)
    expect(preferences['nav-1']).toEqual({ enabled: false, accelerator: 'Ctrl+K' })
  })

  it('两个命令中心绑定都关闭时不会再响应键盘入口', () => {
    const preferences = normalizeShortcutPreferences({
      ...DEFAULT_SHORTCUT_PREFERENCES,
      'command-center': { enabled: false, accelerator: 'Ctrl+K' },
      'command-center-alt': { enabled: false, accelerator: 'Ctrl+Shift+P' },
    })
    expect(resolveConfiguredShortcut(preferences, { key: 'k', ctrlKey: true, altKey: false, shiftKey: false, metaKey: false })).toBeNull()
    expect(resolveConfiguredShortcut(preferences, { key: 'p', ctrlKey: true, altKey: false, shiftKey: true, metaKey: false })).toBeNull()
  })
})
