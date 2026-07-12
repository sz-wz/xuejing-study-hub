import { describe, expect, it } from 'vitest'
import { assignmentDueAt, assignmentCompleted, deadlineLabel, deadlineReminderBucket, deadlineState, toDateTimeLocalValue } from './deadline-utils'
import type { Assignment } from './types'

const task = (dueAt?: string, manualDueAt?: string): Assignment => ({
  id: 'a1', courseId: 'ee150', source: 'Gradescope', sourceCourseName: 'EE150.02', term: 'Spring 2026', title: 'HW1', url: 'https://example.test/a1', status: 'unknown', dueAt, manualDueAt, lastSyncedAt: '',
})

describe('DDL 状态', () => {
  const now = new Date('2026-07-12T10:00:00+08:00')

  it('按截止时间给出逾期、今日、明日和近期状态', () => {
    expect(deadlineState(task('2026-07-12T09:00:00+08:00'), now)).toBe('overdue')
    expect(deadlineState(task('2026-07-12T20:00:00+08:00'), now)).toBe('today')
    expect(deadlineState(task('2026-07-13T20:00:00+08:00'), now)).toBe('tomorrow')
    expect(deadlineState(task('2026-07-14T20:00:00+08:00'), now)).toBe('soon')
  })

  it('人工设置的截止时间优先于平台同步值，并生成提醒分组', () => {
    const assignment = task('2026-07-20T20:00:00+08:00', '2026-07-12T16:00:00+08:00')
    expect(assignmentDueAt(assignment)).toBe('2026-07-12T16:00:00+08:00')
    expect(deadlineReminderBucket(assignment, now)).toBe('today')
    expect(deadlineLabel(assignment, now)).toBe('今天截止')
  })

  it('已提交、已批改和手动完成的历史作业不会再显示为已逾期', () => {
    const submitted = { ...task('2026-07-01T20:00:00+08:00'), status: 'submitted' as const }
    const graded = { ...task('2026-07-01T20:00:00+08:00'), status: 'graded' as const, score: 97, maxScore: 100 }
    const manual = { ...task('2026-07-01T20:00:00+08:00'), manualStatus: 'completed' as const }

    expect(deadlineLabel(submitted, now)).toBe('已提交')
    expect(deadlineLabel(graded, now)).toBe('已批改 97/100')
    expect(deadlineLabel(manual, now)).toBe('已手动完成')
    expect(assignmentCompleted(submitted)).toBe(true)
  })

  it('可将 ISO 截止时间转为编辑器需要的本地日期时间', () => {
    expect(toDateTimeLocalValue('2026-07-12T16:30:00+08:00')).toMatch(/^2026-07-12T16:30$/)
  })
})
