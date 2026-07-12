import { describe, expect, it } from 'vitest'
import { mergeBlackboardAssignments } from './blackboard-assignment-import'

describe('Blackboard 作业导入', () => {
  it('将 Blackboard 作业从课程资料中迁入独立任务列表', () => {
    const courses = [{ id: 'ee150', code: 'EE150', name: '信号与系统', instructor: '', color: '#336a58', sources: ['Blackboard' as const] }]
    const result = mergeBlackboardAssignments([], courses, [{ courseName: '信号与系统', title: 'Homework 1', url: 'https://elearning.example.edu/webapps/assignment?id=1', meta: 'Blackboard 作业' }])

    expect(result.assignments[0]).toMatchObject({ source: 'Blackboard', courseId: 'ee150', title: 'Homework 1', status: 'unknown', term: 'Blackboard' })
  })

  it('刷新 Blackboard 同步时保留学生填写的作业复盘', () => {
    const courses = [{ id: 'ee150', code: 'EE150', name: '信号与系统', instructor: '', color: '#336a58', sources: ['Blackboard' as const] }]
    const remote = [{ courseName: '信号与系统', title: 'Homework 1', url: 'https://elearning.example.edu/webapps/assignment?id=1', meta: 'Blackboard 作业' }]
    const initial = mergeBlackboardAssignments([], courses, remote).assignments[0]
    const result = mergeBlackboardAssignments([{ ...initial, reflection: { score: 19, maxScore: 20, feedback: '注意边界条件。', selfAssessment: 'uncertain', updatedAt: '2026-07-13T00:00:00.000Z' } }], courses, remote)

    expect(result.assignments[0].reflection).toMatchObject({ score: 19, feedback: '注意边界条件。', selfAssessment: 'uncertain' })
  })
})
