import type { Assignment, Course, Material } from './types'
import type { ReviewScheduleEntry } from './review-queue'
import type { ReviewSession } from './review-workspace'

export type GlobalSearchKind = 'command' | 'course' | 'material' | 'concept' | 'assignment' | 'review'

export type SearchCommand = {
  id: string
  title: string
  subtitle: string
  keywords?: string
  shortcut?: string
}

export type GlobalSearchEntry = {
  id: string
  kind: GlobalSearchKind
  title: string
  subtitle: string
  keywords: string
  shortcut?: string
  commandId?: string
  courseId?: string
  materialId?: string
  assignmentId?: string
  conceptId?: string
  completedCourse?: boolean
  score?: number
  bodySnippet?: string
}

export type SearchConcept = { id: string; title: string; courseIds: string[]; sourceIds: string[] }
export type BodySearchResult = { materialId: string; title: string; courseId: string; courseName: string; snippet: string; score: number }

function normalized(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

export function buildGlobalSearchEntries(input: {
  courses: Course[]
  materials: Material[]
  assignments: Assignment[]
  concepts: SearchConcept[]
  reviewSessions: Record<string, ReviewSession>
  reviewSchedule: ReviewScheduleEntry[]
  commands: SearchCommand[]
}) {
  const courseNames = new Map(input.courses.map((course) => [course.id, course.name]))
  const completed = new Set(input.courses.filter((course) => course.studyStatus === 'completed').map((course) => course.id))
  const entries: GlobalSearchEntry[] = input.commands.map((command) => ({ id: `command:${command.id}`, kind: 'command', title: command.title, subtitle: command.subtitle, keywords: command.keywords ?? '', shortcut: command.shortcut, commandId: command.id }))

  for (const course of input.courses) entries.push({ id: `course:${course.id}`, kind: 'course', title: course.name, subtitle: `${course.code || '未设置课程代码'} · ${course.sources.join(' · ')}${course.studyStatus === 'completed' ? ' · 已结课' : ''}`, keywords: `${course.code} ${course.instructor} ${course.sources.join(' ')}`, courseId: course.id, completedCourse: course.studyStatus === 'completed' })
  for (const material of input.materials) entries.push({ id: `material:${material.id}`, kind: 'material', title: material.title, subtitle: `${courseNames.get(material.courseId) ?? '未分类课程'} · ${material.kind === 'folder' ? '文件夹' : material.type} · ${material.source}${completed.has(material.courseId) ? ' · 已结课' : ''}`, keywords: `${material.path?.join(' ') ?? ''} ${material.folder ?? ''} ${material.meta} ${material.concepts.join(' ')}`, courseId: material.courseId, materialId: material.id, completedCourse: completed.has(material.courseId) })
  for (const concept of input.concepts) entries.push({ id: `concept:${concept.id}`, kind: 'concept', title: concept.title, subtitle: `${concept.courseIds.map((id) => courseNames.get(id)).filter(Boolean).join(' · ') || '未分类课程'} · ${concept.sourceIds.length} 份来源资料`, keywords: concept.courseIds.map((id) => courseNames.get(id) ?? '').join(' '), courseId: concept.courseIds[0], conceptId: concept.id, completedCourse: Boolean(concept.courseIds.length) && concept.courseIds.every((id) => completed.has(id)) })
  for (const assignment of input.assignments) entries.push({ id: `assignment:${assignment.id}`, kind: 'assignment', title: assignment.title, subtitle: `${courseNames.get(assignment.courseId) ?? assignment.sourceCourseName} · ${assignment.source} · ${assignment.dueLabel ?? '未设置 DDL'}`, keywords: `${assignment.sourceCourseName} ${assignment.term} ${assignment.detailsText ?? ''}`, courseId: assignment.courseId, assignmentId: assignment.id, completedCourse: completed.has(assignment.courseId) })
  for (const schedule of input.reviewSchedule) entries.push({ id: `review-schedule:${schedule.id}`, kind: 'review', title: schedule.title, subtitle: `${schedule.courseName} · 计划 ${schedule.scheduledDate} 复习`, keywords: '复习日程 计划 安排', courseId: schedule.courseId, materialId: schedule.materialId, conceptId: schedule.conceptId, completedCourse: completed.has(schedule.courseId) })
  for (const [courseId, session] of Object.entries(input.reviewSessions)) {
    const courseName = courseNames.get(courseId) ?? '未分类课程'
    entries.push({ id: `review-session:${courseId}`, kind: 'review', title: `${courseName}复习会话`, subtitle: `${session.active ? '进行中' : '已保存'} · ${session.completedMaterialIds.length}/${session.materialIds.length} 份资料完成`, keywords: '复习会话 进度 继续', courseId, completedCourse: completed.has(courseId) })
    for (const test of session.quickTests ?? []) {
      if (test.status !== 'completed') continue
      entries.push({ id: `quick-test:${courseId}:${test.id}`, kind: 'review', title: `${courseName}快速测试 ${test.score ?? 0}%`, subtitle: `${new Date(test.generatedAt).toLocaleDateString()} · ${test.questions.length} 道题`, keywords: '快速测试 测试记录 正确率', courseId, completedCourse: completed.has(courseId) })
    }
  }
  return entries
}

export function searchGlobalEntries(entries: GlobalSearchEntry[], query: string, limit = 36) {
  const commandOnly = query.trim().startsWith('>')
  const text = normalized(commandOnly ? query.trim().slice(1) : query)
  if (!text) return entries.filter((entry) => entry.kind === 'command').slice(0, limit)
  const tokens = text.split(' ').filter(Boolean)
  return entries.flatMap((entry) => {
    if (commandOnly && entry.kind !== 'command') return []
    const title = normalized(entry.title)
    const subtitle = normalized(entry.subtitle)
    const keywords = normalized(entry.keywords)
    const haystack = `${title} ${subtitle} ${keywords}`
    if (!tokens.every((token) => haystack.includes(token))) return []
    let score = entry.kind === 'command' ? 8 : 0
    if (title === text) score += 160
    else if (title.startsWith(text)) score += 120
    else if (title.includes(text)) score += 90
    score += tokens.reduce((sum, token) => sum + (title.includes(token) ? 20 : subtitle.includes(token) ? 10 : 4), 0)
    return [{ ...entry, score }]
  }).sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.title.localeCompare(right.title, 'zh-CN')).slice(0, limit)
}

