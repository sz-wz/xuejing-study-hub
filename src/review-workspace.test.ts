import { describe, expect, it } from 'vitest'
import { buildRoute, createReviewSession, extractPlan, finishReviewSession, originalFilename, recordMaterialAssessment, selectedFirst, type ReviewConcept, type ReviewDocument, type ReviewSession } from './review-workspace'

describe('extractPlan', () => {
  it('兼容 AI 省略知识点和资料 ID 前缀的返回结果', () => {
    const concepts: ReviewConcept[] = [{ id: 'concept-a1b2c3', title: '卷积基本性质', sourceIds: ['bb-material-file123'], courseIds: ['course-1'] }]
    const documents: ReviewDocument[] = [{ materialId: 'bb-material-file123', title: 'lecture-01.pdf', courseId: 'course-1', courseName: '信号与系统', localPath: 'D:\\vault\\lecture-01.pdf', type: 'pdf', status: 'parsed' }]

    expect(extractPlan('{"conceptIds":["a1b2c3"],"materialIds":["file123"],"explanation":"先复习卷积"}', documents, concepts)).toEqual({
      conceptIds: ['concept-a1b2c3'],
      materialIds: ['bb-material-file123'],
      explanation: '先复习卷积',
    })
  })
})

describe('selectedFirst', () => {
  it('将已选择的资料按选择顺序置顶，其余内容保持原始顺序', () => {
    const materials = [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]
    expect(selectedFirst(materials, ['c', 'a'], (material) => material.id).map((material) => material.id)).toEqual(['c', 'a', 'b', 'd'])
  })
})

describe('originalFilename', () => {
  it('优先显示资料的逻辑标题，而不是资料库为防覆盖生成的导入版本文件名', () => {
    expect(originalFilename({ materialId: 'a', title: 'Lecture 1.pdf', courseId: 'course-1', courseName: '课程', localPath: 'D:\\vault\\Lecture 1（导入版本 2026-07-13）.pdf', type: 'pdf', status: 'parsed' })).toBe('Lecture 1.pdf')
  })
})

describe('buildRoute', () => {
  const concepts: ReviewConcept[] = [
    { id: 'concept-a', title: '知识点 A', sourceIds: ['material-a'], courseIds: ['course-1'] },
    { id: 'concept-b', title: '知识点 B', sourceIds: ['material-b'], courseIds: ['course-1'] },
  ]
  const documents: ReviewDocument[] = [
    { materialId: 'material-a', title: 'A.pdf', courseId: 'course-1', courseName: '课程', localPath: 'D:\\vault\\A.pdf', type: 'pdf', status: 'parsed' },
    { materialId: 'material-b', title: 'B.pdf', courseId: 'course-1', courseName: '课程', localPath: 'D:\\vault\\B.pdf', type: 'pdf', status: 'parsed' },
  ]
  const emptySelection = { materialIds: [], conceptIds: [], focus: '' }

  it('自选模式空选时不回退为系统推荐内容', () => {
    expect(buildRoute(documents, concepts, {}, emptySelection, true)).toEqual({ concepts: [], documents: [] })
  })

  it('自选模式仅选择资料时不自动加入知识点', () => {
    expect(buildRoute(documents, concepts, {}, { ...emptySelection, materialIds: ['material-b'] }, true)).toEqual({
      concepts: [],
      documents: [documents[1]],
    })
  })

  it('系统规划模式仍根据自评生成推荐路线', () => {
    expect(buildRoute(documents, concepts, { 'concept-b': 4 }, emptySelection, false)).toEqual({
      concepts: [concepts[0], concepts[1]],
      documents,
    })
  })

  it('系统规划优先陌生和模糊知识点，不让全部未评估内容淹没队列', () => {
    expect(buildRoute(documents, concepts, { 'concept-a': 0, 'concept-b': 1 }, emptySelection, false).concepts.map((concept) => concept.id)).toEqual(['concept-b', 'concept-a'])
  })
})

describe('recordMaterialAssessment', () => {
  it('records a low-friction document assessment without changing completion or concept selection', () => {
    const session: ReviewSession = { active: true, materialIds: ['a'], conceptIds: ['c'], completedMaterialIds: ['a'], startedAt: '2026-07-13T00:00:00.000Z' }
    expect(recordMaterialAssessment(session, 'a', 3, '2026-07-13T01:00:00.000Z')).toEqual({ ...session, materialAssessments: { a: 3 }, materialAssessmentAt: { a: '2026-07-13T01:00:00.000Z' } })
  })
})

describe('finishReviewSession', () => {
  it('preserves progress and stores the exit assessment instead of deleting the session', () => {
    const session: ReviewSession = { active: true, materialIds: ['a'], conceptIds: ['c'], completedMaterialIds: [], startedAt: '2026-07-13T00:00:00.000Z' }
    expect(finishReviewSession(session, 'a', 2, '2026-07-13T01:00:00.000Z')).toEqual({ ...session, active: false, completedMaterialIds: ['a'], materialAssessments: { a: 2 }, materialAssessmentAt: { a: '2026-07-13T01:00:00.000Z' } })
  })

  it('allows ending without forcing an assessment', () => {
    const session: ReviewSession = { active: true, materialIds: ['a'], conceptIds: [], completedMaterialIds: [], startedAt: '2026-07-13T00:00:00.000Z' }
    expect(finishReviewSession(session)).toEqual({ ...session, active: false })
  })
})

describe('createReviewSession', () => {
  it('uses the newly selected content while preserving historical evidence', () => {
    const previous: ReviewSession = { active: false, materialIds: ['old'], conceptIds: ['old-concept'], completedMaterialIds: ['old'], materialAssessments: { old: 2 }, quickTests: [], startedAt: 'old' }
    const next = createReviewSession(['new'], ['new-concept'], previous)
    expect(next).toMatchObject({ active: true, materialIds: ['new'], conceptIds: ['new-concept'], activeDocumentId: 'new', completedMaterialIds: [], materialAssessments: { old: 2 }, materialAssessmentAt: {} })
  })
})
