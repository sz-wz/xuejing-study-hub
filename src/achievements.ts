import type { Assignment, Course, JournalEntry, Material } from './types'
import type { ReviewSession } from './review-workspace'

export type LearningEventType =
  | 'platform_sync'
  | 'material_import'
  | 'knowledge_build'
  | 'ai_refine'
  | 'review_started'
  | 'review_completed'
  | 'material_confirmed'
  | 'quick_test_completed'
  | 'focus_completed'
  | 'assignment_completed'
  | 'assignment_analyzed'
  | 'journal_saved'
  | 'schedule_adjusted'
  | 'course_completed'

export type LearningEvent = {
  id: string
  type: LearningEventType
  occurredAt: string
  courseId?: string
  materialId?: string
  assignmentId?: string
  sessionId?: string
  title?: string
  value?: number
  score?: number
  metadata?: Record<string, string | number | boolean>
}

export type AchievementTier = 'common' | 'rare' | 'milestone'
export type AchievementCategory = '起步' | '资料' | '复习' | '测试' | '专注' | '作业' | '记录' | '成长'

export type AchievementDefinition = {
  id: string
  title: string
  description: string
  category: AchievementCategory
  tier: AchievementTier
  metric: AchievementMetric
  threshold: number
  hidden?: boolean
}

export type AchievementMetric =
  | LearningEventType
  | 'active_days'
  | 'courses'
  | 'materials'
  | 'completed_assignments'
  | 'journal_days'
  | 'tested_materials'
  | 'high_score_tests'
  | 'perfect_tests'
  | 'confirmed_materials'
  | 'focus_minutes'
  | 'review_minutes'
  | 'completed_courses'
  | 'knowledge_ratings'
  | 'mastered_concepts'

export type AchievementAward = {
  id: string
  achievementId: string
  awardedAt: string
  evidenceEventIds: string[]
  evidenceSummary: string
  backfilled?: boolean
}

export type AchievementContext = {
  events: LearningEvent[]
  courses: Course[]
  materials: Material[]
  assignments: Assignment[]
  journal: JournalEntry[]
  reviewSessions: Record<string, ReviewSession>
  knowledgeRatings: Record<string, number>
}

export type AchievementProgress = {
  definition: AchievementDefinition
  current: number
  target: number
  percent: number
  awarded?: AchievementAward
}

const series = (
  prefix: string,
  category: AchievementCategory,
  metric: AchievementMetric,
  values: Array<[number, string, string, AchievementTier?]>,
): AchievementDefinition[] => values.map(([threshold, title, description, tier = 'common']) => ({
  id: `${prefix}-${threshold}`,
  title,
  description,
  category,
  tier,
  metric,
  threshold,
}))

