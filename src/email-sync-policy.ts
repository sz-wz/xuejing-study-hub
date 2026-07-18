import type { SyncInboxItem } from './sync-inbox'

export type SyncEmailMode = 'important' | 'daily' | 'every_sync' | 'off'

const IMPORTANT_KINDS = new Set<SyncInboxItem['kind']>([
  'sync_summary', 'course_added', 'assignment_added', 'deadline_changed',
  'assignment_status_changed', 'score_changed', 'connection_required',
])

export function syncEmailEventsForMode(events: SyncInboxItem[], mode: SyncEmailMode) {
  if (mode === 'off') return []
  if (mode === 'important') return events.filter((item) => IMPORTANT_KINDS.has(item.kind))
  return events
}

export function mergeEmailDigestQueue(existing: SyncInboxItem[], incoming: SyncInboxItem[], limit = 500) {
  const byId = new Map(existing.map((item) => [item.id, item]))
  for (const item of incoming) byId.set(item.id, item)
  return [...byId.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(-limit)
}

function localDay(value: Date) {
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`
}

export function shouldFlushDailyDigest(lastSentAt: string, digestHour: number, now = new Date()) {
  const hour = Math.max(0, Math.min(23, Math.trunc(digestHour)))
  if (now.getHours() < hour) return false
  if (!lastSentAt) return true
  const last = new Date(lastSentAt)
  return Number.isNaN(last.getTime()) || localDay(last) !== localDay(now)
}
