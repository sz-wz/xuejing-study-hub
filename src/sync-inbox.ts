import type { Assignment, Course, Material, Source } from './types'

export type SyncInboxKind = 'sync_summary' | 'course_added' | 'material_added' | 'material_batch_added' | 'assignment_added' | 'deadline_changed' | 'assignment_status_changed' | 'score_changed' | 'connection_required' | 'email_sent' | 'email_failed'
export type SyncInboxSource = Extract<Source, 'Blackboard' | 'Gradescope'> | 'Email'

export type SyncInboxItem = {
  id: string
  kind: SyncInboxKind
  source: SyncInboxSource
  courseId?: string
  materialId?: string
  assignmentId?: string
  title: string
  detail: string
  createdAt: string
  readAt?: string
  archivedAt?: string
}

type Snapshot = { courses: Course[]; materials: Material[]; assignments: Assignment[] }

function stableId(value: string) {
  let hash = 5381
  for (const character of value) hash = (hash * 33) ^ character.codePointAt(0)!
  return `sync-event-${(hash >>> 0).toString(36)}`
}

function event(source: SyncInboxSource, kind: SyncInboxKind, entityId: string, value: string, fields: Omit<SyncInboxItem, 'id' | 'kind' | 'source' | 'createdAt'>, now: string): SyncInboxItem {
  return { id: stableId(`${source}|${kind}|${entityId}|${value}`), source, kind, createdAt: now, ...fields }
}

function dueText(value?: string) {
  if (!value) return '未提供截止时间'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN', { hour12: false })
}

const statusLabels: Record<Assignment['status'], string> = {
  unknown: '待确认',
  not_submitted: '未提交',
  submitted: '已提交',
  graded: '已批改',
}

export function detectSyncChanges(before: Snapshot, after: Snapshot, source: Extract<SyncInboxSource, 'Blackboard' | 'Gradescope'>, now = new Date().toISOString()) {
  const hadSourceBaseline = before.courses.some((item) => item.sources.includes(source)) || before.materials.some((item) => item.source === source) || before.assignments.some((item) => item.source === source)
  if (!hadSourceBaseline) {
    const courses = after.courses.filter((item) => item.sources.includes(source))
    const materials = after.materials.filter((item) => item.source === source && item.kind !== 'folder')
    const assignments = after.assignments.filter((item) => item.source === source)
    if (!courses.length && !materials.length && !assignments.length) return []
    const detail = `${source} 首次同步完成：${courses.length} 门课程、${materials.length} 份资料、${assignments.length} 项作业。历史内容已作为初始基线导入，后续新增和变化才会单独提醒。`
    return [event(source, 'sync_summary', source, `${courses.length}|${materials.length}|${assignments.length}`, { title: `${source} 首次同步完成`, detail }, now)]
  }
  const changes: SyncInboxItem[] = []
  const previousCourses = new Map(before.courses.map((item) => [item.id, item]))
  const previousMaterials = new Map(before.materials.map((item) => [item.id, item]))
  const previousAssignments = new Map(before.assignments.map((item) => [item.id, item]))
  const courseNames = new Map(after.courses.map((item) => [item.id, item.name]))

  for (const course of after.courses) {
    if (!course.sources.includes(source) || previousCourses.has(course.id)) continue
    changes.push(event(source, 'course_added', course.id, course.name, { courseId: course.id, title: '发现新课程', detail: course.name }, now))
  }

  const addedMaterials = after.materials.filter((material) => material.source === source && !previousMaterials.has(material.id) && material.kind !== 'folder')
  const materialsByCourse = new Map<string, Material[]>()
  for (const material of addedMaterials) {
    const grouped = materialsByCourse.get(material.courseId) ?? []
    grouped.push(material)
    materialsByCourse.set(material.courseId, grouped)
  }
  for (const [courseId, materials] of materialsByCourse) {
    const courseName = courseNames.get(courseId) ?? '未知课程'
    if (materials.length === 1) {
      const material = materials[0]
      changes.push(event(source, 'material_added', material.id, material.url ?? material.title, { courseId, materialId: material.id, title: '发现新课程资料', detail: `${courseName} · ${material.title}` }, now))
      continue
    }
    const examples = materials.slice(0, 3).map((item) => item.title).join('、')
    const remaining = materials.length > 3 ? ` 等 ${materials.length} 份` : ''
    changes.push(event(source, 'material_batch_added', courseId, materials.map((item) => item.id).sort().join('|'), { courseId, title: `${courseName} 资料已更新`, detail: `${courseName} · 新增 ${materials.length} 份资料：${examples}${remaining}` }, now))
  }

  for (const assignment of after.assignments) {
    if (assignment.source !== source) continue
    const previous = previousAssignments.get(assignment.id)
    const courseName = courseNames.get(assignment.courseId) ?? assignment.sourceCourseName
    if (!previous) {
      changes.push(event(source, 'assignment_added', assignment.id, `${assignment.title}|${assignment.dueAt ?? ''}`, { courseId: assignment.courseId, assignmentId: assignment.id, title: '发现新作业', detail: `${courseName} · ${assignment.title}${assignment.dueAt ? ` · DDL ${dueText(assignment.dueAt)}` : ''}` }, now))
      continue
    }
    if ((previous.dueAt ?? '') !== (assignment.dueAt ?? '')) {
      changes.push(event(source, 'deadline_changed', assignment.id, assignment.dueAt ?? 'none', { courseId: assignment.courseId, assignmentId: assignment.id, title: '作业 DDL 已更新', detail: `${courseName} · ${assignment.title}：${dueText(previous.dueAt)} → ${dueText(assignment.dueAt)}` }, now))
    }
    if (previous.status !== assignment.status) {
      changes.push(event(source, 'assignment_status_changed', assignment.id, assignment.status, { courseId: assignment.courseId, assignmentId: assignment.id, title: '作业状态已更新', detail: `${courseName} · ${assignment.title}：${statusLabels[previous.status]} → ${statusLabels[assignment.status]}` }, now))
    }
    if (previous.score !== assignment.score || previous.maxScore !== assignment.maxScore) {
      const oldScore = previous.score == null ? '未公布' : `${previous.score}${previous.maxScore == null ? '' : `/${previous.maxScore}`}`
      const nextScore = assignment.score == null ? '未公布' : `${assignment.score}${assignment.maxScore == null ? '' : `/${assignment.maxScore}`}`
      if (oldScore !== nextScore) changes.push(event(source, 'score_changed', assignment.id, nextScore, { courseId: assignment.courseId, assignmentId: assignment.id, title: '作业成绩已更新', detail: `${courseName} · ${assignment.title}：${oldScore} → ${nextScore}` }, now))
    }
  }

  return changes
}

