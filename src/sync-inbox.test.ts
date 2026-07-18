import { describe, expect, it } from 'vitest'
import type { Assignment, Course, Material } from './types'
import { detectSyncChanges, emailDeliveryInboxItem, mergeSyncInbox, resolveSyncConnectionItems, syncConnectionRequiredItem, unreadSyncInboxCount, updateSyncInboxItems } from './sync-inbox'

const course: Course = { id: 'c1', code: 'CS101', name: '计算机导论', instructor: '', color: '#123', sources: ['Blackboard'] }
const assignment: Assignment = { id: 'a1', courseId: 'c1', source: 'Blackboard', sourceCourseName: course.name, term: 'Blackboard', title: '作业 1', dueAt: '2026-07-20T12:00:00.000Z', status: 'not_submitted', lastSyncedAt: '2026-07-13T00:00:00.000Z' }

describe('同步变更收件箱', () => {
  it('识别新课程、新资料和新作业', () => {
    const existing: Course = { id: 'existing', code: 'OLD', name: '已有课程', instructor: '', color: '#456', sources: ['Blackboard'] }
    const material: Material = { id: 'm1', courseId: 'c1', title: 'Lecture 1.pdf', type: 'PDF', source: 'Blackboard', meta: '', concepts: [], kind: 'file', url: 'https://example.edu/m1' }
    const changes = detectSyncChanges({ courses: [existing], materials: [], assignments: [] }, { courses: [existing, course], materials: [material], assignments: [assignment] }, 'Blackboard', '2026-07-13T01:00:00.000Z')
    expect(changes.map((item) => item.kind)).toEqual(['course_added', 'material_added', 'assignment_added'])
  })

  it('首次平台同步只生成一条基线摘要，不为每份历史资料创建收件箱消息', () => {
    const materials = Array.from({ length: 400 }, (_, index): Material => ({ id: `m${index}`, courseId: 'c1', title: `Lecture ${index}.pdf`, type: 'PDF', source: 'Blackboard', meta: '', concepts: [], kind: 'file', url: `https://example.edu/m${index}` }))
    const changes = detectSyncChanges({ courses: [], materials: [], assignments: [] }, { courses: [course], materials, assignments: [assignment] }, 'Blackboard', '2026-07-13T01:00:00.000Z')
    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe('sync_summary')
    expect(changes[0].detail).toContain('400 份资料')
  })

  it('后续同步会把同一课程的多份新资料折叠为一个批次摘要', () => {
    const before = { courses: [course], materials: [], assignments: [assignment] }
    const materials = Array.from({ length: 20 }, (_, index): Material => ({ id: `m${index}`, courseId: 'c1', title: `Lecture ${index}.pdf`, type: 'PDF', source: 'Blackboard', meta: '', concepts: [], kind: 'file', url: `https://example.edu/m${index}` }))
    const changes = detectSyncChanges(before, { ...before, materials }, 'Blackboard', '2026-07-13T01:00:00.000Z')
    expect(changes).toHaveLength(1)
    expect(changes[0].kind).toBe('material_batch_added')
    expect(changes[0].detail).toContain('新增 20 份资料')
    expect(changes[0].detail).toContain('Lecture 0.pdf')
  })

  it('识别 DDL、状态和成绩变化，但重复同步不会产生变化', () => {
    const updated = { ...assignment, dueAt: '2026-07-22T12:00:00.000Z', status: 'graded' as const, score: 92, maxScore: 100 }
    const changes = detectSyncChanges({ courses: [course], materials: [], assignments: [assignment] }, { courses: [course], materials: [], assignments: [updated] }, 'Blackboard')
    expect(changes.map((item) => item.kind)).toEqual(['deadline_changed', 'assignment_status_changed', 'score_changed'])
    expect(detectSyncChanges({ courses: [course], materials: [], assignments: [updated] }, { courses: [course], materials: [], assignments: [updated] }, 'Blackboard')).toEqual([])
  })

  it('合并时按稳定事件 ID 去重，并支持已读和归档', () => {
    const material: Material = { id: 'm1', courseId: 'c1', title: 'Lecture 1.pdf', type: 'PDF', source: 'Blackboard', meta: '', concepts: [], kind: 'file', url: 'https://example.edu/m1' }
    const changes = detectSyncChanges({ courses: [course], materials: [], assignments: [] }, { courses: [course], materials: [material], assignments: [assignment] }, 'Blackboard', '2026-07-13T01:00:00.000Z')
    const merged = mergeSyncInbox(changes, changes)
    expect(merged).toHaveLength(2)
    expect(unreadSyncInboxCount(merged)).toBe(2)
    const read = updateSyncInboxItems(merged, [merged[0].id], 'read', '2026-07-13T02:00:00.000Z')
    expect(unreadSyncInboxCount(read)).toBe(1)
    expect(updateSyncInboxItems(read, [merged[1].id], 'archive')[1].archivedAt).toBeTruthy()
  })

  it('同一平台的登录失效提示每天最多生成一条', () => {
    const first = syncConnectionRequiredItem('Gradescope', '登录已过期', '2026-07-13T01:00:00.000Z')
    const second = syncConnectionRequiredItem('Gradescope', '仍需登录', '2026-07-13T18:00:00.000Z')
    expect(first.id).toBe(second.id)
    expect(mergeSyncInbox([first], [second])).toHaveLength(1)
  })

  it('平台恢复连接后移除对应的临时登录提示', () => {
    const blackboard = syncConnectionRequiredItem('Blackboard', '请重新登录', '2026-07-13T01:00:00.000Z')
    const gradescope = syncConnectionRequiredItem('Gradescope', '请重新登录', '2026-07-13T01:00:00.000Z')
    const resolved = resolveSyncConnectionItems([blackboard, gradescope], 'Blackboard', '2026-07-13T02:00:00.000Z')
    expect(resolved).toEqual([gradescope])
  })

  it('邮件投递结果使用提醒指纹去重', () => {
    const first = emailDeliveryInboxItem('sent', '已接受 1 个收件地址', 'a1:3d')
    const second = emailDeliveryInboxItem('sent', '重复回调', 'a1:3d')
    expect(mergeSyncInbox([first], [second])).toHaveLength(1)
  })
})
