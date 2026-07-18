import { describe, expect, it } from 'vitest'
import { planCelebrations } from './achievement-celebration'

const award = (achievementId: string, backfilled = false) => ({ id: `award-${achievementId}`, achievementId, awardedAt: '2026-07-19T10:00:00', evidenceEventIds: [], evidenceSummary: '', backfilled })

describe('achievement celebrations', () => {
  it('历史补发和关闭模式不弹出', () => {
    expect(planCelebrations([award('review-1', true)], [], '2026-07-19T10:00:00', 'full', false)).toEqual([])
    expect(planCelebrations([award('review-1')], [], '2026-07-19T10:00:00', 'off', false)).toEqual([])
  })

  it('十分钟超过三项普通成就后合并展示', () => {
    const history = Array.from({ length: 3 }, () => ({ displayedAt: '2026-07-19T09:55:00', tier: 'common' as const }))
    const result = planCelebrations([award('review-1'), award('journal-1')], history, '2026-07-19T10:00:00', 'full', false)
    expect(result).toHaveLength(1)
    expect(result[0].awardIds).toHaveLength(2)
  })

  it('复习会话中标记为延迟且里程碑使用完整特效', () => {
    const result = planCelebrations([award('review-100')], [], '2026-07-19T10:00:00', 'full', true)
    expect(result[0]).toMatchObject({ delayed: true, effects: 'fireworks', tier: 'milestone' })
  })
})