export const ACHIEVEMENTS: AchievementDefinition[] = [
  ...series('course', '起步', 'courses', [[1, '第一门课', '在学径中拥有第一门课程'], [3, '课程汇聚', '聚合 3 门课程'], [6, '学期全景', '聚合 6 门课程', 'rare']]),
  ...series('material', '资料', 'materials', [[1, '第一份资料', '收纳第一份课程资料'], [10, '资料架成形', '收纳 10 份资料'], [30, '课程资料库', '收纳 30 份资料'], [80, '知识仓库', '收纳 80 份资料', 'rare']]),
  ...series('import', '资料', 'material_import', [[1, '主动收纳', '完成第一次手动资料导入'], [5, '渠道整合', '累计完成 5 次手动导入'], [20, '资料管理员', '累计完成 20 次手动导入', 'rare']]),
  ...series('sync', '起步', 'platform_sync', [[1, '第一次同步', '完成第一次平台同步'], [5, '信息常新', '完成 5 次平台同步'], [20, '双端节奏', '完成 20 次平台同步', 'rare']]),
  ...series('knowledge', '资料', 'knowledge_build', [[1, '建立索引', '第一次构建本地知识库'], [5, '持续整理', '完成 5 次知识库更新'], [20, '知识工程', '完成 20 次知识库更新', 'rare']]),
  ...series('ai', '资料', 'ai_refine', [[1, 'AI 助教上线', '完成第一次 AI 精炼'], [10, '精炼十份', 'AI 精炼 10 份资料'], [50, '课程知识地图', 'AI 精炼 50 份资料', 'milestone']]),
  ...series('review', '复习', 'review_completed', [[1, '第一次复习', '完成第一次复习会话'], [3, '渐入状态', '完成 3 次复习会话'], [10, '稳定复习者', '完成 10 次复习会话'], [30, '复习节奏', '完成 30 次复习会话', 'rare'], [100, '百次复习', '完成 100 次复习会话', 'milestone']]),
  ...series('review-minutes', '复习', 'review_minutes', [[60, '一小时沉浸', '累计复习 60 分钟'], [300, '五小时积累', '累计复习 300 分钟'], [1200, '二十小时航程', '累计复习 20 小时', 'milestone']]),
  ...series('confirm', '复习', 'confirmed_materials', [[1, '留下判断', '第一次完成资料掌握确认'], [10, '十份确认', '确认 10 份资料的掌握感受'], [50, '理解有据', '确认 50 份资料的掌握感受', 'rare']]),
  ...series('test', '测试', 'quick_test_completed', [[1, '第一次检测', '完成第一次快速测试'], [5, '主动验证', '完成 5 次快速测试'], [20, '检测习惯', '完成 20 次快速测试', 'rare'], [60, '六十次验证', '完成 60 次快速测试', 'milestone']]),
  ...series('tested-material', '测试', 'tested_materials', [[3, '覆盖三份', '快速测试覆盖 3 份不同资料'], [15, '覆盖十五份', '快速测试覆盖 15 份不同资料'], [50, '全面检测', '快速测试覆盖 50 份不同资料', 'milestone']]),
  ...series('high-score', '测试', 'high_score_tests', [[1, '八十分验证', '第一次快速测试达到 80%'], [5, '稳定发挥', '5 次快速测试达到 80%'], [20, '可靠掌握', '20 次快速测试达到 80%', 'rare']]),
  ...series('perfect', '测试', 'perfect_tests', [[1, '满分时刻', '第一次快速测试满分', 'rare'], [5, '五次满分', '累计 5 次快速测试满分', 'milestone']]),
  ...series('focus', '专注', 'focus_minutes', [[25, '一个番茄', '累计完成 25 分钟专注'], [100, '百分钟专注', '累计完成 100 分钟专注'], [500, '专注长跑', '累计完成 500 分钟专注', 'rare'], [1500, '二十五小时专注', '累计完成 25 小时专注', 'milestone']]),
  ...series('focus-session', '专注', 'focus_completed', [[10, '十轮专注', '完成 10 轮专注计时'], [50, '五十轮专注', '完成 50 轮专注计时', 'rare']]),
  ...series('assignment', '作业', 'completed_assignments', [[1, '第一项完成', '完成第一份作业'], [5, '作业清单', '完成 5 份作业'], [20, '按部就班', '完成 20 份作业', 'rare'], [50, '五十项交付', '完成 50 份作业', 'milestone']]),
  ...series('analysis', '作业', 'assignment_analyzed', [[1, '作业先分析', '第一次保存作业知识点映射'], [10, '带着目标做题', '分析 10 份作业', 'rare']]),
  ...series('journal', '记录', 'journal_days', [[1, '第一篇日记', '写下第一天学习记录'], [7, '七日有迹', '累计 7 个学习日记日期'], [30, '月度回望', '累计 30 个学习日记日期', 'rare'], [100, '百日成长史', '累计记录 100 天', 'milestone']]),
  ...series('active', '成长', 'active_days', [[3, '三日留痕', '在 3 个不同日期留下学习证据'], [14, '两周轨迹', '在 14 个不同日期留下学习证据'], [50, '五十个学习日', '在 50 个不同日期留下学习证据', 'rare'], [180, '半年成长轨迹', '在 180 个不同日期留下学习证据', 'milestone']]),
  ...series('schedule', '记录', 'schedule_adjusted', [[1, '安排下一步', '第一次调整复习日程'], [10, '计划可执行', '累计调整 10 次复习日程', 'rare']]),
  ...series('rating', '成长', 'knowledge_ratings', [[1, '第一次自评', '第一次给知识点留下自评'], [20, '认识自己', '自评 20 个知识点'], [100, '知识画像', '自评 100 个知识点', 'rare']]),
  ...series('mastery', '成长', 'mastered_concepts', [[5, '掌握五点', '将 5 个知识点自评为掌握'], [30, '知识网络成形', '将 30 个知识点自评为掌握', 'rare'], [100, '百点星图', '将 100 个知识点自评为掌握', 'milestone']]),
  ...series('course-complete', '成长', 'completed_courses', [[1, '一门课的终点', '完成一门课程的学习周期', 'rare'], [4, '学期收官', '完成 4 门课程的学习周期', 'milestone']]),
]

