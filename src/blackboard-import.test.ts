import { describe, expect, it } from 'vitest'
import { mergeBlackboardCourses } from './blackboard-import'
import type { Course } from './types'

const existing: Course[] = [
  { id: 'manual-1', code: 'MATH101', name: '数学基础', instructor: '', color: '#336a58', sources: ['手动添加'] },
]

describe('mergeBlackboardCourses', () => {
  it('将 Blackboard 同步结果加入学生可见的课程列表，同时保留已有课程', () => {
    const result = mergeBlackboardCourses(existing, [
      { name: 'CS101 · Introduction to Programming', url: 'https://elearning.example.edu/course/cs101' },
    ])

    expect(result.added).toHaveLength(1)
    expect(result.courses).toHaveLength(2)
    expect(result.courses[1]).toMatchObject({
      name: 'CS101 · Introduction to Programming',
      sources: ['Blackboard'],
    })
  })

  it('再次同步不会覆盖学生设置的结课状态', () => {
    const completed: Course[] = [{ ...existing[0], sources: ['手动添加', 'Blackboard'], studyStatus: 'completed', completedAt: '2026-07-13T08:00:00.000Z' }]
    const result = mergeBlackboardCourses(completed, [{ name: '数学基础', url: 'https://elearning.example.edu/course/math101' }])

    expect(result.courses[0]).toMatchObject({ studyStatus: 'completed', completedAt: '2026-07-13T08:00:00.000Z' })
  })
})
