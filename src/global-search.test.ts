import { describe, expect, it } from 'vitest'
import { buildGlobalSearchEntries, mergeBodySearchResults, resolveAppShortcut, searchGlobalEntries } from './global-search'

const entries = buildGlobalSearchEntries({
  courses: [{ id: 'c1', code: 'EE150', name: '信号与系统', instructor: '', color: '#000', sources: ['Blackboard'] }],
  materials: [{ id: 'm1', courseId: 'c1', title: 'Lecture 4 Fourier Transform.pdf', type: 'PDF', source: 'Blackboard', meta: '', concepts: ['傅里叶变换'], kind: 'file' }],
  assignments: [], concepts: [{ id: 'k1', title: '傅里叶变换', courseIds: ['c1'], sourceIds: ['m1'] }], reviewSessions: {}, reviewSchedule: [],
  commands: [{ id: 'sync-blackboard', title: '同步 Blackboard', subtitle: '读取课程资料', shortcut: 'Ctrl+Shift+B' }],
})

describe('全局搜索与快捷键', () => {
  it('同时搜索课程、资料、知识点和命令，并支持 > 只搜索命令', () => {
    expect(searchGlobalEntries(entries, '傅里叶').map((entry) => entry.kind)).toEqual(['concept', 'material'])
    expect(searchGlobalEntries(entries, '> 同步').map((entry) => entry.kind)).toEqual(['command'])
  })

  it('正文命中会补充资料结果且不会重复同一资料', () => {
    const local = searchGlobalEntries(entries, 'Lecture')
    const merged = mergeBodySearchResults(local, [{ materialId: 'm1', title: 'Lecture 4 Fourier Transform.pdf', courseId: 'c1', courseName: '信号与系统', snippet: '…controllability matrix…', score: 50 }], entries)
    expect(merged.filter((entry) => entry.materialId === 'm1')).toHaveLength(1)
    expect(merged.find((entry) => entry.materialId === 'm1')?.bodySnippet).toContain('controllability')
  })

  it('输入框中只保留命令中心快捷键，避免导航快捷键破坏输入', () => {
    expect(resolveAppShortcut({ key: 'k', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, true)).toBe('command-center')
    expect(resolveAppShortcut({ key: '2', ctrlKey: true, metaKey: false, shiftKey: false, altKey: false }, true)).toBeNull()
    expect(resolveAppShortcut({ key: 'b', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe('sync-blackboard')
    expect(resolveAppShortcut({ key: 'k', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false })).toBe('build-knowledge')
    expect(resolveAppShortcut({ key: 'p', ctrlKey: true, metaKey: false, shiftKey: false, altKey: true })).toBe('toggle-focus')
  })
})
