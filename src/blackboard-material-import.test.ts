import { describe, expect, it } from 'vitest'
import { mergeBlackboardMaterials } from './blackboard-material-import'
import type { Course, Material } from './types'

const courses: Course[] = [{ id: 'cs5006', code: 'CS5006', name: 'Fall_2025_数字电路', instructor: '', color: '#336a58', sources: ['Blackboard'] }]
const existing: Material[] = []

describe('mergeBlackboardMaterials', () => {
  it('将 Blackboard 附件映射到正确课程并保留原始链接', () => {
    const result = mergeBlackboardMaterials(existing, courses, [{
      title: 'ch1.ppt', type: 'PPT', kind: 'file', url: 'https://elearning.example.edu/bbcswebdav/ch1', meta: '3.377 MB', courseName: 'Fall_2025_数字电路', path: ['课程资料', 'Slides'],
    }])

    expect(result.materials).toHaveLength(1)
    expect(result.materials[0]).toMatchObject({ courseId: 'cs5006', title: 'ch1.ppt', type: 'PPT', folder: 'Slides', path: ['课程资料', 'Slides'] })
  })

  it('用本次成功扫描结果替换同课程旧的 Blackboard 条目', () => {
    const oldNavigation: Material = {
      id: 'old-navigation', courseId: 'cs5006', title: '主页', type: '网页', source: 'Blackboard', meta: 'www.blackboard.com', concepts: [],
      url: 'https://www.blackboard.com/', path: ['课程资料', '课程PPT'], kind: 'link',
    }
    const result = mergeBlackboardMaterials([oldNavigation], courses, [{
      title: '第一周课程介绍', type: '文件', kind: 'file', url: 'https://elearning.example.edu/bbcswebdav/week-1', meta: '',
      courseName: 'Fall_2025_数字电路', path: ['课程资料', '课程PPT'],
    }])

    expect(result.materials.map((item) => item.title)).toEqual(['第一周课程介绍'])
  })
})
