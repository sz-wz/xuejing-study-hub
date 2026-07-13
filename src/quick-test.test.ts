import { describe, expect, it } from 'vitest'
import { adaptiveQuestionCount, gradeQuickTest, parseQuickTest, type QuickTestRecord } from './quick-test'

describe('adaptiveQuestionCount', () => {
  it('increases coverage for more files and weak evidence while keeping a quick-test cap', () => {
    expect(adaptiveQuestionCount(1, 0, 0)).toBe(3)
    expect(adaptiveQuestionCount(4, 2, 3)).toBe(7)
    expect(adaptiveQuestionCount(20, 10, 30)).toBe(10)
  })
})

describe('parseQuickTest', () => {
  it('rejects questions that do not cite a completed material', () => {
    const value = JSON.stringify({ questions: [
      { prompt: '合法题目', options: ['A', 'B'], correctIndex: 0, materialIds: ['m1'], conceptIds: ['c1'] },
      { prompt: '越界题目', options: ['A', 'B'], correctIndex: 1, materialIds: ['other'], conceptIds: [] },
    ] })
    expect(parseQuickTest(value, ['m1'], ['c1'], 5)).toHaveLength(1)
  })
})

describe('gradeQuickTest', () => {
  it('scores objective questions locally', () => {
    const test: QuickTestRecord = { id: 't', scope: 'session', questionCount: 1, status: 'ready', generatedAt: '', answers: {}, questions: [{ id: 'q-1', prompt: '题目', options: ['A', 'B'], correctIndex: 1, explanation: '', materialIds: ['m1'], conceptIds: [] }] }
    expect(gradeQuickTest(test, { 'q-1': 1 })).toMatchObject({ status: 'completed', score: 100 })
  })
})
