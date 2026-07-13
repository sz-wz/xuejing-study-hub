import { describe, expect, it } from 'vitest'
import type { Assignment } from './types'
import { automaticSyncDelayMs, deadlineEmailCandidates, isQuietHour, normalizeAutoSyncPreferences } from './background-sync'

const assignment: Assignment = { id: 'a1', courseId: 'c1', source: 'Gradescope', sourceCourseName: 'CS101', term: 'Spring 2026', title: 'Homework 1', dueAt: '2026-07-20T12:00:00.000Z', status: 'not_submitted', lastSyncedAt: '2026-07-13T00:00:00.000Z' }

describe('后台同步与分级提醒', () => {
  it('修复无效配置且默认不自动同步', () => {
    expect(normalizeAutoSyncPreferences({ enabled: true, intervalMinutes: 17, deadlineEmailThresholdDays: [7, 3, 3, 99] })).toMatchObject({ enabled: true, intervalMinutes: 60, deadlineEmailThresholdDays: [3, 7] })
    expect(normalizeAutoSyncPreferences(null).enabled).toBe(false)
  })

  it('支持跨午夜免打扰时段', () => {
    const preferences = normalizeAutoSyncPreferences({ quietHoursEnabled: true, quietStartHour: 23, quietEndHour: 7 })
    expect(isQuietHour(preferences, new Date('2026-07-13T23:30:00'))).toBe(true)
    expect(isQuietHour(preferences, new Date('2026-07-13T06:30:00'))).toBe(true)
    expect(isQuietHour(preferences, new Date('2026-07-13T12:00:00'))).toBe(false)
  })

  it('同步失败后指数退避且最多六小时', () => {
    expect(automaticSyncDelayMs(60, 0)).toBe(60 * 60_000)
    expect(automaticSyncDelayMs(60, 1)).toBe(2 * 60 * 60_000)
    expect(automaticSyncDelayMs(60, 8)).toBe(6 * 60 * 60_000)
  })

  it('只选择当前最近且尚未发送的一档 DDL 提醒', () => {
    const now = new Date('2026-07-18T12:00:00.000Z')
    const first = deadlineEmailCandidates([assignment], new Set(['c1']), [1, 3, 5, 7], {}, now)
    expect(first[0]?.thresholdDays).toBe(3)
    const sent = first[0] ? { [first[0].key]: true as const } : {}
    expect(deadlineEmailCandidates([assignment], new Set(['c1']), [1, 3, 5, 7], sent, now)).toEqual([])
    expect(deadlineEmailCandidates([{ ...assignment, status: 'submitted' }], new Set(['c1']), [1, 3, 5, 7], {}, now)).toEqual([])
    expect(deadlineEmailCandidates([assignment], new Set(), [1, 3, 5, 7], {}, now)).toEqual([])
  })
})
