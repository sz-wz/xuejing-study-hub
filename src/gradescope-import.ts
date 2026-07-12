import type { Assignment, Course } from './types'

export type GradescopeCourse = { name: string; term: string; url: string }
export type GradescopeAssignment = {
  courseName: string
  term: string
  title: string
  url: string
  meta: string
  dueAt?: string
  status: 'unknown' | 'not_submitted' | 'submitted' | 'graded'
  score?: number
  maxScore?: number
}

const courseColors = ['#336a58', '#bf6a48', '#6a5f9e', '#3d7890', '#8a6a3d', '#a35e79']

function normalized(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function stableId(prefix: string, value: string) {
  let hash = 5381
  for (const character of value) hash = (hash * 33) ^ character.codePointAt(0)!
  return `${prefix}-${(hash >>> 0).toString(36)}`
}

function courseCode(name: string) {
  return name.match(/[A-Za-z]{2,8}\s*[-_.]?[0-9]{2,5}[A-Za-z]?(?:\.[0-9]+)?/)?.[0]?.replace(/\s+/g, '') ?? 'GRADESCOPE'
}

function courseKey(name: string) {
  const match = name.match(/[A-Za-z]{2,8}\s*[-_.]?[0-9]{2,5}[A-Za-z]?/)
  return match ? match[0].replace(/[\s_.-]/g, '').toLocaleLowerCase() : ''
}

function matchingCourse(courses: Course[], remoteName: string) {
  const exactName = normalized(remoteName)
  const exact = courses.find((course) => normalized(course.name) === exactName)
  if (exact) return exact
  const key = courseKey(remoteName)
  return key ? courses.find((course) => courseKey(course.code) === key || courseKey(course.name) === key) : undefined
}

export function mergeGradescopeCourses(existing: Course[], remote: GradescopeCourse[]) {
  const unique = new Map<string, GradescopeCourse>()
  for (const course of remote) {
    const key = normalized(course.name)
    if (key) unique.set(key, course)
  }
  const courses = existing.map((course) => {
    const hasMatchingRemote = [...unique.values()].some((remote) => matchingCourse([course], remote.name))
    if (!hasMatchingRemote || course.sources.includes('Gradescope')) return course
    return { ...course, sources: [...course.sources, 'Gradescope' as const] }
  })
  const names = new Set(courses.map((course) => normalized(course.name)))
  for (const course of unique.values()) {
    if (names.has(normalized(course.name)) || matchingCourse(courses, course.name)) continue
    courses.push({
      id: stableId('gradescope-course', course.name),
      code: courseCode(course.name),
      name: course.name,
      instructor: '',
      color: courseColors[courses.length % courseColors.length],
      sources: ['Gradescope'],
    })
  }
  return { courses }
}

export function mergeGradescopeAssignments(existing: Assignment[], courses: Course[], remote: GradescopeAssignment[]) {
  const now = new Date().toISOString()
  const incoming: Assignment[] = remote.flatMap((assignment) => {
    const course = matchingCourse(courses, assignment.courseName)
    if (!course) return []
    return [{
      id: stableId('gradescope-assignment', assignment.url),
      courseId: course.id,
      source: 'Gradescope',
      sourceCourseName: assignment.courseName,
      term: assignment.term || '未分期',
      title: assignment.title,
      url: assignment.url,
      dueAt: assignment.dueAt,
      dueLabel: assignment.meta || 'Gradescope 作业',
      status: assignment.status,
      score: assignment.score,
      maxScore: assignment.maxScore,
      lastSyncedAt: now,
    }]
  })
  const incomingIds = new Set(incoming.map((item) => item.id))
  const courseIdsWithAssignments = new Set(incoming.map((item) => item.courseId))
  const previous = new Map(existing.map((item) => [item.id, item]))
  const refreshed = incoming.map((item) => {
    const existing = previous.get(item.id)
    return {
      ...item,
      manualStatus: existing?.manualStatus,
      manualDueAt: existing?.manualDueAt,
      detailsText: existing?.detailsText,
      detailsFetchedAt: existing?.detailsFetchedAt,
      manualKnowledgeIds: existing?.manualKnowledgeIds,
      aiKnowledge: existing?.aiKnowledge,
      reflection: existing?.reflection,
      files: existing?.files,
    }
  })
  const retained = existing.filter((item) => !incomingIds.has(item.id) && (item.source !== 'Gradescope' || !courseIdsWithAssignments.has(item.courseId)))
  return { assignments: [...refreshed, ...retained] }
}
