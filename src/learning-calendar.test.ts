import { describe, expect, it } from 'vitest'
import { buildLearningCalendarItems, buildMonthGrid, filterLearningCalendarItems, localDateKey, shiftMonth } from './learning-calendar'

describe('learning calendar', () => {
  it('始终生成星期一开头的 6×7 网格', () => {
    const grid = buildMonthGrid('2026-07-01', [], '2026-07-19')
    expect(grid).toHaveLength(42)
    expect(new Date(`${grid[0].date}T12:00:00`).getDay()).toBe(1)
    expect(grid.find((day) => day.date === '2026-07-19')?.today).toBe(true)
  })

  it('按本地日期归集学习证据而非 UTC 切日', () => {
    expect(localDateKey(new Date(2026, 6, 19, 0, 30))).toBe('2026-07-19')
  })

  it('日记和成就进入对应日期', () => {
    const items = buildLearningCalendarItems({ events: [], journal: [{ id: 'j1', date: '2026-07-02', content: '复习', mood: '轻松' }], awards: [{ id: 'a1', achievementId: 'review-1', awardedAt: '2026-07-02T10:00:00', evidenceEventIds: [], evidenceSummary: '第一次复习' }] })
    const day = buildMonthGrid('2026-07-01', items).find((item) => item.date === '2026-07-02')
    expect(day?.counts.journal).toBe(1)
    expect(day?.counts.achievement).toBe(1)
  })

  it('历史补发成就按日期合并为一条回顾', () => {
    const items = buildLearningCalendarItems({ events: [], journal: [], awards: [
      { id: 'a1', achievementId: 'review-1', awardedAt: '2026-07-02T10:00:00', evidenceEventIds: [], evidenceSummary: '第一次复习', backfilled: true },
      { id: 'a2', achievementId: 'journal-1', awardedAt: '2026-07-02T10:00:00', evidenceEventIds: [], evidenceSummary: '第一篇日记', backfilled: true },
    ] })
    expect(items).toHaveLength(1)
    expect(items[0].title).toContain('2 项')
  })

  it('支持月份与类型筛选', () => {
    expect(shiftMonth('2026-01-01', -1)).toBe('2025-12-01')
    const items = buildLearningCalendarItems({ events: [{ id: 'r1', type: 'review_completed', occurredAt: '2026-07-02T10:00:00', courseId: 'c1' }, { id: 'f1', type: 'focus_completed', occurredAt: '2026-07-02T11:00:00', courseId: 'c2' }], journal: [], awards: [] })
    expect(filterLearningCalendarItems(items, 'review', 'c1')).toHaveLength(1)
  })
})
