import type { CourseGrowthMetric } from './growth-metrics'

export type GrowthSnapshotCourse = {
  courseId: string
  courseName: string
  weakMaterials: number
  weakConcepts: number
  verifiedConcepts: number
  conflicts: number
}

export type GrowthSnapshot = {
  date: string
  capturedAt: string
  weakMaterials: number
  weakConcepts: number
  verifiedConcepts: number
  conflicts: number
  courses: GrowthSnapshotCourse[]
}

export type GrowthSnapshotPoint = {
  date: string
  label: string
  recorded: boolean
  weakMaterials: number
  weakConcepts: number
  verifiedConcepts: number
  conflicts: number
}

function localDateKey(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

function snapshotValues(snapshot: GrowthSnapshot, courseId: string) {
  if (courseId === 'all') return snapshot
  return snapshot.courses.find((course) => course.courseId === courseId) ?? null
}

function comparable(snapshot: GrowthSnapshot) {
  return JSON.stringify({
    date: snapshot.date,
    weakMaterials: snapshot.weakMaterials,
    weakConcepts: snapshot.weakConcepts,
    verifiedConcepts: snapshot.verifiedConcepts,
    conflicts: snapshot.conflicts,
    courses: [...snapshot.courses].sort((left, right) => left.courseId.localeCompare(right.courseId)),
  })
}

export function createGrowthSnapshot(metrics: CourseGrowthMetric[], date: string, capturedAt = new Date().toISOString()): GrowthSnapshot {
  const courses = metrics.map((course) => ({
    courseId: course.courseId,
    courseName: course.courseName,
    weakMaterials: course.weakMaterialIds.length,
    weakConcepts: course.weakConceptIds.length,
    verifiedConcepts: course.verifiedConcepts,
    conflicts: course.evidenceConflicts,
  })).sort((left, right) => left.courseName.localeCompare(right.courseName, 'zh-CN'))
  return {
    date,
    capturedAt,
    weakMaterials: courses.reduce((sum, course) => sum + course.weakMaterials, 0),
    weakConcepts: courses.reduce((sum, course) => sum + course.weakConcepts, 0),
    verifiedConcepts: courses.reduce((sum, course) => sum + course.verifiedConcepts, 0),
    conflicts: courses.reduce((sum, course) => sum + course.conflicts, 0),
    courses,
  }
}

export function upsertGrowthSnapshot(snapshots: GrowthSnapshot[], next: GrowthSnapshot, limit = 365) {
  const existing = snapshots.find((snapshot) => snapshot.date === next.date)
  if (existing && comparable(existing) === comparable(next)) return snapshots
  return [...snapshots.filter((snapshot) => snapshot.date !== next.date), next]
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(-Math.max(1, limit))
}

export function buildGrowthSnapshotSeries(snapshots: GrowthSnapshot[], days: number, now = new Date(), courseId = 'all'): GrowthSnapshotPoint[] {
  const byDate = new Map(snapshots.map((snapshot) => [snapshot.date, snapshot]))
  const result: GrowthSnapshotPoint[] = []
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const value = new Date(now)
    value.setHours(12, 0, 0, 0)
    value.setDate(value.getDate() - offset)
    const date = localDateKey(value)
    const snapshot = byDate.get(date)
    const selected = snapshot ? snapshotValues(snapshot, courseId) : null
    result.push({
      date,
      label: `${value.getMonth() + 1}/${value.getDate()}`,
      recorded: Boolean(selected),
      weakMaterials: selected?.weakMaterials ?? 0,
      weakConcepts: selected?.weakConcepts ?? 0,
      verifiedConcepts: selected?.verifiedConcepts ?? 0,
      conflicts: selected?.conflicts ?? 0,
    })
  }
  return result
}
