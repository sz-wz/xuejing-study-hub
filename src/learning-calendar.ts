import type { AchievementAward, LearningEvent } from './achievements'
import type { Assignment, JournalEntry } from './types'

export type LearningCalendarKind = 'review' | 'test' | 'assignment' | 'focus' | 'journal' | 'achievement'

export type LearningCalendarItem = {
  id: string
  date: string
  kind: LearningCalendarKind
  title: string
  occurredAt: string
  courseId?: string
  detail?: string
}

export type LearningCalendarDay = {
  date: string
  day: number
  inMonth: boolean
  today: boolean
  items: LearningCalendarItem[]
  counts: Record<LearningCalendarKind, number>
  hasHighlight: boolean
}

const kinds: LearningCalendarKind[] = ['review', 'test', 'assignment', 'focus', 'journal', 'achievement']

export function localDateKey(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value)
  if (!Number.isFinite(date.getTime())) return typeof value === 'string' ? value.slice(0, 10) : ''
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function eventKind(event: LearningEvent): LearningCalendarKind | null {
  if (event.type === 'review_started' || event.type === 'review_completed' || event.type === 'material_confirmed') return 'review'
  if (event.type === 'quick_test_completed') return 'test'
  if (event.type === 'assignment_completed' || event.type === 'assignment_analyzed') return 'assignment'
  if (event.type === 'focus_completed') return 'focus'
  return null
}

function eventTitle(event: LearningEvent) {
  const labels: Partial<Record<LearningEvent['type'], string>> = {
    review_started: '开始复习会话', review_completed: '完成复习会话', material_confirmed: '完成资料掌握确认', quick_test_completed: '完成快速测试', focus_completed: '完成专注计时', assignment_completed: '完成作业', assignment_analyzed: '完成作业知识分析', journal_saved: '写下学习日记', platform_sync: '同步学习平台', material_import: '导入课程资料', knowledge_build: '更新本地知识库', ai_refine: '完成 AI 精炼', schedule_adjusted: '调整复习日程', course_completed: '课程结课',
  }
  return event.title || labels[event.type] || '学习记录'
}

export function buildLearningCalendarItems(input: { events: LearningEvent[]; journal: JournalEntry[]; awards: AchievementAward[]; assignments?: Assignment[] }) {
  const items: LearningCalendarItem[] = []
  for (const event of input.events) {
    const kind = eventKind(event)
    if (!kind) continue
    items.push({ id: `event:${event.id}`, date: localDateKey(event.occurredAt), occurredAt: event.occurredAt, kind, title: eventTitle(event), courseId: event.courseId, detail: event.score === undefined ? undefined : `测试 ${event.score}%` })
  }
  for (const entry of input.journal) items.push({ id: `journal:${entry.id}`, date: entry.date, occurredAt: entry.updatedAt || `${entry.date}T12:00:00`, kind: 'journal', title: '学习日记', detail: `${entry.mood} · ${entry.content}` })
  const backfilledByDate = new Map<string, AchievementAward[]>()
  for (const award of input.awards) {
    if (award.backfilled) {
      const date = localDateKey(award.awardedAt)
      backfilledByDate.set(date, [...(backfilledByDate.get(date) ?? []), award])
    } else items.push({ id: `award:${award.id}`, date: localDateKey(award.awardedAt), occurredAt: award.awardedAt, kind: 'achievement', title: award.evidenceSummary, detail: '新成就' })
  }
  for (const [date, awards] of backfilledByDate) items.push({ id: `award-backfill:${date}`, date, occurredAt: awards.map((award) => award.awardedAt).sort().at(-1) ?? `${date}T12:00:00`, kind: 'achievement', title: `已有成长回顾 · ${awards.length} 项`, detail: '根据历史学习证据一次性补发，未逐条提醒' })
  return [...new Map(items.map((item) => [item.id, item])).values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt))
}

export function monthAnchor(value: string | Date) {
  const date = value instanceof Date ? value : new Date(`${value.slice(0, 7)}-01T12:00:00`)
  return new Date(date.getFullYear(), date.getMonth(), 1, 12)
}

export function shiftMonth(value: string | Date, delta: number) {
  const anchor = monthAnchor(value)
  return localDateKey(new Date(anchor.getFullYear(), anchor.getMonth() + delta, 1, 12))
}

export function buildMonthGrid(anchorValue: string | Date, items: LearningCalendarItem[], todayValue: string | Date = new Date()): LearningCalendarDay[] {
  const anchor = monthAnchor(anchorValue)
  const mondayOffset = (anchor.getDay() + 6) % 7
  const start = new Date(anchor.getFullYear(), anchor.getMonth(), 1 - mondayOffset, 12)
  const today = localDateKey(todayValue)
  const grouped = new Map<string, LearningCalendarItem[]>()
  for (const item of items) grouped.set(item.date, [...(grouped.get(item.date) ?? []), item])
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index, 12)
    const key = localDateKey(date)
    const dayItems = grouped.get(key) ?? []
    const counts = Object.fromEntries(kinds.map((kind) => [kind, dayItems.filter((item) => item.kind === kind).length])) as Record<LearningCalendarKind, number>
    return { date: key, day: date.getDate(), inMonth: date.getMonth() === anchor.getMonth(), today: key === today, items: dayItems, counts, hasHighlight: counts.achievement > 0 }
  })
}

export function filterLearningCalendarItems(items: LearningCalendarItem[], kind: LearningCalendarKind | 'all', courseId: string | 'all') {
  return items.filter((item) => (kind === 'all' || item.kind === kind) && (courseId === 'all' || item.courseId === courseId))
}
