import { describe, expect, it } from 'vitest'
import { buildKnowledgeMap, prioritizeMapConcepts, type MapConcept, type MapDocument } from './knowledge-map'

const documents: MapDocument[] = [
  { materialId: 'm1', courseId: 'c1', courseName: '信号与系统', title: 'Lecture 1', status: 'parsed' },
  { materialId: 'm2', courseId: 'c2', courseName: '算法', title: 'Lecture 1', status: 'parsed' },
]

describe('layered knowledge map', () => {
  it('shows only course entrances in the all-course overview', () => {
    const concepts: MapConcept[] = Array.from({ length: 100 }, (_, index) => ({ id: `k${index}`, title: `主题 ${index}`, sourceIds: ['m1'], courseIds: ['c1'] }))
    const data = buildKnowledgeMap(documents, concepts, null, true)
    expect(data.nodes).toHaveLength(2)
    expect(data.nodes.every((node) => node.kind === 'course')).toBe(true)
    expect(data.edges).toHaveLength(0)
  })

  it('prioritizes weak concepts before unrated and mastered concepts', () => {
    const concepts: MapConcept[] = [
      { id: 'mastered', title: '掌握', sourceIds: ['m1'], courseIds: ['c1'] },
      { id: 'unrated', title: '未评估', sourceIds: ['m1'], courseIds: ['c1'] },
      { id: 'weak', title: '陌生', sourceIds: ['m1'], courseIds: ['c1'] },
    ]
    expect(prioritizeMapConcepts(concepts, { mastered: 4, weak: 1 }).map((concept) => concept.id)).toEqual(['weak', 'unrated', 'mastered'])
  })

  it('prioritizes evidence conflicts and test weakness when evidence is available', () => {
    const concepts: MapConcept[] = [
      { id: 'verified', title: '已验证', sourceIds: ['m1'], courseIds: ['c1'] },
      { id: 'conflict', title: '矛盾', sourceIds: ['m1'], courseIds: ['c1'] },
      { id: 'test-weak', title: '测试薄弱', sourceIds: ['m1'], courseIds: ['c1'] },
    ]
    const base = { selfRating: 0 as const, latestTestScore: 100, latestTestCorrect: 1, latestTestQuestions: 1, testedQuestionCount: 1, lastTestAt: '2026-07-13T12:00:00.000Z', lastReviewedAt: null, sourceMaterialIds: ['m1'] }
    const evidence = {
      verified: { ...base, conceptId: 'verified', status: 'verified' as const },
      conflict: { ...base, conceptId: 'conflict', status: 'conflict' as const },
      'test-weak': { ...base, conceptId: 'test-weak', latestTestScore: 0, status: 'test_weak' as const },
    }
    expect(prioritizeMapConcepts(concepts, {}, evidence).map((concept) => concept.id)).toEqual(['conflict', 'test-weak', 'verified'])
  })
})
