import { describe, expect, it } from 'vitest'
import { activeCourseIds, completeCourse, courseIsActive, reopenCourse } from './course-lifecycle'
import type { Course } from './types'
import type { ReviewScheduleEntry } from './review-queue'
import type { ReviewSession } from './review-workspace'

const courses: Course[] = [
  { id: 'course-a', code: 'A', name: '课程 A', instructor: '', color: '#000', sources: ['手动添加'] },
  { id: 'course-b', code: 'B', name: '课程 B', instructor: '', color: '#111', sources: ['Blackboard'], studyStatus: 'completed', completedAt: '2026-07-01T00:00:00.000Z' },
]

const schedule: ReviewScheduleEntry[] = [
  { id: 'past-a', courseId: 'course-a', courseName: '课程 A', title: '过去任务', materialId: 'a1', scheduledDate: '2026-07-10', createdAt: '2026-07-01T00:00:00.000Z' },
  { id: 'future-a', courseId: 'course-a', courseName: '课程 A', title: '未来任务', materialId: 'a2', scheduledDate: '2026-07-20', createdAt: '2026-07-01T00:00:00.000Z' },
  { id: 'future-b', courseId: 'course-b', courseName: '课程 B', title: '其他课程任务', materialId: 'b1', scheduledDate: '2026-07-20', createdAt: '2026-07-01T00:00:00.000Z' },
]

const activeSession: ReviewSession = {
  active: true,
  startedAt: '2026-07-12T00:00:00.000Z',
  materialIds: ['a1'],
  conceptIds: [],
  completedMaterialIds: [],
  materialAssessments: {},
}

describe('课程生命周期', () => {
  it('旧数据缺少状态时默认视为进行中', () => {
    expect(courseIsActive(courses[0])).toBe(true)
    expect(activeCourseIds(courses)).toEqual(new Set(['course-a']))
  })

  it('结课保留课程与历史，只结束活动会话', () => {
    const result = completeCourse(courses, schedule, { 'course-a': activeSession }, 'course-a', {
      removeFutureManualSchedule: false,
      today: '2026-07-13',
      completedAt: '2026-07-13T08:00:00.000Z',
    })

    expect(result.courses[0]).toMatchObject({ id: 'course-a', studyStatus: 'completed', completedAt: '2026-07-13T08:00:00.000Z' })
    expect(result.reviewSchedule).toEqual(schedule)
    expect(result.reviewSessions['course-a']).toMatchObject({ active: false, endedAt: '2026-07-13T08:00:00.000Z', materialIds: ['a1'] })
  })

  it('可选移除目标课程今天及未来的手动日程，不影响过去记录与其他课程', () => {
    const result = completeCourse(courses, schedule, {}, 'course-a', {
      removeFutureManualSchedule: true,
      today: '2026-07-13',
      completedAt: '2026-07-13T08:00:00.000Z',
    })

    expect(result.reviewSchedule.map((entry) => entry.id)).toEqual(['past-a', 'future-b'])
  })

  it('重新开课恢复自动安排资格但不重建已删除日程', () => {
    const reopened = reopenCourse(courses, 'course-b')
    expect(reopened[1]).toMatchObject({ id: 'course-b', studyStatus: 'active' })
    expect(reopened[1].completedAt).toBeUndefined()
  })
})
