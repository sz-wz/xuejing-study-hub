import { describe, expect, it } from 'vitest'
import { normalizeAssignmentReflection, reflectionScorePercent } from './assignment-reflection'

describe('assignment reflection', () => {
  it('保存成绩、反馈和自评，并将成绩转换为百分比', () => {
    const reflection = normalizeAssignmentReflection({
      score: '18', maxScore: '20', feedback: '推导步骤需要更完整。', selfAssessment: 'needs_review', note: '复习卷积性质。',
    }, '2026-07-13T00:00:00.000Z')
    expect(reflection).toMatchObject({ score: 18, maxScore: 20, selfAssessment: 'needs_review', feedback: '推导步骤需要更完整。' })
    expect(reflectionScorePercent(reflection)).toBe(90)
  })

  it('拒绝不完整或不合理的成绩输入', () => {
    expect(() => normalizeAssignmentReflection({ score: '18', maxScore: '', feedback: '', selfAssessment: '', note: '' }, 'now')).toThrow('同时填写')
    expect(() => normalizeAssignmentReflection({ score: '21', maxScore: '20', feedback: '', selfAssessment: '', note: '' }, 'now')).toThrow('范围')
  })
})