export function mergeSyncInbox(existing: SyncInboxItem[], incoming: SyncInboxItem[], limit = 500) {
  const byId = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) if (!byId.has(item.id)) byId.set(item.id, item)
  return [...byId.values()].sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, limit)
}

export function syncConnectionRequiredItem(source: Extract<SyncInboxSource, 'Blackboard' | 'Gradescope'>, detail: string, now = new Date().toISOString()): SyncInboxItem {
  const day = now.slice(0, 10)
  return event(source, 'connection_required', source, day, { title: `${source} 需要重新登录`, detail }, now)
}

export function resolveSyncConnectionItems(items: SyncInboxItem[], source: Extract<SyncInboxSource, 'Blackboard' | 'Gradescope'>, now = new Date().toISOString()) {
  void now
  return items.filter((item) => item.kind !== 'connection_required' || item.source !== source)
}

export function emailDeliveryInboxItem(status: 'sent' | 'failed', detail: string, fingerprint: string, now = new Date().toISOString()): SyncInboxItem {
  return event('Email', status === 'sent' ? 'email_sent' : 'email_failed', 'email', fingerprint, { title: status === 'sent' ? 'DDL 邮件已由 SMTP 接受' : 'DDL 邮件发送失败', detail }, now)
}

export function unreadSyncInboxCount(items: SyncInboxItem[]) {
  return items.filter((item) => !item.readAt && !item.archivedAt).length
}

export function updateSyncInboxItems(items: SyncInboxItem[], ids: string[], action: 'read' | 'unread' | 'archive', now = new Date().toISOString()) {
  const selected = new Set(ids)
  return items.map((item) => {
    if (!selected.has(item.id)) return item
    if (action === 'read') return { ...item, readAt: item.readAt ?? now }
    if (action === 'unread') return { ...item, readAt: undefined, archivedAt: undefined }
    return { ...item, readAt: item.readAt ?? now, archivedAt: now }
  })
}
