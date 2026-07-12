import type { Assignment, Course } from './types'

export type BlackboardAssignment = { courseName: string; title: string; url: string; meta: string; dueAt?: string; status?: 'unknown' | 'not_submitted' | 'submitted' | 'graded'; score?: number; maxScore?: number }

function normalized(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function stableId(value: string) {
  let hash = 5381
  for (const character of value) hash = (hash * 33) ^ character.codePointAt(0)!
  return `blackboard-assignment-${(hash >>> 0).toString(36)}`
}

export function mergeBlackboardAssignments(existing: Assignment[], courses: Course[], remote: BlackboardAssignment[]) {
  const courseIds = new Map(courses.map((course) => [normalized(course.name), course.id]))
  const now = new Date().toISOString()
  const incoming: Assignment[] = remote.flatMap((assignment) => {
    const courseId = courseIds.get(normalized(assignment.courseName))
    if (!courseId) return []
    return [{
      id: stableId(assignment.url),
      courseId,
      source: 'Blackboard',
      sourceCourseName: assignment.courseName,
      term: 'Blackboard',
      title: assignment.title,
      url: assignment.url,
      dueAt: assignment.dueAt,
      dueLabel: assignment.meta || 'Blackboard 作业',
      status: assignment.status ?? 'unknown',
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
  const retained = existing.filter((item) => !incomingIds.has(item.id) && (item.source !== 'Blackboard' || !courseIdsWithAssignments.has(item.courseId)))
  return { assignments: [...refreshed, ...retained] }
}
