import type { Course } from './types'
import type { ReviewScheduleEntry } from './review-queue'
import type { ReviewSession } from './review-workspace'

export function courseIsActive(course: Pick<Course, 'studyStatus'>) {
  return course.studyStatus !== 'completed'
}

export function activeCourseIds(courses: Course[]) {
  return new Set(courses.filter(courseIsActive).map((course) => course.id))
}

export function completeCourse(
  courses: Course[],
  reviewSchedule: ReviewScheduleEntry[],
  reviewSessions: Record<string, ReviewSession>,
  courseId: string,
  options: { removeFutureManualSchedule: boolean; today: string; completedAt?: string },
) {
  const completedAt = options.completedAt ?? new Date().toISOString()
  const nextCourses = courses.map((course) => course.id === courseId ? { ...course, studyStatus: 'completed' as const, completedAt } : course)
  const nextSchedule = options.removeFutureManualSchedule
    ? reviewSchedule.filter((entry) => entry.courseId !== courseId || entry.scheduledDate < options.today)
    : reviewSchedule
  const session = reviewSessions[courseId]
  const nextSessions = session?.active
    ? { ...reviewSessions, [courseId]: { ...session, active: false, endedAt: completedAt } }
    : reviewSessions
  return { courses: nextCourses, reviewSchedule: nextSchedule, reviewSessions: nextSessions }
}

export function reopenCourse(courses: Course[], courseId: string) {
  return courses.map((course) => {
    if (course.id !== courseId) return course
    const { completedAt: _completedAt, ...rest } = course
    return { ...rest, studyStatus: 'active' as const }
  })
}
