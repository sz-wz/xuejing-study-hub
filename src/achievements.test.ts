import { describe, expect, it } from 'vitest'
import { ACHIEVEMENTS, achievementProgress, backfillLearningEvents, evaluateAchievements, mergeLearningEvents, type AchievementContext, type LearningEvent } from './achievements'

const context = (events: LearningEvent[] = []): AchievementContext => ({ events, courses: [], materials: [], assignments: [], journal: [], reviewSessions: {}, knowledgeRatings: {} })

describe('achievements', () => {
  it('包含 60 个普通收藏与 12 个里程碑', () => {
    expect(ACHIEVEMENTS.filter((item) => item.tier !== 'milestone')).toHaveLength(60)
    expect(ACHIEVEMENTS.filter((item) => item.tier === 'milestone')).toHaveLength(12)
  })

  it('首次达到阈值后颁发且重复计算不会重复颁发', () => {
    const input = context([{ id: 'review:1', type: 'review_completed', occurredAt: '2026-07-01T10:00:00Z', value: 30 }])
    const first = evaluateAchievements(input, [], '2026-07-01T10:30:00Z')
    expect(first.some((award) => award.achievementId === 'review-1')).toBe(true)
    expect(evaluateAchievements(input, first, '2026-07-01T11:00:00Z')).toEqual([])
  })

  it('复习分钟数不会被误算成复习次数', () => {
    const input = context([{ id: 'review:1', type: 'review_completed', occurredAt: '2026-07-01T10:00:00Z', value: 45 }])
    const awards = evaluateAchievements(input, [])
    expect(awards.some((award) => award.achievementId === 'review-1')).toBe(true)
    expect(awards.some((award) => award.achievementId === 'review-30')).toBe(false)
    expect(achievementProgress(input, []).find((item) => item.definition.id === 'review-minutes-60')?.current).toBe(45)
  })

  it('稳定事件 id 合并时不会重复累计', () => {
    const item: LearningEvent = { id: 'quick-test:q1', type: 'quick_test_completed', occurredAt: '2026-07-01T10:00:00Z' }
    expect(mergeLearningEvents([item], [item])).toHaveLength(1)
  })

  it('历史回填保留证据并标记为补发', () => {
    const events = backfillLearningEvents({ courses: [], materials: [], assignments: [], journal: [{ id: 'j1', date: '2026-07-01', content: '复习卷积', mood: '平稳' }], reviewSessions: {}, knowledgeRatings: {} })
    const awards = evaluateAchievements({ ...context(events), journal: [{ id: 'j1', date: '2026-07-01', content: '复习卷积', mood: '平稳' }] }, [], '2026-07-02T00:00:00Z', true)
    expect(events.map((item) => item.id)).toContain('journal:j1')
    expect(awards.find((award) => award.achievementId === 'journal-1')?.backfilled).toBe(true)
  })

  it('进度不会超过 100%', () => {
    const progress = achievementProgress({ ...context(), courses: Array.from({ length: 20 }, (_, index) => ({ id: String(index), code: '', name: '', instructor: '', color: '', sources: [] })) }, [])
    expect(progress.find((item) => item.definition.id === 'course-6')?.percent).toBe(100)
  })
})
