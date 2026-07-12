import type { Course } from './types'

export type BlackboardCourse = {
  name: string
  url: string
}

export type BlackboardImport = {
  courses: Course[]
  added: Course[]
  refreshed: number
}

const courseColors = ['#336a58', '#bf6a48', '#6a5f9e', '#3d7890', '#8a6a3d', '#a35e79']

function normalizeCourseName(name: string) {
  return name.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function stableCourseId(name: string) {
  let hash = 5381
  for (const character of name) hash = (hash * 33) ^ character.codePointAt(0)!
  return `bb-${(hash >>> 0).toString(36)}`
}

function courseCode(name: string) {
  return name.match(/[A-Za-z]{2,8}\s*[-_]?[0-9]{2,5}/)?.[0]?.replace(/\s+/g, '') ?? 'BLACKBOARD'
}

export function mergeBlackboardCourses(existing: Course[], remote: BlackboardCourse[]): BlackboardImport {
  const seen = new Set<string>()
  const remoteByName = new Map<string, BlackboardCourse>()
  for (const course of remote) {
    const normalized = normalizeCourseName(course.name)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    remoteByName.set(normalized, course)
  }

  let refreshed = 0
  const retained: Course[] = existing.map((course) => {
    if (!remoteByName.has(normalizeCourseName(course.name))) return course
    refreshed += 1
    return course.sources.includes('Blackboard') ? course : { ...course, sources: [...course.sources, 'Blackboard' as const] }
  })

  const existingNames = new Set(retained.map((course) => normalizeCourseName(course.name)))
  const added: Course[] = []
  for (const [normalized, course] of remoteByName) {
    if (existingNames.has(normalized)) continue
    const color = courseColors[(retained.length + added.length) % courseColors.length]
    added.push({
      id: stableCourseId(course.name),
      code: courseCode(course.name),
      name: course.name,
      instructor: '',
      color,
      sources: ['Blackboard'],
    })
  }

  return { courses: [...retained, ...added], added, refreshed }
}
