import type { ReviewSession } from './review-workspace'

export type CalendarDocument = { materialId: string; courseId: string; courseName: string; title: string; status: string }

export type ReviewHistoryItem = {
  id: string
  courseId: string
  courseName: string
  title: string
  materialId: string
  date: string
  kind: 'reviewed' | 'tested'
  label: string
}

export type CalendarTaskStatus = { stage: 'pending' | 'in_progress' | 'reviewed' | 'tested' | 'overdue'; label: string }

function localDateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function dateFromKey(value: string) {
  return new Date(`${value}T12:00:00`)
}

function timestamp(value?: string) {
  if (!value) return 0
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? 0 : parsed
}

export function weekStart(value: string | Date) {
  const date = typeof value === 'string' ? dateFromKey(value) : new Date(value)
  date.setHours(12, 0, 0, 0)
  const day = date.getDay() || 7
  date.setDate(date.getDate() - day + 1)
  return localDateKey(date)
}

export function shiftDate(value: string, days: number) {
  const date = dateFromKey(value)
  date.setDate(date.getDate() + days)
  return localDateKey(date)
}

export function weekDateKeys(anchor: string | Date) {
  const start = weekStart(anchor)
  return Array.from({ length: 7 }, (_, index) => shiftDate(start, index))
}

export function distributeAcrossWeek(ids: string[], existingDates: Record<string, string>, anchor: string | Date) {
  const days = weekDateKeys(anchor)
  const load = new Map(days.map((date) => [date, Object.values(existingDates).filter((value) => value === date).length]))
  const result: Record<string, string> = {}
  for (const id of ids) {
    const target = [...days].sort((left, right) => (load.get(left) ?? 0) - (load.get(right) ?? 0) || left.localeCompare(right))[0]
    result[id] = target
    load.set(target, (load.get(target) ?? 0) + 1)
  }
  return result
}

export function calendarTaskStatus(item: { courseId: string; materialId?: string; conceptId?: string; scheduledDate: string; createdAt: string }, sessions: Record<string, ReviewSession>, today: string): CalendarTaskStatus {
  const session = sessions[item.courseId]
  const scheduledStart = timestamp(`${item.scheduledDate}T00:00:00`)
  const createdAt = timestamp(item.createdAt)
  const threshold = item.scheduledDate >= item.createdAt.slice(0, 10) ? Math.max(scheduledStart, createdAt) : createdAt
  const relevant = Boolean(session && ((item.materialId && session.materialIds.includes(item.materialId)) || (item.conceptId && session.conceptIds.includes(item.conceptId))))
  if (session?.active && relevant && timestamp(session.startedAt) >= threshold) {
    if (item.materialId && session.completedMaterialIds.includes(item.materialId)) return { stage: 'reviewed', label: '已复习，待测试' }
    return { stage: 'in_progress', label: '复习中' }
  }
  const tests = (session?.quickTests ?? []).filter((test) => test.status === 'completed' && timestamp(test.generatedAt) >= threshold).filter((test) => test.questions.some((question) => (item.materialId && question.materialIds.includes(item.materialId)) || (item.conceptId && question.conceptIds.includes(item.conceptId))))
  const latestTest = [...tests].sort((left, right) => right.generatedAt.localeCompare(left.generatedAt))[0]
  if (latestTest) {
    const linked = latestTest.questions.filter((question) => (item.materialId && question.materialIds.includes(item.materialId)) || (item.conceptId && question.conceptIds.includes(item.conceptId)))
    const correct = linked.filter((question) => latestTest.answers[question.id] === question.correctIndex).length
    const score = linked.length ? Math.round(correct / linked.length * 100) : latestTest.score ?? 0
    return { stage: 'tested', label: `已测试 ${score}%` }
  }
  if (item.materialId && timestamp(session?.materialAssessmentAt?.[item.materialId]) >= threshold) return { stage: 'reviewed', label: '已复习，待测试' }
  return item.scheduledDate < today ? { stage: 'overdue', label: '已逾期' } : { stage: 'pending', label: item.scheduledDate === today ? '今天待复习' : '待开始' }
}

export function latestReviewEvidenceAt(sessions: Record<string, ReviewSession>) {
  const values = Object.values(sessions).flatMap((session) => [
    session.startedAt,
    ...Object.values(session.materialAssessmentAt ?? {}),
    ...(session.quickTests ?? []).filter((test) => test.status === 'completed').map((test) => test.generatedAt),
  ]).filter((value): value is string => Boolean(value && timestamp(value)))
  return values.sort().at(-1) ?? null
}

export function inactiveReviewDays(sessions: Record<string, ReviewSession>, now = new Date()) {
  const latest = latestReviewEvidenceAt(sessions)
  return latest ? Math.max(0, Math.floor((now.getTime() - timestamp(latest)) / 86_400_000)) : null
}

export function suggestionIsDismissed(id: string, scheduledDate: string, dismissed: Record<string, string>) {
  return dismissed[id] === scheduledDate
}

export function buildReviewHistory(documents: CalendarDocument[], sessions: Record<string, ReviewSession>): ReviewHistoryItem[] {
  const documentById = new Map(documents.filter((document) => document.status === 'parsed' || document.status === 'ocr').map((document) => [document.materialId, document]))
  const items: ReviewHistoryItem[] = []
  for (const [courseId, session] of Object.entries(sessions)) {
    for (const [materialId, assessedAt] of Object.entries(session.materialAssessmentAt ?? {})) {
      const document = documentById.get(materialId)
      if (!document || !assessedAt) continue
      const assessment = session.materialAssessments?.[materialId]
      items.push({ id: `assessment:${courseId}:${materialId}:${assessedAt}`, courseId, courseName: document.courseName, title: document.title, materialId, date: localDateKey(new Date(assessedAt)), kind: 'reviewed', label: assessment === 1 ? '已复习 · 没看懂' : assessment === 2 ? '已复习 · 有些模糊' : assessment === 3 ? '已复习 · 基本理解' : '已复习 · 可以解释' })
    }
    for (const test of session.quickTests ?? []) {
      if (test.status !== 'completed') continue
      const materialIds = [...new Set(test.questions.flatMap((question) => question.materialIds))]
      for (const materialId of materialIds) {
        const document = documentById.get(materialId)
        if (!document) continue
        const linked = test.questions.filter((question) => question.materialIds.includes(materialId))
        const correct = linked.filter((question) => test.answers[question.id] === question.correctIndex).length
        const score = linked.length ? Math.round(correct / linked.length * 100) : test.score ?? 0
        items.push({ id: `test:${courseId}:${materialId}:${test.id}`, courseId, courseName: document.courseName, title: document.title, materialId, date: localDateKey(new Date(test.generatedAt)), kind: 'tested', label: `已测试 ${score}%` })
      }
    }
  }
  return items.sort((left, right) => left.date.localeCompare(right.date) || left.title.localeCompare(right.title, 'zh-CN'))
}
