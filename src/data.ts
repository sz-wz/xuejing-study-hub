import type { Course, JournalEntry, Knowledge, Material, Task } from './types'

// 初始状态必须为空：所有课程、资料、知识点与成长记录都来自用户同步或手动导入。
export const courses: Course[] = []
export const initialTasks: Task[] = []
export const initialKnowledge: Knowledge[] = []
export const materials: Material[] = []
export const initialJournal: JournalEntry[] = []