function dateKey(value: string) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return value.slice(0, 10)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function completedAssignment(assignment: Assignment) {
  return assignment.manualStatus === 'completed' || assignment.status === 'submitted' || assignment.status === 'graded'
}

function allQuickTests(context: AchievementContext) {
  return Object.values(context.reviewSessions).flatMap((session) => session.quickTests ?? []).filter((test) => test.status === 'completed')
}

export function metricValue(metric: AchievementMetric, context: AchievementContext): number {
  const eventMatches = context.events.filter((event) => event.type === metric)
  if (eventMatches.length || ['platform_sync', 'material_import', 'knowledge_build', 'ai_refine', 'review_started', 'review_completed', 'material_confirmed', 'quick_test_completed', 'focus_completed', 'assignment_completed', 'assignment_analyzed', 'journal_saved', 'schedule_adjusted', 'course_completed'].includes(metric)) {
    return eventMatches.length
  }
  const tests = allQuickTests(context)
  switch (metric) {
    case 'active_days': return new Set([...context.events.map((event) => dateKey(event.occurredAt)), ...context.journal.map((entry) => entry.date)]).size
    case 'courses': return context.courses.length
    case 'materials': return context.materials.filter((material) => material.kind !== 'folder').length
    case 'completed_assignments': return context.assignments.filter(completedAssignment).length
    case 'journal_days': return new Set(context.journal.map((entry) => entry.date)).size
    case 'tested_materials': return new Set(tests.flatMap((test) => test.questions.flatMap((question) => question.materialIds))).size
    case 'high_score_tests': return tests.filter((test) => (test.score ?? 0) >= 80).length
    case 'perfect_tests': return tests.filter((test) => test.score === 100).length
    case 'confirmed_materials': return new Set(Object.values(context.reviewSessions).flatMap((session) => Object.keys(session.materialAssessments ?? {}))).size
    case 'focus_minutes': return context.events.filter((event) => event.type === 'focus_completed').reduce((sum, event) => sum + (event.value ?? 0), 0)
    case 'review_minutes': return context.events.filter((event) => event.type === 'review_completed').reduce((sum, event) => sum + (event.value ?? 0), 0)
    case 'completed_courses': return context.courses.filter((course) => course.studyStatus === 'completed').length
    case 'knowledge_ratings': return Object.values(context.knowledgeRatings).filter((rating) => rating > 0).length
    case 'mastered_concepts': return Object.values(context.knowledgeRatings).filter((rating) => rating >= 4).length
    default: return 0
  }
}

function evidenceFor(definition: AchievementDefinition, context: AchievementContext, current: number) {
  const matching = context.events.filter((event) => event.type === definition.metric).slice(-Math.min(20, definition.threshold))
  return {
    ids: matching.map((event) => event.id),
    summary: `${definition.description}（当前 ${current}/${definition.threshold}）`,
  }
}

