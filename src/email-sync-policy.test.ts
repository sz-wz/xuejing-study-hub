import { describe, expect, it } from 'vitest'
import { mergeEmailDigestQueue, shouldFlushDailyDigest, syncEmailEventsForMode } from './email-sync-policy'
import type { SyncInboxItem } from './sync-inbox'

const events: SyncInboxItem[] = [
  { id: 'summary', kind: 'sync_summary', source: 'Blackboard', title: '首次同步', detail: '摘要', createdAt: '2026-07-14T01:00:00.000Z' },
  { id: 'materials', kind: 'material_batch_added', source: 'Blackboard', title: '资料更新', detail: '20份', createdAt: '2026-07-14T01:00:00.000Z' },
  { id: 'assignment', kind: 'assignment_added', source: 'Gradescope', title: '新作业', detail: 'HW1', createdAt: '2026-07-14T01:00:00.000Z' },
]

describe('同步邮件策略', () => {
  it('默认重要变化模式不会为普通资料批次发送邮件', () => {
    expect(syncEmailEventsForMode(events, 'important').map((item) => item.id)).toEqual(['summary', 'assignment'])
    expect(syncEmailEventsForMode(events, 'every_sync')).toEqual(events)
    expect(syncEmailEventsForMode(events, 'off')).toEqual([])
  })

  it('每日摘要队列按事件 ID 去重', () => {
    expect(mergeEmailDigestQueue(events.slice(0, 2), events.slice(1))).toHaveLength(3)
  })

  it('错过设定小时后会在应用下一次运行时补发当天摘要', () => {
    expect(shouldFlushDailyDigest('', 8, new Date('2026-07-14T09:00:00+08:00'))).toBe(true)
    expect(shouldFlushDailyDigest('2026-07-14T08:10:00+08:00', 8, new Date('2026-07-14T09:00:00+08:00'))).toBe(false)
    expect(shouldFlushDailyDigest('2026-07-13T08:10:00+08:00', 8, new Date('2026-07-14T07:00:00+08:00'))).toBe(false)
  })
})
