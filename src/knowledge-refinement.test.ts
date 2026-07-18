import { describe, expect, it } from 'vitest'
import {
  defaultRefinementSelection,
  eligibleRefinementDocuments,
  refinementState,
  toggleAllRefinementSelection,
  type RefinementCandidate,
} from './knowledge-refinement'

const documents: RefinementCandidate[] = [
  { materialId: 'new', status: 'parsed', hash: 'new-hash' },
  { materialId: 'stale', status: 'ocr', hash: 'new-hash', aiProfiles: { original: { sourceHash: 'old-hash' } } },
  { materialId: 'current', status: 'parsed', hash: 'same-hash', ai: { sourceHash: 'same-hash', mode: 'original', analysisMethod: 'original-file' } },
  { materialId: 'legacy', status: 'parsed', hash: 'legacy-hash', ai: { sourceHash: 'legacy-hash', mode: 'deep' } },
  { materialId: 'reference', status: 'parsed', knowledgeRole: 'reference' },
  { materialId: 'unsupported', status: 'unsupported' },
]

describe('批量 AI 精炼资料选择', () => {
  it('允许已精炼资料进入候选列表，但默认只选择未精炼和待更新资料', () => {
    expect(eligibleRefinementDocuments(documents).map((document) => document.materialId)).toEqual(['new', 'stale', 'current', 'legacy'])
    expect(defaultRefinementSelection(documents)).toEqual(['new', 'stale', 'legacy'])
    expect(refinementState(documents[0])).toBe('new')
    expect(refinementState(documents[1])).toBe('stale')
    expect(refinementState(documents[2])).toBe('current')
    expect(refinementState(documents[3])).toBe('new')
  })

  it('全选包含已精炼资料，再次点击会取消全部选择', () => {
    const selected = toggleAllRefinementSelection(documents, ['new'])
    expect(selected).toEqual(['new', 'stale', 'current', 'legacy'])
    expect(toggleAllRefinementSelection(documents, selected)).toEqual([])
  })
})
