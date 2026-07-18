export type Source = 'Blackboard' | 'Gradescope' | '手动添加'

export type Course = {
  id: string
  code: string
  name: string
  instructor: string
  color: string
  sources: Source[]
  studyStatus?: 'active' | 'completed'
  completedAt?: string
}

export type TaskStatus = '待开始' | '进行中' | '已提交'

export type Task = {
  id: string
  title: string
  courseId: string
  dueAt: string
  source: Source
  status: TaskStatus
  knowledgeIds: string[]
  weight: '高' | '中' | '低'
}

export type Knowledge = {
  id: string
  courseId: string
  title: string
  group: string
  mastery: number
  selfRating: 1 | 2 | 3 | 4
  evidence: string
  sourceCount: number
  connections: string[]
}

export type Material = {
  id: string
  courseId: string
  title: string
  type: 'PDF' | 'PPT' | '视频' | '网页' | '文件' | '作业'
  source: Source
  meta: string
  concepts: string[]
  url?: string
  localPath?: string
  folder?: string
  path?: string[]
  term?: string
  kind?: 'folder' | 'file' | 'link' | 'assignment'
  knowledgeRole?: 'courseware' | 'reference'
}

export type AssignmentStatus = 'unknown' | 'not_submitted' | 'submitted' | 'graded' | 'manual_completed'

export type AssignmentFile = {
  id: string
  title: string
  type: 'PPT' | 'PDF' | '视频' | '文件'
  localPath: string
  addedAt: string
  managed?: boolean
}

export type AssignmentAiKnowledgeMatch = {
  conceptIds: string[]
  explanation: string
  model: string
  generatedAt: string
  sourceKey: string
}

export type AssignmentSelfAssessment = 'confident' | 'uncertain' | 'needs_review'

export type AssignmentReflection = {
  score?: number
  maxScore?: number
  feedback?: string
  selfAssessment?: AssignmentSelfAssessment
  note?: string
  updatedAt: string
}

export type Assignment = {
  id: string
  courseId: string
  source: Extract<Source, 'Blackboard' | 'Gradescope' | '手动添加'>
  sourceCourseName: string
  term: string
  title: string
  url?: string
  dueAt?: string
  manualDueAt?: string
  dueLabel?: string
  status: Exclude<AssignmentStatus, 'manual_completed'>
  score?: number
  maxScore?: number
  manualStatus?: 'completed'
  detailsText?: string
  detailsFetchedAt?: string
  manualKnowledgeIds?: string[]
  aiKnowledge?: AssignmentAiKnowledgeMatch
  reflection?: AssignmentReflection
  files?: AssignmentFile[]
  lastSyncedAt: string
}

export type JournalEntry = {
  id: string
  date: string
  content: string
  mood: '轻松' | '平稳' | '吃力'
  updatedAt?: string
}
