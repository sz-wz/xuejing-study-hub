import type { ReviewSession } from './review-workspace'

export type ConceptRating = 0 | 1 | 2 | 3 | 4
export type ConceptEvidenceStatus = 'unassessed' | 'self_weak' | 'test_weak' | 'conflict' | 'verified' | 'developing'
export type EvidenceConcept = { id: string; courseIds: string[]; sourceIds: string[] }

export type ConceptEvidence = {
  conceptId: string
  selfRating: ConceptRating
  status: ConceptEvidenceStatus
  latestTestScore: number | null
  latestTestCorrect: number
  latestTestQuestions: number
  testedQuestionCount: number
  lastTestAt: string | null
  lastReviewedAt: string | null
  sourceMaterialIds: string[]
}

export const conceptEvidenceLabels: Record<ConceptEvidenceStatus, string> = {
  unassessed: '未形成证据',
  self_weak: '自评薄弱',
  test_weak: '测试薄弱',
  conflict: '自评与测试不一致',
  verified: '测试验证较好',
  developing: '证据积累中',
}

function newest(values: (string | undefined | null)[]) {
  return values.filter((value): value is string => Boolean(value)).sort((left, right) => right.localeCompare(left))[0] ?? null
}

function statusFor(selfRating: ConceptRating, latestTestScore: number | null): ConceptEvidenceStatus {
  const selfWeak = selfRating === 1 || selfRating === 2
  const selfStrong = selfRating === 3 || selfRating === 4
  const testWeak = latestTestScore !== null && latestTestScore < 70
  const testStrong = latestTestScore !== null && latestTestScore >= 80
  if ((selfStrong && testWeak) || (selfWeak && testStrong)) return 'conflict'
  if (testWeak) return 'test_weak'
  if (selfWeak) return 'self_weak'
  if (testStrong) return 'verified'
  if (selfRating === 0 && latestTestScore === null) return 'unassessed'
  return 'developing'
}

export function buildConceptEvidence(concepts: EvidenceConcept[], ratings: Record<string, ConceptRating>, sessions: Record<string, ReviewSession>) {
  return Object.fromEntries(concepts.map((concept) => {
    const courseSessions = concept.courseIds.flatMap((courseId) => sessions[courseId] ? [sessions[courseId]] : [])
    const completedTests = courseSessions.flatMap((session) => session.quickTests ?? []).filter((test) => test.status === 'completed')
    const relevantTests = completedTests.filter((test) => test.questions.some((question) => question.conceptIds.includes(concept.id))).sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))
    const latestTest = relevantTests[0]
    const latestQuestions = latestTest?.questions.filter((question) => question.conceptIds.includes(concept.id)) ?? []
    const latestCorrect = latestTest ? latestQuestions.filter((question) => latestTest.answers[question.id] === question.correctIndex).length : 0
    const latestTestScore = latestQuestions.length ? Math.round(latestCorrect / latestQuestions.length * 100) : null
    const testedQuestionCount = relevantTests.reduce((sum, test) => sum + test.questions.filter((question) => question.conceptIds.includes(concept.id)).length, 0)
    const reviewTimestamps = courseSessions.flatMap((session) => {
      const directlySelected = session.conceptIds.includes(concept.id)
      const usedSource = session.materialIds.some((materialId) => concept.sourceIds.includes(materialId))
      const assessmentTimes = concept.sourceIds.map((materialId) => session.materialAssessmentAt?.[materialId])
      return [...(directlySelected || usedSource ? [session.startedAt] : []), ...assessmentTimes]
    })
    const selfRating = ratings[concept.id] ?? 0
    const evidence: ConceptEvidence = {
      conceptId: concept.id,
      selfRating,
      status: statusFor(selfRating, latestTestScore),
      latestTestScore,
      latestTestCorrect: latestCorrect,
      latestTestQuestions: latestQuestions.length,
      testedQuestionCount,
      lastTestAt: latestTest?.generatedAt ?? null,
      lastReviewedAt: newest(reviewTimestamps),
      sourceMaterialIds: [...concept.sourceIds],
    }
    return [concept.id, evidence]
  })) as Record<string, ConceptEvidence>
}

export function conceptNeedsReview(evidence: ConceptEvidence) {
  return evidence.status === 'self_weak' || evidence.status === 'test_weak' || evidence.status === 'conflict'
}
