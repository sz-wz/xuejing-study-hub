import { describe, expect, it } from 'vitest'
import { mergeGradescopeAssignments, mergeGradescopeCourses } from './gradescope-import'
import type { Course } from './types'

describe('Gradescope 导入', () => {
  const baseCourse: Course = { id: 'bb-ee150', code: 'EE150', name: '信号与系统 EE150 2025-2026学年春季学期', instructor: '', color: '#336a58', sources: ['Blackboard'] }
  const remoteCourse = { name: 'EE150.02', term: 'Spring 2026', url: 'https://www.gradescope.com/courses/1272330' }
  const remoteAssignment = { courseName: 'EE150.02', term: 'Spring 2026', title: 'HW8', url: 'https://www.gradescope.com/courses/1272330/assignments/888001', meta: 'Due Jul 25 at 11:59PM', dueAt: '2026-07-25T23:59:00+08:00', status: 'graded' as const, score: 100, maxScore: 100 }

  it('将成绩、截止时间与平台课程名写入独立作业记录', () => {
    const courseResult = mergeGradescopeCourses([baseCourse], [remoteCourse])
    const assignmentResult = mergeGradescopeAssignments([], courseResult.courses, [remoteAssignment])

    expect(courseResult.courses[0]).toMatchObject({ id: 'bb-ee150', sources: ['Blackboard', 'Gradescope'] })
    expect(assignmentResult.assignments[0]).toMatchObject({
      courseId: 'bb-ee150', sourceCourseName: 'EE150.02', term: 'Spring 2026', title: 'HW8', status: 'graded', score: 100,
    })
  })

  it('刷新同步时保留学生手动标记的完成状态', () => {
    const courseResult = mergeGradescopeCourses([baseCourse], [remoteCourse])
    const initial = mergeGradescopeAssignments([], courseResult.courses, [remoteAssignment]).assignments[0]
    const existing = [{ ...initial, status: 'unknown' as const, manualStatus: 'completed' as const }]
    const result = mergeGradescopeAssignments(existing, courseResult.courses, [{ ...remoteAssignment, status: 'submitted' }])

    expect(result.assignments[0]).toMatchObject({ status: 'submitted', manualStatus: 'completed' })
  })

  it('刷新同步时保留已读取的题目说明和手动知识点映射', () => {
    const courseResult = mergeGradescopeCourses([baseCourse], [remoteCourse])
    const initial = mergeGradescopeAssignments([], courseResult.courses, [remoteAssignment]).assignments[0]
    const existing = [{ ...initial, detailsText: 'Use the Fourier transform.', detailsFetchedAt: '2026-07-13T12:00:00.000Z', manualKnowledgeIds: ['concept-fourier'], aiKnowledge: { conceptIds: ['concept-fourier'], explanation: '题目涉及傅里叶变换。', model: 'test-model', generatedAt: '2026-07-13T12:00:00.000Z', sourceKey: 'test-key' }, reflection: { score: 88, maxScore: 100, selfAssessment: 'needs_review' as const, updatedAt: '2026-07-13T12:00:00.000Z' }, files: [{ id: 'file-hw', title: 'HW8.pdf', type: 'PDF' as const, localPath: 'C:\\vault\\HW8.pdf', addedAt: '2026-07-13T12:00:00.000Z' }] }]
    const result = mergeGradescopeAssignments(existing, courseResult.courses, [remoteAssignment])

    expect(result.assignments[0]).toMatchObject({ detailsText: 'Use the Fourier transform.', manualKnowledgeIds: ['concept-fourier'], aiKnowledge: { conceptIds: ['concept-fourier'], model: 'test-model' }, reflection: { score: 88, selfAssessment: 'needs_review' }, files: [{ id: 'file-hw', title: 'HW8.pdf' }] })
  })
})
