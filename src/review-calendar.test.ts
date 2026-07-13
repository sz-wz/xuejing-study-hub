import { describe, expect, it } from 'vitest'
import { buildReviewHistory, calendarTaskStatus, distributeAcrossWeek, inactiveReviewDays, shiftDate, suggestionIsDismissed, weekDateKeys, weekStart } from './review-calendar'

describe('review calendar', () => {
  it('uses Monday as the stable start of a review week', () => {
    expect(weekStart('2026-07-15')).toBe('2026-07-13')
    expect(weekDateKeys('2026-07-15')).toEqual(['2026-07-13', '2026-07-14', '2026-07-15', '2026-07-16', '2026-07-17', '2026-07-18', '2026-07-19'])
    expect(shiftDate('2026-07-31', 1)).toBe('2026-08-01')
  })

  it('distributes selected tasks toward the least loaded days', () => {
    expect(distributeAcrossWeek(['a', 'b', 'c'], { old: '2026-07-13' }, '2026-07-15')).toEqual({ a: '2026-07-14', b: '2026-07-15', c: '2026-07-16' })
  })

  it('keeps assessment and quick-test evidence as read-only calendar history', () => {
    const history = buildReviewHistory([{ materialId: 'm1', courseId: 'c1', courseName: '课程', title: 'Lecture.pdf', status: 'parsed' }], { c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], materialAssessments: { m1: 2 }, materialAssessmentAt: { m1: '2026-07-12T10:00:00.000Z' }, startedAt: '', quickTests: [{ id: 't1', scope: 'current', questionCount: 1, status: 'completed', score: 100, generatedAt: '2026-07-13T10:00:00.000Z', answers: { q: 0 }, questions: [{ id: 'q', prompt: '', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: [] }] }] } })
    expect(history.map((item) => ({ date: item.date, kind: item.kind, label: item.label }))).toEqual([{ date: '2026-07-12', kind: 'reviewed', label: '已复习 · 有些模糊' }, { date: '2026-07-13', kind: 'tested', label: '已测试 100%' }])
  })

  it('does not let evidence from before a new schedule complete that schedule', () => {
    const task = { courseId: 'c1', materialId: 'm1', scheduledDate: '2026-07-15', createdAt: '2026-07-13T12:00:00.000Z' }
    const oldTest = { id: 'old', scope: 'current' as const, questionCount: 1, status: 'completed' as const, score: 100, generatedAt: '2026-07-13T10:00:00.000Z', answers: { q: 0 }, questions: [{ id: 'q', prompt: '', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: [] }] }
    expect(calendarTaskStatus(task, { c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], startedAt: '', quickTests: [oldTest] } }, '2026-07-16')).toEqual({ stage: 'overdue', label: '已逾期' })
    const newTest = { ...oldTest, id: 'new', generatedAt: '2026-07-15T13:00:00.000Z' }
    expect(calendarTaskStatus(task, { c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], startedAt: '', quickTests: [oldTest, newTest] } }, '2026-07-16')).toEqual({ stage: 'tested', label: '已测试 100%' })
  })

  it('detects long gaps and dismisses only the current suggestion version', () => {
    const sessions = { c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: [], startedAt: '2026-07-01T12:00:00.000Z' } }
    expect(inactiveReviewDays(sessions, new Date('2026-07-20T12:00:00.000Z'))).toBe(19)
    expect(suggestionIsDismissed('material:c1:m1', '2026-07-10', { 'material:c1:m1': '2026-07-10' })).toBe(true)
    expect(suggestionIsDismissed('material:c1:m1', '2026-07-21', { 'material:c1:m1': '2026-07-10' })).toBe(false)
  })
})
