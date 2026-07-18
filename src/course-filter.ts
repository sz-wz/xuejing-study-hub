export function normalizeCourseFilter(value: string, courseIds: string[], fallback: 'all' | 'current') {
  if (value === 'all' || value === 'current') return value
  return courseIds.includes(value) ? value : fallback
}

export function concreteCourseId(filter: string, selectedCourseId: string | null, courseIds: string[]) {
  if (filter === 'all') return null
  const candidate = filter === 'current' ? selectedCourseId : filter
  return candidate && courseIds.includes(candidate) ? candidate : courseIds[0] ?? null
}
