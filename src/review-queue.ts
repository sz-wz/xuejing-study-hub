import type { MaterialAssessment, ReviewSession } from './review-workspace'

type QueueDocument = { materialId: string; courseId: string; courseName: string; title: string; status: string }
type QueueConcept = { id: string; title: string; sourceIds: string[]; courseIds: string[] }
type Rating = 0 | 1 | 2 | 3 | 4

export type ReviewQueueItem = {
  id: string
  courseId: string
  courseName: string
  title: string
  reason: string
  priority: number
  materialId?: string
  conceptId?: string
  scheduledDate?: string
  scheduleSource?: 'manual' | 'interval'
}

export type ReviewScheduleEntry = {
  id: string
  courseId: string
  courseName: string
  title: string
  materialId?: string
  conceptId?: string
  scheduledDate: string
  createdAt: string
}

export type ReviewQueueProgress = {
  stage: 'not_started' | 'in_progress' | 'reviewed' | 'tested'
  label: string
  score?: number
}

export type ReviewQueueSelection = { materialIds: string[]; conceptIds: string[]; focus: string; mode: 'manual' }
export type MemorySchedule = { lastEvidenceAt: string; intervalDays: number; successfulReviews: number; lapses: number; reason: string }

const assessmentReason: Record<MaterialAssessment, string> = {
  1: '上次确认“没看懂”，建议先重新阅读',
  2: '上次确认“有些模糊”，适合今天巩固',
  3: '已经基本理解，可稍后进行快速检测',
  4: '已经可以解释，暂不优先安排',
}

export function reviewTargetKey(item: Pick<ReviewQueueItem, 'courseId' | 'materialId' | 'conceptId'>) {
  return item.conceptId ? `concept:${item.courseId}:${item.conceptId}` : `material:${item.courseId}:${item.materialId ?? 'unknown'}`
}

