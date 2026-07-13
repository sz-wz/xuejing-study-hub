import { describe, expect, it } from 'vitest'
import { buildConceptEvidence, conceptNeedsReview } from './concept-evidence'
import type { ReviewSession } from './review-workspace'

const concept = { id: 'k1', courseIds: ['c1'], sourceIds: ['m1'] }

function session(tests: ReviewSession['quickTests']): ReviewSession {
  return { active: false, materialIds: ['m1'], conceptIds: ['k1'], completedMaterialIds: ['m1'], materialAssessmentAt: { m1: '2026-07-12T10:00:00.000Z' }, startedAt: '2026-07-11T10:00:00.000Z', quickTests: tests }
}

describe('知识点掌握证据', () => {
  it('没有自评和测试时保持未形成证据', () => {
    const evidence = buildConceptEvidence([concept], {}, {})['k1']
    expect(evidence).toMatchObject({ selfRating: 0, status: 'unassessed', latestTestScore: null, testedQuestionCount: 0 })
  })

  it('只使用最近一次明确关联该知识点的测试计算正确率', () => {
    const evidence = buildConceptEvidence([concept], {}, { c1: session([
      { id: 'old', scope: 'current', questionCount: 1, status: 'completed', score: 0, answers: { q1: 1 }, generatedAt: '2026-07-12T12:00:00.000Z', questions: [{ id: 'q1', prompt: '', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: ['k1'] }] },
      { id: 'new', scope: 'current', questionCount: 2, status: 'completed', score: 100, answers: { q1: 0, q2: 1 }, generatedAt: '2026-07-13T12:00:00.000Z', questions: [{ id: 'q1', prompt: '', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: ['k1'] }, { id: 'q2', prompt: '', options: ['A', 'B'], correctIndex: 1, explanation: '', materialIds: ['m1'], conceptIds: ['k1'] }] },
    ]) })['k1']
    expect(evidence).toMatchObject({ latestTestScore: 100, latestTestCorrect: 2, latestTestQuestions: 2, testedQuestionCount: 3, status: 'verified', lastTestAt: '2026-07-13T12:00:00.000Z' })
  })

  it('自评较强但最近测试较弱时标记矛盾，且不修改自评分', () => {
    const evidence = buildConceptEvidence([concept], { k1: 4 }, { c1: session([
      { id: 't', scope: 'current', questionCount: 1, status: 'completed', score: 0, answers: { q: 1 }, generatedAt: '2026-07-13T12:00:00.000Z', questions: [{ id: 'q', prompt: '', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: ['k1'] }] },
    ]) })['k1']
    expect(evidence).toMatchObject({ selfRating: 4, latestTestScore: 0, status: 'conflict', lastReviewedAt: '2026-07-12T10:00:00.000Z' })
    expect(conceptNeedsReview(evidence)).toBe(true)
  })

  it('没有 conceptIds 的题目不会被猜测成知识点证据', () => {
    const evidence = buildConceptEvidence([concept], { k1: 1 }, { c1: session([
      { id: 't', scope: 'current', questionCount: 1, status: 'completed', score: 100, answers: { q: 0 }, generatedAt: '2026-07-13T12:00:00.000Z', questions: [{ id: 'q', prompt: '', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: [] }] },
    ]) })['k1']
    expect(evidence).toMatchObject({ latestTestScore: null, testedQuestionCount: 0, status: 'self_weak' })
  })
})