export function evaluateAchievements(context: AchievementContext, existingAwards: AchievementAward[], now = new Date().toISOString(), backfilled = false) {
  const awardedIds = new Set(existingAwards.map((award) => award.achievementId))
  const awards: AchievementAward[] = []
  for (const definition of ACHIEVEMENTS) {
    if (awardedIds.has(definition.id)) continue
    const current = metricValue(definition.metric, context)
    if (current < definition.threshold) continue
    const evidence = evidenceFor(definition, context, current)
    awards.push({ id: `award-${definition.id}`, achievementId: definition.id, awardedAt: now, evidenceEventIds: evidence.ids, evidenceSummary: evidence.summary, backfilled })
  }
  return awards
}

export function achievementProgress(context: AchievementContext, awards: AchievementAward[]): AchievementProgress[] {
  const byId = new Map(awards.map((award) => [award.achievementId, award]))
  return ACHIEVEMENTS.map((definition) => {
    const current = metricValue(definition.metric, context)
    return { definition, current, target: definition.threshold, percent: Math.min(100, Math.round(current / definition.threshold * 100)), awarded: byId.get(definition.id) }
  })
}

function event(id: string, type: LearningEventType, occurredAt: string, extra: Partial<LearningEvent> = {}): LearningEvent {
  return { id, type, occurredAt, ...extra }
}

export function backfillLearningEvents(input: Omit<AchievementContext, 'events'>): LearningEvent[] {
  const events: LearningEvent[] = []
  for (const entry of input.journal) events.push(event(`journal:${entry.id}`, 'journal_saved', `${entry.date}T12:00:00`, { title: entry.content.slice(0, 40) }))
  for (const assignment of input.assignments) {
    if (completedAssignment(assignment)) events.push(event(`assignment-complete:${assignment.id}`, 'assignment_completed', assignment.lastSyncedAt || new Date(0).toISOString(), { assignmentId: assignment.id, courseId: assignment.courseId, title: assignment.title }))
    if (assignment.manualKnowledgeIds?.length) events.push(event(`assignment-analysis:${assignment.id}:${assignment.aiKnowledge?.sourceKey ?? 'manual'}`, 'assignment_analyzed', assignment.aiKnowledge?.generatedAt || assignment.lastSyncedAt || new Date(0).toISOString(), { assignmentId: assignment.id, courseId: assignment.courseId, title: assignment.title }))
  }
  for (const [courseId, session] of Object.entries(input.reviewSessions)) {
    events.push(event(`review-start:${courseId}:${session.startedAt}`, 'review_started', session.startedAt, { courseId, sessionId: session.startedAt }))
    if (!session.active) {
      const endedAt = session.quickTests?.at(-1)?.generatedAt ?? Object.values(session.materialAssessmentAt ?? {}).sort().at(-1) ?? session.startedAt
      const minutes = Math.max(1, Math.round((new Date(endedAt).getTime() - new Date(session.startedAt).getTime()) / 60_000))
      events.push(event(`review-complete:${courseId}:${session.startedAt}`, 'review_completed', endedAt, { courseId, sessionId: session.startedAt, value: minutes }))
    }
    for (const record of session.materialReviewHistory ?? []) events.push(event(`material-confirm:${courseId}:${record.materialId}:${record.assessedAt}`, 'material_confirmed', record.assessedAt, { courseId, materialId: record.materialId, value: 1 }))
    for (const test of session.quickTests ?? []) if (test.status === 'completed') events.push(event(`quick-test:${test.id}`, 'quick_test_completed', test.generatedAt, { courseId, sessionId: session.startedAt, score: test.score, value: 1 }))
  }
  for (const course of input.courses) if (course.studyStatus === 'completed' && course.completedAt) events.push(event(`course-complete:${course.id}:${course.completedAt}`, 'course_completed', course.completedAt, { courseId: course.id, title: course.name }))
  return mergeLearningEvents([], events)
}

export function mergeLearningEvents(current: LearningEvent[], incoming: LearningEvent[], limit = 5000) {
  const byId = new Map(current.map((item) => [item.id, item]))
  for (const item of incoming) if (item.id && item.occurredAt && !byId.has(item.id)) byId.set(item.id, item)
  return [...byId.values()].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)).slice(-limit)
}

export function definitionForAward(award: AchievementAward) {
  return ACHIEVEMENTS.find((definition) => definition.id === award.achievementId)
}
