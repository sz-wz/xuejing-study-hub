import { assignmentCompleted, assignmentDueAt } from './deadline-utils'
import type { Assignment } from './types'

export const AUTO_SYNC_INTERVALS = [30, 60, 180, 360] as const
export const DEADLINE_EMAIL_THRESHOLDS = [1, 3, 5, 7] as const

export type AutoSyncInterval = typeof AUTO_SYNC_INTERVALS[number]
export type DeadlineEmailThreshold = typeof DEADLINE_EMAIL_THRESHOLDS[number]

export type AutoSyncPreferences = {
  enabled: boolean
  intervalMinutes: AutoSyncInterval
  syncOnLaunch: boolean
  blackboard: boolean
  gradescope: boolean
  deadlineEmailThresholdDays: DeadlineEmailThreshold[]
  quietHoursEnabled: boolean
  quietStartHour: number
  quietEndHour: number
}

export const DEFAULT_AUTO_SYNC_PREFERENCES: AutoSyncPreferences = {
  enabled: false,
  intervalMinutes: 60,
  syncOnLaunch: true,
  blackboard: true,
  gradescope: true,
  deadlineEmailThresholdDays: [1, 3, 5, 7],
  quietHoursEnabled: false,
  quietStartHour: 23,
  quietEndHour: 7,
}

function boundedHour(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(23, Math.max(0, Math.round(value))) : fallback
}

export function normalizeAutoSyncPreferences(value: unknown): AutoSyncPreferences {
  const source = value && typeof value === 'object' ? value as Partial<AutoSyncPreferences> : {}
  const intervalMinutes = AUTO_SYNC_INTERVALS.includes(source.intervalMinutes as AutoSyncInterval) ? source.intervalMinutes as AutoSyncInterval : 60
  const thresholdSource = Array.isArray(source.deadlineEmailThresholdDays) ? source.deadlineEmailThresholdDays : DEFAULT_AUTO_SYNC_PREFERENCES.deadlineEmailThresholdDays
  const deadlineEmailThresholdDays = [...new Set(thresholdSource.filter((item): item is DeadlineEmailThreshold => DEADLINE_EMAIL_THRESHOLDS.includes(item as DeadlineEmailThreshold)))].sort((left, right) => left - right)
  return {
    enabled: source.enabled === true,
    intervalMinutes,
    syncOnLaunch: source.syncOnLaunch !== false,
    blackboard: source.blackboard !== false,
    gradescope: source.gradescope !== false,
    deadlineEmailThresholdDays,
    quietHoursEnabled: source.quietHoursEnabled === true,
    quietStartHour: boundedHour(source.quietStartHour, 23),
    quietEndHour: boundedHour(source.quietEndHour, 7),
  }
}

export function isQuietHour(preferences: AutoSyncPreferences, date = new Date()) {
  if (!preferences.quietHoursEnabled || preferences.quietStartHour === preferences.quietEndHour) return false
  const hour = date.getHours()
  return preferences.quietStartHour < preferences.quietEndHour
    ? hour >= preferences.quietStartHour && hour < preferences.quietEndHour
    : hour >= preferences.quietStartHour || hour < preferences.quietEndHour
}

export function automaticSyncDelayMs(intervalMinutes: number, consecutiveFailures: number) {
  const base = Math.max(5, intervalMinutes) * 60_000
  return Math.min(6 * 60 * 60_000, base * (2 ** Math.min(3, Math.max(0, consecutiveFailures))))
}

export type DeadlineEmailCandidate = { assignment: Assignment; thresholdDays: DeadlineEmailThreshold; key: string; dueAt: string }

export function deadlineEmailKey(assignment: Assignment, dueAt: string, thresholdDays: number) {
  return `${assignment.id}:${dueAt}:${thresholdDays}d`
}

export function deadlineEmailCandidates(assignments: Assignment[], activeCourseIds: Set<string>, thresholds: number[], sent: Record<string, true>, now = new Date()): DeadlineEmailCandidate[] {
  const normalizedThresholds = [...new Set(thresholds.filter((value): value is DeadlineEmailThreshold => DEADLINE_EMAIL_THRESHOLDS.includes(value as DeadlineEmailThreshold)))].sort((left, right) => left - right)
  if (!normalizedThresholds.length) return []
  return assignments.flatMap((assignment) => {
    if (assignmentCompleted(assignment) || !activeCourseIds.has(assignment.courseId)) return []
    const dueAt = assignmentDueAt(assignment)
    if (!dueAt) return []
    const due = new Date(dueAt)
    if (Number.isNaN(due.getTime())) return []
    const remainingDays = (due.getTime() - now.getTime()) / 86_400_000
    if (remainingDays <= 0) return []
    const thresholdDays = normalizedThresholds.find((threshold) => remainingDays <= threshold)
    if (!thresholdDays || sent[deadlineEmailKey(assignment, dueAt, thresholdDays)]) return []
    return [{ assignment, thresholdDays, dueAt, key: deadlineEmailKey(assignment, dueAt, thresholdDays) }]
  }).sort((left, right) => new Date(left.dueAt).getTime() - new Date(right.dueAt).getTime())
}
