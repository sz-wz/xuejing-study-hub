import { describe, expect, it } from 'vitest'
import { recommendedVersionChanges } from './material-version-selection'

describe('资料版本自动启用', () => {
  it('只切换真正版本，不自动处理来源冲突或已是当前版本的资料', () => {
    const result = recommendedVersionChanges([
      { materialId: 'versioned', relation: 'versions', activePath: 'D:\\vault\\old.pdf', recommendedPath: 'D:\\vault\\new.pdf' },
      { materialId: 'conflict', relation: 'source-conflict', activePath: 'D:\\vault\\part2.pdf', recommendedPath: 'D:\\vault\\part3.pdf' },
      { materialId: 'current', relation: 'versions', activePath: 'D:\\Vault\\NEW.pdf', recommendedPath: 'd:/vault/new.pdf' },
    ], new Set())
    expect([...result.replacements]).toEqual([['versioned', 'D:\\vault\\new.pdf']])
    expect(result.signatures).toEqual(['versioned:d:/vault/new.pdf'])
  })

  it('同一推荐版本已尝试时不会重复触发构建', () => {
    const applied = new Set(['versioned:d:/vault/new.pdf'])
    const result = recommendedVersionChanges([
      { materialId: 'versioned', relation: 'versions', activePath: 'D:\\vault\\old.pdf', recommendedPath: 'D:\\vault\\new.pdf' },
    ], applied)
    expect(result.replacements.size).toBe(0)
    expect(result.signatures).toEqual([])
  })
})
