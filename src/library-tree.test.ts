import { describe, expect, it } from 'vitest'
import { isFolderExpanded, toggledFolders } from './library-tree'

describe('资料树折叠状态', () => {
  it('一级文件夹初始可折叠，并在两次点击后恢复收起', () => {
    const path = 'Notes'
    const initial = new Set<string>()
    const opened = toggledFolders(initial, path)
    const closed = toggledFolders(opened, path)

    expect(isFolderExpanded(initial, path)).toBe(false)
    expect(isFolderExpanded(opened, path)).toBe(true)
    expect(isFolderExpanded(closed, path)).toBe(false)
  })
})
