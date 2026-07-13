import { describe, expect, it } from 'vitest'
import { buildGrowthSnapshotSeries, createGrowthSnapshot, upsertGrowthSnapshot } from './growth-snapshots'
import type { CourseGrowthMetric } from './growth-metrics'

const metric: CourseGrowthMetric = {
  courseId: 'c1', courseName: '信号与系统', totalMaterials: 2, contactedMaterials: 2, confirmedMaterials: 1, understoodMaterials: 1, verifiedMaterials: 1, averageTestScore: 80,
  weakMaterialIds: ['m1'], ratedConcepts: 2, weakConcepts: 1, testedConcepts: 2, verifiedConcepts: 1, testWeakConcepts: 1, evidenceConflicts: 1, weakConceptIds: ['k1'],
}

describe('成长每日快照', () => {
  it('从当前真实课程指标生成总览与课程快照', () => {
    const snapshot = createGrowthSnapshot([metric], '2026-07-13', '2026-07-13T12:00:00.000Z')
    expect(snapshot).toMatchObject({ date: '2026-07-13', weakMaterials: 1, weakConcepts: 1, verifiedConcepts: 1, conflicts: 1 })
    expect(snapshot.courses[0]).toMatchObject({ courseId: 'c1', weakMaterials: 1, weakConcepts: 1 })
  })

  it('同一天指标不变时不重复写入，变化时更新当天快照', () => {
    const first = createGrowthSnapshot([metric], '2026-07-13', '2026-07-13T10:00:00.000Z')
    const original = [first]
    const unchanged = upsertGrowthSnapshot(original, { ...first, capturedAt: '2026-07-13T12:00:00.000Z' })
    expect(unchanged).toBe(original)
    const changed = upsertGrowthSnapshot([first], { ...first, verifiedConcepts: 2, capturedAt: '2026-07-13T13:00:00.000Z' })
    expect(changed).toHaveLength(1)
    expect(changed[0]).toMatchObject({ verifiedConcepts: 2, capturedAt: '2026-07-13T13:00:00.000Z' })
  })

  it('没有历史快照的日期保持空缺，不补造成零值记录', () => {
    const snapshot = createGrowthSnapshot([metric], '2026-07-13', '2026-07-13T12:00:00.000Z')
    const series = buildGrowthSnapshotSeries([snapshot], 3, new Date('2026-07-13T12:00:00.000Z'))
    expect(series.map((point) => ({ date: point.date, recorded: point.recorded }))).toEqual([
      { date: '2026-07-11', recorded: false },
      { date: '2026-07-12', recorded: false },
      { date: '2026-07-13', recorded: true },
    ])
  })

  it('课程筛选只读取该课程当日数据', () => {
    const snapshot = createGrowthSnapshot([metric], '2026-07-13', '2026-07-13T12:00:00.000Z')
    expect(buildGrowthSnapshotSeries([snapshot], 1, new Date('2026-07-13T12:00:00.000Z'), 'c1')[0]).toMatchObject({ weakConcepts: 1, verifiedConcepts: 1, recorded: true })
    expect(buildGrowthSnapshotSeries([snapshot], 1, new Date('2026-07-13T12:00:00.000Z'), 'new-course')[0]).toMatchObject({ recorded: false })
  })
})
