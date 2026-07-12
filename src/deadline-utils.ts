import type { Assignment } from './types'

export type DeadlineState = 'overdue' | 'today' | 'tomorrow' | 'soon' | 'future' | 'unknown'

export function assignmentDueAt(assignment: Assignment) {
  return assignment.manualDueAt || assignment.dueAt
}

export function assignmentCompleted(assignment: Assignment) {
  return assignment.manualStatus === 'completed' || assignment.status === 'submitted' || assignment.status === 'graded'
}

export function deadlineState(assignment: Assignment, now = new Date()): DeadlineState {
  const dueAt = assignmentDueAt(assignment)
  if (!dueAt) return 'unknown'
  const due = new Date(dueAt)
  if (Number.isNaN(due.getTime())) return 'unknown'
  const hours = (due.getTime() - now.getTime()) / (60 * 60 * 1000)
  if (hours < 0) return 'overdue'
  if (hours < 24) return 'today'
  if (hours < 48) return 'tomorrow'
  if (hours <= 72) return 'soon'
  return 'future'
}

export function deadlineLabel(assignment: Assignment, now = new Date()) {
  if (assignment.manualStatus === 'completed') return '已手动完成'
  if (assignment.status === 'graded') return assignment.score !== undefined && assignment.maxScore !== undefined
    ? `已批改 ${assignment.score}/${assignment.maxScore}`
    : '已批改'
  if (assignment.status === 'submitted') return '已提交'
  const state = deadlineState(assignment, now)
  if (state === 'overdue') return '已逾期'
  if (state === 'today') return '今天截止'
  if (state === 'tomorrow') return '明天截止'
  if (state === 'soon') return '3 天内截止'
  if (state === 'unknown') return '未设置截止时间'
  const due = new Date(assignmentDueAt(assignment)!)
  return `截止：${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(due)}`
}

export function deadlineReminderBucket(assignment: Assignment, now = new Date()) {
  const state = deadlineState(assignment, now)
  if (state === 'overdue') return 'overdue'
  if (state === 'today') return 'today'
  if (state === 'tomorrow' || state === 'soon') return 'soon'
  return null
}

export function toDateTimeLocalValue(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const offset = date.getTimezoneOffset() * 60_000
  return new Date(date.getTime() - offset).toISOString().slice(0, 16)
}
