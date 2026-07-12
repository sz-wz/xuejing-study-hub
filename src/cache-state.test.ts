import { describe, expect, it } from 'vitest'
import { applyCachedItems } from './cache-state'
import type { Material } from './types'

describe('applyCachedItems', () => {
  it('用稳定资料 ID 回写自动缓存结果，不依赖 URL 形式一致', () => {
    const materials: Material[] = [{ id: 'bb-file-1', courseId: 'ee291e', title: 'lecture', type: '文件', source: 'Blackboard', meta: '', concepts: [], url: 'https://example.edu/file?x=1', kind: 'file' }]
    const result = applyCachedItems(materials, [{ clientId: 'bb-file-1', url: 'https://example.edu/file?x=1&redirected=1', item: { title: 'lecture.pdf', type: 'PDF', localPath: 'D:\\knowledge\\lecture.pdf', meta: '已缓存' } }])

    expect(result[0]).toMatchObject({ title: 'lecture.pdf', type: 'PDF', localPath: 'D:\\knowledge\\lecture.pdf' })
  })
})
