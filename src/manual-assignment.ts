import type { Assignment } from './types'

export type ManualAssignmentDraft = {
  courseId: string
  courseName: string
  title: string
  dueAt?: string
  detailsText?: string
  url?: string
}

function optionalText(value?: string) {
  return value?.trim() || undefined
}

function optionalHttpUrl(value?: string) {
  const url = optionalText(value)
  if (!url) return undefined
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('作业链接仅支持 http 或 https 地址。')
  return parsed.toString()
}

export function createManualAssignment(draft: ManualAssignmentDraft, options: { id: string; now: string }): Assignment {
  const courseId = draft.courseId.trim()
  const courseName = draft.courseName.trim()
  const title = draft.title.trim()
  if (!courseId || !courseName) throw new Error('请选择或新建一门课程。')
  if (!title) throw new Error('请填写作业名称。')

  const dueAtInput = optionalText(draft.dueAt)
  const dueAt = dueAtInput ? new Date(dueAtInput) : undefined
  if (dueAt && Number.isNaN(dueAt.getTime())) throw new Error('请输入有效的截止日期与时间。')
  const detailsText = optionalText(draft.detailsText)

  return {
    id: options.id,
    courseId,
    source: '手动添加',
    sourceCourseName: courseName,
    term: '手动添加',
    title,
    url: optionalHttpUrl(draft.url),
    dueAt: dueAt?.toISOString(),
    dueLabel: dueAt ? '人工设置 DDL' : '手动添加',
    status: 'unknown',
    detailsText,
    detailsFetchedAt: detailsText ? options.now : undefined,
    lastSyncedAt: options.now,
  }
}
