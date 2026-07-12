import type { AssignmentReflection, AssignmentSelfAssessment } from './types'

export type AssignmentReflectionDraft = {
  score: string
  maxScore: string
  feedback: string
  selfAssessment: AssignmentSelfAssessment | ''
  note: string
}

function optionalText(value: string) {
  return value.trim() || undefined
}

function optionalNumber(value: string, label: string) {
  const text = value.trim()
  if (!text) return undefined
  const number = Number(text)
  if (!Number.isFinite(number)) throw new Error(`${label}必须是有效数字。`)
  return number
}

export function normalizeAssignmentReflection(draft: AssignmentReflectionDraft, updatedAt: string): AssignmentReflection | undefined {
  const score = optionalNumber(draft.score, '得分')
  const maxScore = optionalNumber(draft.maxScore, '满分')
  if ((score === undefined) !== (maxScore === undefined)) throw new Error('请同时填写得分和满分，或同时留空。')
  if (score !== undefined && (score < 0 || maxScore! <= 0 || score > maxScore!)) throw new Error('请检查得分与满分的范围。')
  const feedback = optionalText(draft.feedback)
  const note = optionalText(draft.note)
  const selfAssessment = draft.selfAssessment || undefined
  if (score === undefined && !feedback && !note && !selfAssessment) return undefined
  return { score, maxScore, feedback, note, selfAssessment, updatedAt }
}

export function reflectionScorePercent(reflection?: AssignmentReflection) {
  if (reflection?.score === undefined || reflection.maxScore === undefined || reflection.maxScore <= 0) return undefined
  return Math.round(reflection.score / reflection.maxScore * 100)
}
