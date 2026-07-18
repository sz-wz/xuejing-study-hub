import { describe, expect, it } from 'vitest'
import { concreteCourseId, normalizeCourseFilter } from './course-filter'

describe('course filter state', () => {
  const ids = ['course-a', 'course-b']

  it('repairs a stale course value instead of leaving a controlled select in an invalid state', () => {
    expect(normalizeCourseFilter('removed-course', ids, 'all')).toBe('all')
    expect(normalizeCourseFilter('removed-course', ids, 'current')).toBe('current')
  })

  it('resolves the current-course alias and explicit course values consistently', () => {
    expect(concreteCourseId('current', 'course-b', ids)).toBe('course-b')
    expect(concreteCourseId('course-a', 'course-b', ids)).toBe('course-a')
    expect(concreteCourseId('removed-course', 'course-b', ids)).toBe('course-a')
  })
})
