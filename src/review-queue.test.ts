import { describe, expect, it } from 'vitest'
import { buildReviewQueue, createReviewScheduleEntry, reviewQueueProgress, selectionForReviewQueueItem, suggestedNextReviewDate, type ReviewQueueItem } from './review-queue'

const documents = [
  { materialId: 'm1', courseId: 'c1', courseName: '信号与系统', title: 'Lecture 1', status: 'parsed' },
  { materialId: 'm2', courseId: 'c2', courseName: '算法', title: 'Graph', status: 'parsed' },
]

describe('buildReviewQueue', () => {
  it('prioritizes explicit weak evidence and does not flood the queue with every unrated concept', () => {
    const concepts = Array.from({ length: 20 }, (_, index) => ({ id: `k${index}`, title: `知识点 ${index}`, sourceIds: ['m1'], courseIds: ['c1'] }))
    const queue = buildReviewQueue(documents, concepts, { k3: 1 }, {}, 6)
    expect(queue[0]).toMatchObject({ conceptId: 'k3', reason: '知识点自评为“陌生”' })
    expect(queue).toHaveLength(1)
  })

  it('uses the 10-second material assessment and keeps the daily queue compact across courses', () => {
    const queue = buildReviewQueue(documents, [], {}, {
      c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], materialAssessments: { m1: 2 }, startedAt: '' },
      c2: { active: false, materialIds: ['m2'], conceptIds: [], completedMaterialIds: [], startedAt: '' },
    })
    expect(queue.map((item) => item.id)).toEqual(['assessment:m1', 'unfinished:m2'])
  })

  it('places incorrect quick-test evidence ahead of ordinary review signals', () => {
    const queue = buildReviewQueue(documents, [{ id: 'k1', title: '卷积', sourceIds: ['m1'], courseIds: ['c1'] }], {}, {
      c1: { active: false, materialIds: ['m1'], conceptIds: ['k1'], completedMaterialIds: ['m1'], startedAt: '', quickTests: [{ id: 't1', scope: 'session', questionCount: 1, generatedAt: '', status: 'completed', score: 0, answers: { 'q-1': 1 }, questions: [{ id: 'q-1', prompt: '题目', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: ['k1'] }] }] },
    })
    expect(queue[0]).toMatchObject({ materialId: 'm1', reason: '最近快速测试中回答错误（0%）' })
    expect(queue[0].conceptId).toBeUndefined()
  })

  it('lets a manual schedule defer a generated task and returns it when the date arrives', () => {
    const item: ReviewQueueItem = { id: 'assessment:m1', courseId: 'c1', courseName: '信号与系统', title: 'Lecture 1', reason: '', priority: 1, materialId: 'm1' }
    const schedule = [createReviewScheduleEntry(item, '2026-07-15', '2026-07-13T00:00:00.000Z')]
    const sessions = { c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], materialAssessments: { m1: 1 as const }, materialAssessmentAt: { m1: '2026-07-13T00:00:00.000Z' }, startedAt: '2026-07-13T00:00:00.000Z' } }
    expect(buildReviewQueue(documents, [], {}, sessions, 6, schedule, '2026-07-14')).toEqual([])
    expect(buildReviewQueue(documents, [], {}, sessions, 6, schedule, '2026-07-15')[0]).toMatchObject({ scheduleSource: 'manual', scheduledDate: '2026-07-15', reason: '已安排在今天复习' })
  })

  it('computes interval dates from the latest assessment and test evidence', () => {
    const item: ReviewQueueItem = { id: 'm1', courseId: 'c1', courseName: '信号与系统', title: 'Lecture 1', reason: '', priority: 1, materialId: 'm1' }
    expect(suggestedNextReviewDate(item, { c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], materialAssessments: { m1: 2 }, materialAssessmentAt: { m1: '2026-07-13T10:00:00.000Z' }, startedAt: '' } })).toBe('2026-07-15')
    expect(suggestedNextReviewDate(item, { c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], startedAt: '', quickTests: [{ id: 't', scope: 'current', questionCount: 1, generatedAt: '2026-07-13T11:00:00.000Z', status: 'completed', score: 100, answers: { q: 0 }, questions: [{ id: 'q', prompt: '', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: [] }] }] } })).toBe('2026-07-20')
  })

  it('does not keep an old unclear assessment in today queue after a newer correct test', () => {
    const sessions = { c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], materialAssessments: { m1: 2 as const }, materialAssessmentAt: { m1: '2026-07-12T10:00:00.000Z' }, startedAt: '', quickTests: [{ id: 't', scope: 'current' as const, questionCount: 1, generatedAt: '2026-07-13T11:00:00.000Z', status: 'completed' as const, score: 100, answers: { q: 0 }, questions: [{ id: 'q', prompt: '', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: [] }] }] } }
    expect(buildReviewQueue(documents, [], {}, sessions, 6, [], '2026-07-14')).toEqual([])
    expect(buildReviewQueue(documents, [], {}, sessions, 6, [], '2026-07-20')[0]).toMatchObject({ id: 'assessment:m1' })
  })

  it('shows whether a queue task is in progress, reviewed, or tested', () => {
    const item: ReviewQueueItem = { id: 'm1', courseId: 'c1', courseName: '信号与系统', title: 'Lecture 1', reason: '', priority: 1, materialId: 'm1' }
    expect(reviewQueueProgress(item, { c1: { active: true, materialIds: ['m1'], conceptIds: [], completedMaterialIds: [], startedAt: '' } }).label).toBe('复习中')
    expect(reviewQueueProgress(item, { c1: { active: true, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], startedAt: '' } }).label).toBe('已复习，待测试')
    expect(reviewQueueProgress(item, { c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], startedAt: '', quickTests: [{ id: 't', scope: 'current', questionCount: 1, generatedAt: '', status: 'completed', score: 100, answers: { q: 0 }, questions: [{ id: 'q', prompt: '', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: [] }] }] } })).toMatchObject({ stage: 'tested', label: '最近测试 100%', score: 100 })
  })

  it('treats the failed test that created a queue task as history, not task completion', () => {
    const item: ReviewQueueItem = { id: 'test-error:t:q', courseId: 'c1', courseName: '信号与系统', title: 'Lecture 1', reason: '', priority: 1, materialId: 'm1' }
    const session = { c1: { active: false, materialIds: ['m1'], conceptIds: [], completedMaterialIds: ['m1'], startedAt: '', quickTests: [{ id: 't', scope: 'current' as const, questionCount: 1, generatedAt: '2026-07-13T00:00:00.000Z', status: 'completed' as const, score: 0, answers: { q: 1 }, questions: [{ id: 'q', prompt: '', options: ['A', 'B'], correctIndex: 0, explanation: '', materialIds: ['m1'], conceptIds: [] }] }] } }
    expect(reviewQueueProgress(item, session)).toEqual({ stage: 'not_started', label: '未复习' })
  })

  it('opens a material queue task in isolation instead of carrying its concept or previous selection', () => {
    expect(selectionForReviewQueueItem({ id: 'test-error:t:q', courseId: 'c1', courseName: '课程', title: '资料', reason: '测试错误', priority: 1, materialId: 'm1', conceptId: 'k1' })).toEqual({ materialIds: ['m1'], conceptIds: [], focus: '', mode: 'manual' })
    expect(selectionForReviewQueueItem({ id: 'concept:k1', courseId: 'c1', courseName: '课程', title: '知识点', reason: '自评陌生', priority: 1, materialId: 'm1', conceptId: 'k1' })).toEqual({ materialIds: [], conceptIds: ['k1'], focus: '', mode: 'manual' })
  })
})
