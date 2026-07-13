export type ShortcutBinding = { enabled: boolean; accelerator: string }
export type ShortcutPreferences = Record<string, ShortcutBinding>

export type ShortcutDefinition = {
  id: string
  actionId: string
  label: string
  description: string
  defaultAccelerator: string
}

export const SHORTCUT_DEFINITIONS: ShortcutDefinition[] = [
  { id: 'command-center', actionId: 'command-center', label: '全局搜索与快捷操作', description: '主要唤起方式', defaultAccelerator: 'Ctrl+K' },
  { id: 'command-center-alt', actionId: 'command-center', label: '全局搜索与快捷操作', description: '备用唤起方式', defaultAccelerator: 'Ctrl+Shift+P' },
  ...Array.from({ length: 9 }, (_, index) => ({ id: `nav-${index + 1}`, actionId: `nav-${index + 1}`, label: ['学习总览', '课程资料', '作业中心', '知识库', '知识图谱', '期末复习', '复习日程', '专注计时', '成长日记'][index], description: '页面导航', defaultAccelerator: `Ctrl+${index + 1}` })),
  { id: 'nav-0', actionId: 'nav-0', label: '设置中心', description: '页面导航', defaultAccelerator: 'Ctrl+0' },
  { id: 'nav-settings', actionId: 'nav-settings', label: '设置中心', description: '备用入口', defaultAccelerator: 'Ctrl+Comma' },
  { id: 'sync-blackboard', actionId: 'sync-blackboard', label: '同步 Blackboard', description: '连接或同步课程资料', defaultAccelerator: 'Ctrl+Shift+B' },
  { id: 'sync-gradescope', actionId: 'sync-gradescope', label: '同步 Gradescope', description: '连接或同步作业状态', defaultAccelerator: 'Ctrl+Shift+G' },
  { id: 'import-materials', actionId: 'import-materials', label: '导入本地资料', description: '打开资料导入窗口', defaultAccelerator: 'Ctrl+Shift+I' },
  { id: 'build-knowledge', actionId: 'build-knowledge', label: '构建 / 更新知识库', description: '解析本地课程资料', defaultAccelerator: 'Ctrl+Shift+K' },
  { id: 'toggle-focus', actionId: 'toggle-focus', label: '开始 / 暂停番茄钟', description: '控制当前专注计时', defaultAccelerator: 'Ctrl+Alt+P' },
  { id: 'add-assignment', actionId: 'add-assignment', label: '手动添加作业', description: '添加其他来源作业', defaultAccelerator: 'Ctrl+Alt+A' },
]

export const DEFAULT_SHORTCUT_PREFERENCES: ShortcutPreferences = Object.fromEntries(SHORTCUT_DEFINITIONS.map((definition) => [definition.id, { enabled: true, accelerator: definition.defaultAccelerator }]))

const keyAliases: Record<string, string> = {
  ',': 'Comma', '.': 'Period', '/': 'Slash', ';': 'Semicolon', "'": 'Quote', '[': 'BracketLeft', ']': 'BracketRight', '\\': 'Backslash', '-': 'Minus', '=': 'Equal', '`': 'Backquote', ' ': 'Space',
}
const displayAliases: Record<string, string> = { Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`', Space: 'Space' }

function normalizedKey(value: string) {
  const key = keyAliases[value] ?? value
  if (/^[a-z]$/i.test(key)) return key.toUpperCase()
  if (/^[0-9]$/.test(key) || /^F(?:[1-9]|1[0-2])$/.test(key)) return key.toUpperCase()
  return Object.hasOwn(displayAliases, key) ? key : ''
}

export function parseAccelerator(value: unknown) {
  if (typeof value !== 'string') return null
  const parts = value.split('+').map((part) => part.trim()).filter(Boolean)
  const modifiers = new Set(parts.slice(0, -1).map((part) => part.toLocaleLowerCase()))
  const key = normalizedKey(parts.at(-1) ?? '')
  if (!key || (!modifiers.has('ctrl') && !modifiers.has('alt') && !modifiers.has('meta'))) return null
  if ([...modifiers].some((modifier) => !['ctrl', 'alt', 'shift', 'meta'].includes(modifier))) return null
  return `${modifiers.has('ctrl') ? 'Ctrl+' : ''}${modifiers.has('alt') ? 'Alt+' : ''}${modifiers.has('shift') ? 'Shift+' : ''}${modifiers.has('meta') ? 'Meta+' : ''}${key}`
}

export function acceleratorFromEvent(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null
  const key = normalizedKey(event.key)
  if (!key || (!event.ctrlKey && !event.altKey && !event.metaKey)) return null
  return `${event.ctrlKey ? 'Ctrl+' : ''}${event.altKey ? 'Alt+' : ''}${event.shiftKey ? 'Shift+' : ''}${event.metaKey ? 'Meta+' : ''}${key}`
}

export function displayAccelerator(accelerator: string) {
  const parsed = parseAccelerator(accelerator)
  if (!parsed) return '未设置'
  const parts = parsed.split('+')
  const key = parts.pop()!
  return [...parts, displayAliases[key] ?? key].join('+')
}

export function normalizeShortcutPreferences(value: unknown): ShortcutPreferences {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const result: ShortcutPreferences = {}
  const used = new Set<string>()
  for (const definition of SHORTCUT_DEFINITIONS) {
    const stored = source[definition.id] && typeof source[definition.id] === 'object' ? source[definition.id] as Partial<ShortcutBinding> : {}
    const accelerator = parseAccelerator(stored.accelerator) ?? definition.defaultAccelerator
    const requestedEnabled = typeof stored.enabled === 'boolean' ? stored.enabled : true
    const enabled = requestedEnabled && !used.has(accelerator)
    result[definition.id] = { enabled, accelerator }
    if (enabled) used.add(accelerator)
  }
  return result
}

export function shortcutConflict(preferences: ShortcutPreferences, bindingId: string, accelerator: string) {
  const parsed = parseAccelerator(accelerator)
  if (!parsed) return null
  const conflictId = SHORTCUT_DEFINITIONS.find((definition) => definition.id !== bindingId && preferences[definition.id]?.enabled && preferences[definition.id]?.accelerator === parsed)?.id
  return conflictId ? SHORTCUT_DEFINITIONS.find((definition) => definition.id === conflictId) ?? null : null
}

function acceleratorMatches(accelerator: string, event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>) {
  return acceleratorFromEvent(event) === parseAccelerator(accelerator)
}

export function resolveConfiguredShortcut(preferences: ShortcutPreferences, event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, typing = false) {
  for (const definition of SHORTCUT_DEFINITIONS) {
    const binding = preferences[definition.id]
    if (!binding?.enabled || !acceleratorMatches(binding.accelerator, event)) continue
    if (typing && definition.actionId !== 'command-center') return null
    return definition.actionId
  }
  return null
}

export function shortcutForAction(preferences: ShortcutPreferences, actionId: string) {
  const definition = SHORTCUT_DEFINITIONS.find((item) => item.actionId === actionId && preferences[item.id]?.enabled)
  return definition ? displayAccelerator(preferences[definition.id].accelerator) : undefined
}