export function mergeBodySearchResults(localResults: GlobalSearchEntry[], bodyResults: BodySearchResult[], materialEntries: GlobalSearchEntry[], limit = 36) {
  const result = [...localResults]
  const byMaterial = new Map(materialEntries.filter((entry) => entry.materialId).map((entry) => [entry.materialId!, entry]))
  for (const body of bodyResults) {
    const existingIndex = result.findIndex((entry) => entry.materialId === body.materialId)
    if (existingIndex >= 0) {
      result[existingIndex] = { ...result[existingIndex], bodySnippet: body.snippet, score: Math.max(result[existingIndex].score ?? 0, body.score) }
      continue
    }
    const metadata = byMaterial.get(body.materialId)
    if (metadata) result.push({ ...metadata, bodySnippet: body.snippet, score: body.score })
  }
  return result.sort((left, right) => (right.score ?? 0) - (left.score ?? 0) || left.title.localeCompare(right.title, 'zh-CN')).slice(0, limit)
}

export function resolveAppShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey'>, typing = false) {
  if (!event.ctrlKey && !event.metaKey) return null
  const key = event.key.toLocaleLowerCase()
  if ((key === 'k' && !event.shiftKey && !event.altKey) || (key === 'p' && event.shiftKey && !event.altKey)) return 'command-center'
  if (typing) return null
  if (!event.shiftKey && !event.altKey && /^[0-9]$/.test(key)) return `nav-${key}`
  if (!event.shiftKey && !event.altKey && key === ',') return 'nav-settings'
  if (event.shiftKey && !event.altKey && key === 'b') return 'sync-blackboard'
  if (event.shiftKey && !event.altKey && key === 'g') return 'sync-gradescope'
  if (event.shiftKey && !event.altKey && key === 'i') return 'import-materials'
  if (event.shiftKey && !event.altKey && key === 'k') return 'build-knowledge'
  if (event.altKey && !event.shiftKey && key === 'p') return 'toggle-focus'
  if (event.altKey && !event.shiftKey && key === 'a') return 'add-assignment'
  return null
}
