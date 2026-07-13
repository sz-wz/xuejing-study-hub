import { describe, expect, it } from 'vitest'
import { buildCourseGrowthMetrics, buildGrowthActivity, visibleCourseMetrics } from './growth-metrics'

describe('growth metrics', () => {
  it('默认只展示四门课程，展开后返回全部课程', () => {
    const courses = ['a', 'b', 'c', 'd', 'e', 'f']
    expect(visibleCourseMetrics(courses, false)).toEqual(['a', 'b', 'c', 'd'])
    expect(visibleCourseMetrics(courses, true)).toEqual(courses)
  })

  it('separates contact, understanding confirmation, and test verification by course', () => {
    const metrics = buildCourseGrowthMetrics(
      [
        { materialId: 'm1', courseId: 'c1', courseName: '信号与系统', status: 'parsed' },
        { materialId: 'm2', courseId: 'c1', courseName: '信号与系统', status: 'ocr' },
        { materialId: 'm3', courseId: 'c1', courseName: '信号与系统', status: 'failed' },
      ],
      [{ id: 'k1', courseIds: ['c1'], sourceIds: ['m1'] }, { id: 'k2', courseIds: ['c1'], sourceIds: ['m2'] }],
      { k1: 1, k2: 4 },
      { c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], materialAssessments: { m1: 3, m2: 2 }, materialAssessmentAt: { m1: '2026-07-12T12:00:00.000Z', m2: '2026-07-13T12:00:00.000Z' }, startedAt: '2026-07-11T12:00:00.000Z', quickTests: [{ id: 't', scope: 'session', questionCount: 1, status: 'completed', score: 0, answers: { q: 1 }, generatedAt: '2026-07-13T12:00:00.000Z', questions: [{ id: 'q', prompt: '', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: ['k1'] }] }] } },
    )
    expect(metrics[0]).toMatchObject({ totalMaterials: 2, contactedMaterials: 2, confirmedMaterials: 2, understoodMaterials: 1, verifiedMaterials: 1, averageTestScore: 0, weakMaterialIds: ['m1', 'm2'], ratedConcepts: 2, weakConcepts: 1, testedConcepts: 1, verifiedConcepts: 0, testWeakConcepts: 1, evidenceConflicts: 0, weakConceptIds: ['k1'] })
  })

  it('builds an honest daily activity series from recorded timestamps only', () => {
    const activity = buildGrowthActivity({ c1: { active: false, materialIds: ['m1', 'm2'], conceptIds: [], completedMaterialIds: [], materialAssessmentAt: { m1: '2026-07-12T12:00:00.000Z' }, startedAt: '2026-07-11T12:00:00.000Z', quickTests: [{ id: 't', scope: 'session', questionCount: 0, status: 'completed', score: 100, answers: {}, generatedAt: '2026-07-13T12:00:00.000Z', questions: [] }] } }, 3, new Date('2026-07-13T12:00:00.000Z'))
    expect(activity.map((day) => ({ date: day.date, contacts: day.contacts, confirmations: day.confirmations, tests: day.tests }))).toEqual([
      { date: '2026-07-11', contacts: 2, confirmations: 0, tests: 0 },
      { date: '2026-07-12', contacts: 0, confirmations: 1, tests: 0 },
      { date: '2026-07-13', contacts: 0, confirmations: 0, tests: 1 },
    ])
  })

  it('uses the newest evidence per material when deciding current weakness', () => {
    const documents = [{ materialId: 'm1', courseId: 'c1', courseName: '课程', status: 'parsed' }]
    const olderFailure = { id: 't', scope: 'current' as const, questionCount: 1, status: 'completed' as const, score: 0, answers: { q: 1 }, generatedAt: '2026-07-12T12:00:00.000Z', questions: [{ id: 'q', prompt: '', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: [] }] }
    expect(buildCourseGrowthMetrics(documents, [], {}, { c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], materialAssessments: { m1: 3 }, materialAssessmentAt: { m1: '2026-07-13T12:00:00.000Z' }, startedAt: '', quickTests: [olderFailure] } })[0].weakMaterialIds).toEqual([])
  })
})
