import { describe, expect, it } from 'vitest'
import { assignmentAiSourceKey, parseAssignmentAiMatch } from './assignment-ai-match'

describe('AI 作业知识点匹配结果', () => {
  it('仅接受 AI 返回的候选知识点 ID，不推导或补充其他知识点', () => {
    const result = parseAssignmentAiMatch('```json\n{"conceptIds":["concept-fourier","unknown","C:concept-convolution","concept-fourier"],"explanation":"题目要求使用变换与卷积。"}\n```', ['concept-fourier', 'concept-convolution', 'concept-sampling'])
    expect(result).toEqual({ conceptIds: ['concept-fourier', 'concept-convolution'], explanation: '题目要求使用变换与卷积。' })
  })

  it('无法解析或没有合法 ID 时不生成任何匹配结果', () => {
    expect(parseAssignmentAiMatch('建议复习傅里叶变换', ['concept-fourier'])).toBeNull()
    expect(parseAssignmentAiMatch('{"conceptIds":["unknown"]}', ['concept-fourier'])).toBeNull()
  })

  it('题目说明改变后会产生不同的 AI 结果来源标识', () => {
    expect(assignmentAiSourceKey('HW2', 'Question A')).not.toBe(assignmentAiSourceKey('HW2', 'Question B'))
  })

  it('课程知识点候选集更新后，旧的 AI 匹配结果必须失效', () => {
    const assignmentText = 'Question A\nattachment.pdf:2026-07-13'
    expect(assignmentAiSourceKey('HW2', assignmentText, ['concept-old:旧知识点']))
      .not.toBe(assignmentAiSourceKey('HW2', assignmentText, ['concept-new:新知识点']))
  })
})
