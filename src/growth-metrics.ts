import type { ReviewSession } from './review-workspace'
import { buildConceptEvidence, conceptNeedsReview } from './concept-evidence'

export type GrowthDocument = { materialId: string; courseId: string; courseName: string; status: string }
export type GrowthConcept = { id: string; courseIds: string[]; sourceIds?: string[] }
export type GrowthRating = 0 | 1 | 2 | 3 | 4

export type CourseGrowthMetric = {
  courseId: string
  courseName: string
  totalMaterials: number
  contactedMaterials: number
  confirmedMaterials: number
  understoodMaterials: number
  verifiedMaterials: number
  averageTestScore: number | null
  weakMaterialIds: string[]
  ratedConcepts: number
  weakConcepts: number
  testedConcepts: number
  verifiedConcepts: number
  testWeakConcepts: number
  evidenceConflicts: number
  weakConceptIds: string[]
}

export type GrowthActivityDay = {
  date: string
  label: string
  contacts: number
  confirmations: number
  tests: number
  total: number
}

export function visibleCourseMetrics<T>(courses: T[], expanded: boolean, limit = 4) {
  return expanded ? courses : courses.slice(0, Math.max(1, limit))
}

function localDateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function dateKey(value?: string) {
  if (!value) return null
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : localDateKey(parsed)
}

export function buildCourseGrowthMetrics(documents: GrowthDocument[], concepts: GrowthConcept[], ratings: Record<string, GrowthRating>, sessions: Record<string, ReviewSession>): CourseGrowthMetric[] {
  const available = documents.filter((document) => document.status === 'parsed' || document.status === 'ocr')
  const conceptEvidence = buildConceptEvidence(concepts.map((concept) => ({ ...concept, sourceIds: concept.sourceIds ?? [] })), ratings, sessions)
  const courses = new Map<string, { name: string; materialIds: string[] }>()
  for (const document of available) {
    const course = courses.get(document.courseId) ?? { name: document.courseName, materialIds: [] }
    course.materialIds.push(document.materialId)
    courses.set(document.courseId, course)
  }

  return [...courses.entries()].map(([courseId, course]) => {
    const session = sessions[courseId]
    const materialSet = new Set(course.materialIds)
    const tests = (session?.quickTests ?? []).filter((test) => test.status === 'completed')
    const contacted = new Set([
      ...(session?.materialIds ?? []),
      ...Object.keys(session?.materialAssessments ?? {}),
      ...tests.flatMap((test) => test.questions.flatMap((question) => question.materialIds)),
    ].filter((id) => materialSet.has(id)))
    const confirmed = Object.keys(session?.materialAssessments ?? {}).filter((id) => materialSet.has(id))
    const understood = confirmed.filter((id) => (session?.materialAssessments?.[id] ?? 0) >= 3)
    const verified = new Set(tests.flatMap((test) => test.questions.flatMap((question) => question.materialIds)).filter((id) => materialSet.has(id)))
    const weakMaterials = new Set<string>()
    for (const materialId of materialSet) {
      const assessment = session?.materialAssessments?.[materialId]
      const assessedAt = session?.materialAssessmentAt?.[materialId] ?? (assessment ? session?.startedAt : undefined)
      const latestTest = [...tests].filter((test) => test.questions.some((question) => question.materialIds.includes(materialId))).sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0]
      if (latestTest && (!assessedAt || latestTest.generatedAt >= assessedAt)) {
        const linkedQuestions = latestTest.questions.filter((question) => question.materialIds.includes(materialId))
        if (linkedQuestions.some((question) => latestTest.answers[question.id] !== question.correctIndex)) weakMaterials.add(materialId)
      } else if (assessment !== undefined && assessment <= 2) {
        weakMaterials.add(materialId)
      }
    }
    const courseConcepts = concepts.filter((concept) => concept.courseIds.includes(courseId))
    const ratedConcepts = courseConcepts.filter((concept) => (ratings[concept.id] ?? 0) > 0)
    const courseEvidence = courseConcepts.map((concept) => conceptEvidence[concept.id]).filter(Boolean)
    const weakConceptIds = courseEvidence.filter(conceptNeedsReview).map((evidence) => evidence.conceptId)
    return {
      courseId,
      courseName: course.name,
      totalMaterials: materialSet.size,
      contactedMaterials: contacted.size,
      confirmedMaterials: confirmed.length,
      understoodMaterials: understood.length,
      verifiedMaterials: verified.size,
      averageTestScore: tests.length ? Math.round(tests.reduce((sum, test) => sum + (test.score ?? 0), 0) / tests.length) : null,
      weakMaterialIds: [...weakMaterials],
      ratedConcepts: ratedConcepts.length,
      weakConcepts: weakConceptIds.length,
      testedConcepts: courseEvidence.filter((evidence) => evidence.latestTestScore !== null).length,
      verifiedConcepts: courseEvidence.filter((evidence) => evidence.latestTestScore !== null && evidence.latestTestScore >= 80).length,
      testWeakConcepts: courseEvidence.filter((evidence) => evidence.latestTestScore !== null && evidence.latestTestScore < 70).length,
      evidenceConflicts: courseEvidence.filter((evidence) => evidence.status === 'conflict').length,
      weakConceptIds,
    }
  }).sort((left, right) => right.weakMaterialIds.length - left.weakMaterialIds.length || right.verifiedMaterials - left.verifiedMaterials || left.courseName.localeCompare(right.courseName, 'zh-CN'))
}

export function buildGrowthActivity(sessions: Record<string, ReviewSession>, days: number, now = new Date()): GrowthActivityDay[] {
  const result: GrowthActivityDay[] = []
  const byDate = new Map<string, GrowthActivityDay>()
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const value = new Date(now)
    value.setHours(12, 0, 0, 0)
    value.setDate(value.getDate() - offset)
    const date = localDateKey(value)
    const entry = { date, label: `${value.getMonth() + 1}/${value.getDate()}`, contacts: 0, confirmations: 0, tests: 0, total: 0 }
    result.push(entry)
    byDate.set(date, entry)
  }

  for (const session of Object.values(sessions)) {
    const started = byDate.get(dateKey(session.startedAt) ?? '')
    if (started) started.contacts += new Set(session.materialIds).size
    for (const assessedAt of Object.values(session.materialAssessmentAt ?? {})) {
      const entry = byDate.get(dateKey(assessedAt) ?? '')
      if (entry) entry.confirmations += 1
    }
    for (const test of session.quickTests ?? []) {
      if (test.status !== 'completed') continue
      const entry = byDate.get(dateKey(test.generatedAt) ?? '')
      if (entry) entry.tests += 1
    }
  }
  for (const entry of result) entry.total = entry.contacts + entry.confirmations + entry.tests
  return result
}
