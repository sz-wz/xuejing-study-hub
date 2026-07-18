import { definitionForAward, type AchievementAward, type AchievementTier } from './achievements'

export type CelebrationMode = 'full' | 'light' | 'off'
export type CelebrationHistoryItem = { displayedAt: string; tier: AchievementTier }
export type Celebration = {
  id: string
  tier: AchievementTier
  title: string
  description: string
  awardIds: string[]
  effects: 'none' | 'spark' | 'fireworks'
  delayed?: boolean
}

export function planCelebrations(awards: AchievementAward[], history: CelebrationHistoryItem[], now: string, mode: CelebrationMode, sessionActive: boolean): Celebration[] {
  if (mode === 'off') return []
  const eligible = awards.filter((award) => !award.backfilled).map((award) => ({ award, definition: definitionForAward(award) })).filter((item): item is { award: AchievementAward; definition: NonNullable<ReturnType<typeof definitionForAward>> } => Boolean(item.definition))
  if (!eligible.length) return []
  const current = new Date(now).getTime()
  const ordinaryShown = history.filter((item) => item.tier === 'common' && current - new Date(item.displayedAt).getTime() <= 10 * 60_000).length
  const rareEffectsRecently = history.some((item) => item.tier === 'rare' && current - new Date(item.displayedAt).getTime() <= 15 * 60_000)
  const milestones = eligible.filter((item) => item.definition.tier === 'milestone')
  const rare = eligible.filter((item) => item.definition.tier === 'rare')
  const common = eligible.filter((item) => item.definition.tier === 'common')
  const result: Celebration[] = milestones.map(({ award, definition }) => ({ id: `celebration:${award.id}`, tier: 'milestone', title: definition.title, description: definition.description, awardIds: [award.id], effects: mode === 'full' ? 'fireworks' : 'none', delayed: sessionActive }))
  result.push(...rare.map(({ award, definition }, index) => ({ id: `celebration:${award.id}`, tier: 'rare' as const, title: definition.title, description: definition.description, awardIds: [award.id], effects: mode === 'full' && !rareEffectsRecently && index === 0 ? 'spark' as const : 'none' as const, delayed: sessionActive })))
  if (common.length) {
    const available = Math.max(0, 3 - ordinaryShown)
    const singles = common.slice(0, available)
    result.push(...singles.map(({ award, definition }) => ({ id: `celebration:${award.id}`, tier: 'common' as const, title: definition.title, description: definition.description, awardIds: [award.id], effects: 'none' as const, delayed: sessionActive })))
    const grouped = common.slice(available)
    if (grouped.length) result.push({ id: `celebration:group:${grouped.map((item) => item.award.id).join(':')}`, tier: 'common', title: `又解锁 ${grouped.length} 项成长`, description: grouped.map((item) => item.definition.title).join('、'), awardIds: grouped.map((item) => item.award.id), effects: 'none', delayed: sessionActive })
  }
  return result
}
