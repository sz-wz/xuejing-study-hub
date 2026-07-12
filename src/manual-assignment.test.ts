import { describe, expect, it } from 'vitest'
import { createManualAssignment } from './manual-assignment'

describe('createManualAssignment', () => {
  it('创建不依赖 Blackboard 或 Gradescope 的作业，并保留题目说明和 DDL', () => {
    const assignment = createManualAssignment({
      courseId: 'course-ai',
      courseName: '人工智能导论',
      title: '  Project proposal  ',
      dueAt: '2026-07-18T20:00',
      detailsText: '  阅读要求并提交选题。 ',
      url: 'https://example.edu/submit',
    }, { id: 'manual-assignment-1', now: '2026-07-13T00:00:00.000Z' })

    expect(assignment).toMatchObject({
      id: 'manual-assignment-1',
      source: '手动添加',
      term: '手动添加',
      title: 'Project proposal',
      detailsText: '阅读要求并提交选题。',
      url: 'https://example.edu/submit',
      status: 'unknown',
    })
    expect(assignment.dueAt).toBeTruthy()
  })

  it('拒绝缺少课程、标题或不安全链接的输入', () => {
    const options = { id: 'manual-assignment-2', now: '2026-07-13T00:00:00.000Z' }
    expect(() => createManualAssignment({ courseId: '', courseName: '', title: 'HW' }, options)).toThrow('请选择或新建一门课程')
    expect(() => createManualAssignment({ courseId: 'course-1', courseName: '课程', title: '', url: 'https://example.edu' }, options)).toThrow('请填写作业名称')
    expect(() => createManualAssignment({ courseId: 'course-1', courseName: '课程', title: 'HW', url: 'file:///C:/test.pdf' }, options)).toThrow('仅支持 http 或 https')
  })
})