function addDays(date: string, days: number) {
  const value = new Date(`${date.slice(0, 10)}T12:00:00`)
  value.setDate(value.getDate() + days)
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

type MemoryEvidence = { at: string; kind: 'assessment'; assessment: MaterialAssessment } | { at: string; kind: 'test'; score: number }

function linkedTestScore(test: NonNullable<ReviewSession['quickTests']>[number], item: Pick<ReviewQueueItem, 'materialId' | 'conceptId'>) {
  const linked = test.questions.filter((question) => (item.conceptId && question.conceptIds.includes(item.conceptId)) || (item.materialId && question.materialIds.includes(item.materialId)))
  if (!linked.length) return null
  const correct = linked.filter((question) => test.answers[question.id] === question.correctIndex).length
  return Math.round(correct / linked.length * 100)
}

function memoryEvidenceFor(item: Pick<ReviewQueueItem, 'courseId' | 'materialId' | 'conceptId'>, sessions: Record<string, ReviewSession>) {
  const session = sessions[item.courseId]
  if (!session) return []
  const evidence: MemoryEvidence[] = []
  if (item.materialId) {
    for (const record of session.materialReviewHistory ?? []) {
      if (record.materialId === item.materialId && record.assessedAt) evidence.push({ at: record.assessedAt, kind: 'assessment', assessment: record.assessment })
    }
    const legacyAssessment = session.materialAssessments?.[item.materialId]
    const legacyAt = session.materialAssessmentAt?.[item.materialId] ?? (legacyAssessment ? session.startedAt : '')
    if (legacyAssessment && legacyAt && !evidence.some((entry) => entry.kind === 'assessment' && entry.at === legacyAt && entry.assessment === legacyAssessment)) {
      evidence.push({ at: legacyAt, kind: 'assessment', assessment: legacyAssessment })
    }
  }
  for (const test of session.quickTests ?? []) {
    if (test.status !== 'completed' || !test.generatedAt) continue
    const score = linkedTestScore(test, item)
    if (score !== null) evidence.push({ at: test.generatedAt, kind: 'test', score })
  }
  return evidence.sort((left, right) => left.at.localeCompare(right.at))
}

export function memoryScheduleFor(item: Pick<ReviewQueueItem, 'courseId' | 'materialId' | 'conceptId'>, sessions: Record<string, ReviewSession>): MemorySchedule | null {
  const evidence = memoryEvidenceFor(item, sessions)
  if (!evidence.length) return null
  let intervalDays = 1
  let successfulReviews = 0
  let lapses = 0
  let latestLabel = '最近复习'
  for (const entry of evidence) {
    if (entry.kind === 'assessment') {
      latestLabel = `掌握确认“${({ 1: '没看懂', 2: '有些模糊', 3: '基本理解', 4: '可以解释' } as Record<MaterialAssessment, string>)[entry.assessment]}”`
      if (entry.assessment <= 2) {
        intervalDays = entry.assessment === 1 ? 1 : 2
        lapses += 1
      } else {
        const base = entry.assessment === 3 ? 4 : 7
        intervalDays = successfulReviews ? Math.max(base, Math.round(intervalDays * (entry.assessment === 3 ? 1.65 : 2.15))) : base
        successfulReviews += 1
      }
      continue
    }
    latestLabel = `最近测试 ${entry.score}%`
    if (entry.score < 60) {
      intervalDays = 1
      lapses += 1
    } else if (entry.score < 80) {
      intervalDays = successfulReviews ? Math.max(2, Math.round(intervalDays * 0.65)) : 3
      successfulReviews += 1
    } else if (entry.score < 90) {
      intervalDays = successfulReviews ? Math.max(5, Math.round(intervalDays * 1.7)) : 5
      successfulReviews += 1
    } else {
      intervalDays = successfulReviews ? Math.max(7, Math.round(intervalDays * 2.15)) : 7
      successfulReviews += 1
    }
  }
  intervalDays = Math.max(1, Math.min(90, intervalDays))
  const memoryStage = lapses ? `已出现 ${lapses} 次遗忘信号` : successfulReviews > 1 ? `连续稳定 ${successfulReviews} 次` : '正在建立首次记忆'
  return { lastEvidenceAt: evidence.at(-1)!.at, intervalDays, successfulReviews, lapses, reason: `按遗忘曲线：${latestLabel}，${memoryStage}，建议 ${intervalDays} 天后巩固` }
}

export function suggestedNextReviewDate(item: Pick<ReviewQueueItem, 'courseId' | 'materialId' | 'conceptId'>, sessions: Record<string, ReviewSession>) {
  const schedule = memoryScheduleFor(item, sessions)
  return schedule ? addDays(schedule.lastEvidenceAt.slice(0, 10), schedule.intervalDays) : null
}

export function reviewQueueProgress(item: Pick<ReviewQueueItem, 'courseId' | 'materialId' | 'conceptId'> & Partial<Pick<ReviewQueueItem, 'id'>>, sessions: Record<string, ReviewSession>): ReviewQueueProgress {
  const session = sessions[item.courseId]
  if (!session) return { stage: 'not_started', label: '未开始' }
  const relevant = (item.materialId && session.materialIds.includes(item.materialId)) || (item.conceptId && session.conceptIds.includes(item.conceptId))
  if (session.active && relevant) {
    if (item.materialId && session.completedMaterialIds.includes(item.materialId)) return { stage: 'reviewed', label: '已复习，待测试' }
    return { stage: 'in_progress', label: '复习中' }
  }
  const triggerTestId = item.id?.match(/^test-error:([^:]+):/)?.[1]
  const triggerTest = triggerTestId ? (session.quickTests ?? []).find((test) => test.id === triggerTestId) : undefined
  const matchingTests = (session.quickTests ?? []).filter((test) => test.status === 'completed' && test.questions.some((question) => (item.conceptId && question.conceptIds.includes(item.conceptId)) || (item.materialId && question.materialIds.includes(item.materialId))))
  const latestTest = [...matchingTests].reverse().find((test) => test.id !== triggerTestId)
  if (latestTest) {
    const linked = latestTest.questions.filter((question) => (item.conceptId && question.conceptIds.includes(item.conceptId)) || (item.materialId && question.materialIds.includes(item.materialId)))
    const correct = linked.filter((question) => latestTest.answers[question.id] === question.correctIndex).length
    const score = linked.length ? Math.round(correct / linked.length * 100) : latestTest.score ?? 0
    return { stage: 'tested', label: `最近测试 ${score}%`, score }
  }
  if (triggerTest) {
    const reviewedAfterFailure = session.startedAt > triggerTest.generatedAt && Boolean(item.materialId && session.completedMaterialIds.includes(item.materialId))
    return reviewedAfterFailure ? { stage: 'reviewed', label: '已复习，待测试' } : { stage: 'not_started', label: '未复习' }
  }
  if (item.materialId && session.completedMaterialIds.includes(item.materialId)) return { stage: 'reviewed', label: '已复习，待测试' }
  return { stage: 'not_started', label: '未开始' }
}

export function createReviewScheduleEntry(item: ReviewQueueItem, scheduledDate: string, createdAt = new Date().toISOString()): ReviewScheduleEntry {
  return { id: reviewTargetKey(item), courseId: item.courseId, courseName: item.courseName, title: item.title, materialId: item.materialId, conceptId: item.conceptId, scheduledDate, createdAt }
}

export function selectionForReviewQueueItem(item: ReviewQueueItem): ReviewQueueSelection {
  const conceptTask = item.id.startsWith('concept:') || item.id.startsWith('unrated:')
  if (conceptTask && item.conceptId) return { materialIds: [], conceptIds: [item.conceptId], focus: '', mode: 'manual' }
  if (item.materialId) return { materialIds: [item.materialId], conceptIds: [], focus: '', mode: 'manual' }
  return { materialIds: [], conceptIds: item.conceptId ? [item.conceptId] : [], focus: '', mode: 'manual' }
}

export function buildReviewQueue(documents: QueueDocument[], concepts: QueueConcept[], ratings: Record<string, Rating>, sessions: Record<string, ReviewSession>, limit = 6, schedule: ReviewScheduleEntry[] = [], today = new Date().toISOString().slice(0, 10)): ReviewQueueItem[] {
  const documentById = new Map(documents.filter((document) => document.status === 'parsed' || document.status === 'ocr').map((document) => [document.materialId, document]))
  const candidates: ReviewQueueItem[] = []
  const scheduleByTarget = new Map(schedule.map((entry) => [entry.id, entry]))

  for (const entry of schedule) {
    if (entry.scheduledDate > today) continue
    if (entry.materialId && !documentById.has(entry.materialId)) continue
    if (entry.conceptId && !concepts.some((concept) => concept.id === entry.conceptId)) continue
    candidates.push({ ...entry, reason: entry.scheduledDate < today ? `计划于 ${entry.scheduledDate} 复习，当前已到期` : '已安排在今天复习', priority: 140, scheduleSource: 'manual' })
  }

  for (const [courseId, session] of Object.entries(sessions)) {
    const latestTest = [...(session.quickTests ?? [])].reverse().find((test) => test.status === 'completed')
    if (latestTest) {
      for (const question of latestTest.questions) {
        if (latestTest.answers[question.id] === question.correctIndex) continue
        const materialId = question.materialIds[0]
        const document = documentById.get(materialId)
        if (!document) continue
        const conceptId = question.conceptIds[0]
        candidates.push({ id: `test-error:${latestTest.id}:${question.id}`, courseId, courseName: document.courseName, title: conceptId ? concepts.find((concept) => concept.id === conceptId)?.title ?? document.title : document.title, reason: `最近快速测试中回答错误（${latestTest.score ?? 0}%）`, priority: 120, materialId })
      }
      for (const materialId of latestTest.remainingMaterialIds ?? []) {
        const document = documentById.get(materialId)
        if (!document) continue
        candidates.push({ id: `test-uncovered:${latestTest.id}:${materialId}`, courseId, courseName: document.courseName, title: document.title, reason: '上一轮测试尚未覆盖这份资料', priority: 92, materialId })
      }
    }
    for (const [materialId, assessment] of Object.entries(session.materialAssessments ?? {}) as [string, MaterialAssessment][]) {
      if (assessment > 2) continue
      const document = documentById.get(materialId)
      if (!document) continue
      const item = { id: `assessment:${materialId}`, courseId, courseName: document.courseName, title: document.title, reason: assessmentReason[assessment], priority: assessment === 1 ? 110 : 95, materialId }
      const nextDate = suggestedNextReviewDate(item, sessions)
      if (nextDate && nextDate > today) continue
      candidates.push(item)
    }
    for (const materialId of session.materialIds) {
      if (session.completedMaterialIds.includes(materialId)) continue
      const document = documentById.get(materialId)
      if (!document) continue
      candidates.push({ id: `unfinished:${materialId}`, courseId, courseName: document.courseName, title: document.title, reason: '已加入复习会话，但还没有完成', priority: 82, materialId })
    }
  }

  for (const concept of concepts) {
    const rating = ratings[concept.id] ?? 0
    if (rating > 2) continue
    const courseId = concept.courseIds[0]
    const document = concept.sourceIds.map((id) => documentById.get(id)).find(Boolean)
    if (!courseId || !document) continue
    if (rating === 1 || rating === 2) {
      candidates.push({ id: `concept:${concept.id}`, courseId, courseName: document.courseName, title: concept.title, reason: rating === 1 ? '知识点自评为“陌生”' : '知识点自评为“模糊”', priority: rating === 1 ? 105 : 90, materialId: document.materialId, conceptId: concept.id })
    }
  }

  for (const document of documentById.values()) {
    const item: ReviewQueueItem = { id: `interval:${document.materialId}`, courseId: document.courseId, courseName: document.courseName, title: document.title, reason: '', priority: 88, materialId: document.materialId }
    if (scheduleByTarget.has(reviewTargetKey(item))) continue
    const memory = memoryScheduleFor(item, sessions)
    if (!memory) continue
    const dueDate = addDays(memory.lastEvidenceAt.slice(0, 10), memory.intervalDays)
    if (dueDate > today) continue
    candidates.push({ ...item, reason: `${dueDate < today ? `间隔复习已于 ${dueDate} 到期` : '今天进入复习窗口'}；${memory.reason}`, scheduledDate: dueDate, scheduleSource: 'interval' })
  }

  const courseWithCandidate = new Set(candidates.map((item) => item.courseId))
  for (const concept of concepts) {
    if ((ratings[concept.id] ?? 0) !== 0) continue
    const courseId = concept.courseIds[0]
    if (!courseId || courseWithCandidate.has(courseId)) continue
    const document = concept.sourceIds.map((id) => documentById.get(id)).find(Boolean)
    if (!document) continue
    candidates.push({ id: `unrated:${concept.id}`, courseId, courseName: document.courseName, title: concept.title, reason: '尚未进行掌握评估，可先快速确认', priority: 45, materialId: document.materialId, conceptId: concept.id })
    courseWithCandidate.add(courseId)
  }

  const seen = new Set<string>()
  const perCourse = new Map<string, number>()
  const courseCount = Math.max(1, new Set(documents.map((document) => document.courseId)).size)
  const perCourseLimit = Math.max(2, Math.ceil(limit / courseCount))
  return candidates.sort((left, right) => right.priority - left.priority || left.title.localeCompare(right.title, 'zh-CN')).filter((item) => {
    const manualSchedule = scheduleByTarget.get(reviewTargetKey(item))
    if (manualSchedule?.scheduledDate && manualSchedule.scheduledDate > today) return false
    const key = item.conceptId ? `concept:${item.conceptId}` : `material:${item.materialId}`
    if (seen.has(key) || (item.scheduleSource !== 'manual' && (perCourse.get(item.courseId) ?? 0) >= perCourseLimit)) return false
    seen.add(key)
    perCourse.set(item.courseId, (perCourse.get(item.courseId) ?? 0) + 1)
    return true
  }).slice(0, Math.max(1, limit))
}
