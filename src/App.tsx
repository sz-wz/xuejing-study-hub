import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import {
  BookOpen, CalendarDays, ChevronDown, ChevronLeft, ChevronRight, CloudDownload, Database, FileText,
  Archive, Award, BookOpenCheck, Command as CommandIcon, Folder, FolderOpen, GraduationCap, Inbox, Link2, LogIn, Mail, MonitorCog, Network, Palette, Plus, RefreshCw, Search, Send, Settings2, Star, Timer, Trophy, Upload, X,
} from 'lucide-react'
import { mergeBlackboardCourses } from './blackboard-import'
import { mergeBlackboardMaterials } from './blackboard-material-import'
import { mergeBlackboardAssignments } from './blackboard-assignment-import'
import { mergeGradescopeAssignments, mergeGradescopeCourses } from './gradescope-import'
import { buildCourseGrowthMetrics, buildGrowthActivity, visibleCourseMetrics } from './growth-metrics'
import { buildGrowthSnapshotSeries, createGrowthSnapshot, upsertGrowthSnapshot, type GrowthSnapshot } from './growth-snapshots'
import { applyCachedItems } from './cache-state'
import { assignmentAiSourceKey, parseAssignmentAiMatch } from './assignment-ai-match'
import { createManualAssignment } from './manual-assignment'
import { activeCourseIds, completeCourse, reopenCourse } from './course-lifecycle'
import { buildConceptEvidence, conceptEvidenceLabels, conceptNeedsReview } from './concept-evidence'
import { buildGlobalSearchEntries, mergeBodySearchResults, searchGlobalEntries, type BodySearchResult, type GlobalSearchEntry, type SearchCommand } from './global-search'
import { DEFAULT_SHORTCUT_PREFERENCES, SHORTCUT_DEFINITIONS, acceleratorFromEvent, displayAccelerator, normalizeShortcutPreferences, resolveConfiguredShortcut, shortcutConflict, shortcutForAction } from './shortcut-preferences'
import { detectSyncChanges, emailDeliveryInboxItem, mergeSyncInbox, resolveSyncConnectionItems, syncConnectionRequiredItem, unreadSyncInboxCount, updateSyncInboxItems, type SyncInboxItem } from './sync-inbox'
import { AUTO_SYNC_INTERVALS, DEADLINE_EMAIL_THRESHOLDS, automaticSyncDelayMs, deadlineEmailCandidates, isQuietHour, type AutoSyncPreferences, type DeadlineEmailThreshold } from './background-sync'
import { assignmentDueAt, deadlineLabel, deadlineReminderBucket, deadlineState, toDateTimeLocalValue } from './deadline-utils'
import { KnowledgeMap } from './knowledge-map'
import { createReviewSession, ReviewWorkspace, type ReviewSelection, type ReviewSession } from './review-workspace'
import { buildReviewHistory, calendarTaskStatus, distributeAcrossWeek, inactiveReviewDays, shiftDate, suggestionIsDismissed, weekDateKeys } from './review-calendar'
import { buildReviewQueue, createReviewScheduleEntry, reviewQueueProgress, reviewTargetKey, selectionForReviewQueueItem, suggestedNextReviewDate, type ReviewQueueItem, type ReviewScheduleEntry } from './review-queue'
import { isFolderExpanded, toggledFolders } from './library-tree'
import type { Assignment, AssignmentFile, AssignmentStatus, Course, JournalEntry, Material } from './types'
import { DEFAULT_APP_PREFERENCES, normalizeAppPreferences, resolveTheme, type AppPreferences, type ThemePreference } from './app-preferences'
import { concreteCourseId, normalizeCourseFilter } from './course-filter'
import { defaultRefinementSelection, eligibleRefinementDocuments, refinementState, toggleAllRefinementSelection } from './knowledge-refinement'
import { recommendedVersionChanges } from './material-version-selection'
import type { RefinementJob } from './electron'
import { mergeEmailDigestQueue, shouldFlushDailyDigest, syncEmailEventsForMode, type SyncEmailMode } from './email-sync-policy'
import { ACHIEVEMENTS, achievementProgress, backfillLearningEvents, definitionForAward, evaluateAchievements, mergeLearningEvents, type AchievementAward, type LearningEvent } from './achievements'
import { buildLearningCalendarItems, buildMonthGrid, filterLearningCalendarItems, localDateKey, shiftMonth, type LearningCalendarKind } from './learning-calendar'
import { planCelebrations, type Celebration, type CelebrationHistoryItem } from './achievement-celebration'
import growthJourneyImage from './assets/growth-journey.png'

type Section = 'overview' | 'inbox' | 'library' | 'assignments' | 'knowledge' | 'map' | 'review' | 'schedule' | 'focus' | 'growth' | 'settings'
type ConceptRating = 0 | 1 | 2 | 3 | 4
type KnowledgeDocumentFilter = 'ready' | 'ocr' | 'unsupported' | 'failed' | 'all'
type EmailSettings = { configured: boolean; enabled: boolean; host: string; port: number; secure: boolean; username: string; from: string; recipient: string; notifyCourseUpdates: boolean; notifyDeadlines: boolean; syncEmailMode: SyncEmailMode; syncDigestHour: number }
type AiProvider = 'openai' | 'deepseek' | 'gemini' | 'custom'
type AiCapabilities = { provider: AiProvider; chat: boolean; files: boolean; responses: boolean; refinementMode: 'original-file' | 'structured-pages'; detectedAt: string; latencyMs: number }
type AiConfiguration = { configured: boolean; provider: AiProvider; baseUrl: string; model: string; capabilities?: AiCapabilities }
type AiProviderPreset = { id: AiProvider; label: string; baseUrl: string; description: string }
type AutoSyncStatus = { state: 'idle' | 'scheduled' | 'syncing' | 'paused' | 'error'; lastAttempt?: string; lastSuccess?: string; nextAt?: string; message: string; consecutiveFailures: number }
type StudyState = { courses: Course[]; materials: Material[]; assignments: Assignment[]; journal: JournalEntry[]; knowledgeRatings: Record<string, ConceptRating>; reviewSelections: Record<string, ReviewSelection>; reviewSessions: Record<string, ReviewSession>; reviewSchedule: ReviewScheduleEntry[]; dismissedReviewSuggestions: Record<string, string>; growthSnapshots: GrowthSnapshot[]; syncInbox: SyncInboxItem[]; learningEvents: LearningEvent[]; achievementAwards: AchievementAward[]; achievementBackfillVersion: number }
type TreeNode = { folders: Map<string, TreeNode>; entries: Material[] }
type FileState = 'available' | 'missing'
type KnowledgeLocation = { materialId: string; kind: 'pdf-page' | 'pptx-slide' | 'docx-section'; start: number; end?: number; confidence?: number; evidence?: string; method?: string; candidate?: boolean; manual?: boolean }
type KnowledgePageIndex = { version: number; generatedAt: string; pages: number; concepts: number; located: number; candidates: number; model?: string; cloudError?: string }
type KnowledgeAiConcept = { title: string; evidence: string; aliases?: string[]; locations?: KnowledgeLocation[]; locationCandidates?: KnowledgeLocation[] }
type KnowledgeAiProfile = { summary: string; concepts: KnowledgeAiConcept[]; model: string; generatedAt: string; sourceHash?: string; mode?: 'quick' | 'deep' | 'original'; analysisMethod?: 'original-file' | 'structured-pages'; inputStrategy?: 'local-structured-pages'; originalFile?: { filename: string; bytes: number; uploadedAt: string }; locationBatches?: number; coverage?: { covered: number; total: number; percent: number; omittedRanges?: { kind: string; start: number; end: number }[] }; pageIndex?: KnowledgePageIndex }
type KnowledgeDocument = { materialId: string; courseId: string; courseName: string; title: string; localPath: string; sourceUrl?: string; status: string; hash?: string; format?: string; error?: string; outline?: string[]; outlineLocations?: { title: string; locations: KnowledgeLocation[] }[]; textLength?: number; segmentCount?: number; knowledgeRole?: 'courseware' | 'reference'; ocr?: { pages: number; totalPages: number; language: string; truncated: boolean }; ai?: KnowledgeAiProfile; aiProfiles?: { quick?: KnowledgeAiProfile; deep?: KnowledgeAiProfile; original?: KnowledgeAiProfile } }
type KnowledgeIndex = { documents: KnowledgeDocument[]; concepts: { id: string; title: string; aliases?: string[]; sourceIds: string[]; courseIds: string[]; locations?: KnowledgeLocation[] }[]; stats: { total: number; parsed: number; ocr: number; image: number; failed: number; unsupported: number; reference: number; concepts: number } }
type PageLocationEditorState = { materialId: string; documentTitle: string; conceptTitle: string; kind: KnowledgeLocation['kind']; pageCount: number; locations: KnowledgeLocation[]; candidates: KnowledgeLocation[] }
type MaterialVersionCatalog = { groups: MaterialVersionGroup[]; duplicates: { hash: string; keepPath: string; duplicatePaths: string[]; safeCleanupPaths: string[] }[] }
type MaterialVersionGroup = { materialId: string; courseId: string; baseTitle: string; displayTitle: string; relation: 'single' | 'versions' | 'source-conflict'; activePath: string; recommendedPath: string; versions: { id: string; localPath: string; hash: string; importedAt: string; bytes: number; pages: number; descriptor: string; current: boolean }[] }

function refinementJobStatusLabel(status: RefinementJob['status']) {
  return ({ running: '后台运行中', pausing: '将在安全断点暂停', paused: '已暂停', cancelling: '正在停止', interrupted: '已中断，可继续', completed: '已完成', completed_with_errors: '部分完成', failed: '任务失败' } as const)[status]
}

const STORAGE_KEY = 'xuejing-study-hub-v3'
const emptyStudy: StudyState = { courses: [], materials: [], assignments: [], journal: [], knowledgeRatings: {}, reviewSelections: {}, reviewSessions: {}, reviewSchedule: [], dismissedReviewSuggestions: {}, growthSnapshots: [], syncInbox: [], learningEvents: [], achievementAwards: [], achievementBackfillVersion: 0 }
const courseColors = ['#336a58', '#bf6a48', '#6a5f9e', '#3d7890', '#8a6a3d', '#a35e79']
const APP_PREFERENCES_KEY = 'xuejing-app-preferences-v1'
const EMAIL_DIGEST_QUEUE_KEY = 'xuejing-email-digest-queue-v1'
const EMAIL_DIGEST_LAST_SENT_KEY = 'xuejing-email-digest-last-sent-v1'
const CELEBRATION_HISTORY_KEY = 'xuejing-celebration-history-v1'
const SEARCH_COMMANDS: SearchCommand[] = [
  { id: 'nav-1', title: '打开学习总览', subtitle: '查看 DDL、今日复习队列和资料状态', keywords: '首页 总览', shortcut: 'Ctrl+1' },
  { id: 'nav-inbox', title: '打开学习收件箱', subtitle: '查看平台同步后新增和变化的信息', keywords: '收件箱 更新 变化 通知', shortcut: '' },
  { id: 'nav-2', title: '打开课程资料', subtitle: '浏览课程目录和本地缓存', keywords: '资料 文件', shortcut: 'Ctrl+2' },
  { id: 'nav-3', title: '打开作业中心', subtitle: '查看作业、DDL 和提交入口', keywords: '作业 ddl', shortcut: 'Ctrl+3' },
  { id: 'nav-4', title: '打开知识库', subtitle: '查看解析结果与课程知识点', keywords: '知识 解析', shortcut: 'Ctrl+4' },
  { id: 'nav-5', title: '打开知识图谱', subtitle: '浏览课程主题和资料关系', keywords: '图谱 地图', shortcut: 'Ctrl+5' },
  { id: 'nav-6', title: '打开期末复习', subtitle: '选择资料与知识点开始复习', keywords: '复习 会话', shortcut: 'Ctrl+6' },
  { id: 'nav-7', title: '打开复习日程', subtitle: '查看和调整本周复习任务', keywords: '日程 计划', shortcut: 'Ctrl+7' },
  { id: 'nav-8', title: '打开专注计时', subtitle: '使用番茄钟开始专注', keywords: '番茄钟 计时', shortcut: 'Ctrl+8' },
  { id: 'nav-9', title: '打开成长日记', subtitle: '查看成长证据和每日记录', keywords: '成长 日记', shortcut: 'Ctrl+9' },
  { id: 'nav-0', title: '打开设置中心', subtitle: '调整外观、提醒和应用行为', keywords: '设置 配置', shortcut: 'Ctrl+0 / Ctrl+,' },
  { id: 'sync-blackboard', title: '同步 Blackboard', subtitle: '连接或同步课程、资料与作业', keywords: 'bb 平台', shortcut: 'Ctrl+Shift+B' },
  { id: 'sync-gradescope', title: '同步 Gradescope', subtitle: '连接或同步课程和作业状态', keywords: 'grade 平台', shortcut: 'Ctrl+Shift+G' },
  { id: 'import-materials', title: '导入本地资料', subtitle: '从电脑、微信或 QQ 资料目录添加文件', keywords: '添加 文件', shortcut: 'Ctrl+Shift+I' },
  { id: 'build-knowledge', title: '构建 / 更新知识库', subtitle: '解析当前本地课程资料', keywords: '解析 更新', shortcut: 'Ctrl+Shift+K' },
  { id: 'toggle-focus', title: '开始 / 暂停番茄钟', subtitle: '切换到专注页并控制当前计时', keywords: '专注 暂停', shortcut: 'Ctrl+Alt+P' },
  { id: 'add-assignment', title: '手动添加作业', subtitle: '添加其他平台、课程群或线下作业', keywords: '新建 作业', shortcut: 'Ctrl+Alt+A' },
]

function loadAppPreferences(): AppPreferences {
  try {
    return normalizeAppPreferences(JSON.parse(localStorage.getItem(APP_PREFERENCES_KEY) ?? 'null'))
  } catch {
    return DEFAULT_APP_PREFERENCES
  }
}

function loadAutoSyncStatus(): AutoSyncStatus {
  try {
    const value = JSON.parse(localStorage.getItem('xuejing-auto-sync-status-v1') ?? 'null') as Partial<AutoSyncStatus> | null
    return value && typeof value === 'object' ? { state: 'idle', message: '', consecutiveFailures: 0, ...value } : { state: 'idle', message: '', consecutiveFailures: 0 }
  } catch {
    return { state: 'idle', message: '', consecutiveFailures: 0 }
  }
}

function loadEmailDigestQueue(): SyncInboxItem[] {
  try {
    const value = JSON.parse(localStorage.getItem(EMAIL_DIGEST_QUEUE_KEY) ?? '[]')
    return Array.isArray(value) ? value : []
  } catch {
    return []
  }
}

function loadCelebrationHistory(): CelebrationHistoryItem[] {
  try {
    const value = JSON.parse(localStorage.getItem(CELEBRATION_HISTORY_KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is CelebrationHistoryItem => Boolean(item && typeof item.displayedAt === 'string' && ['common', 'rare', 'milestone'].includes(item.tier))).slice(-100) : []
  } catch {
    return []
  }
}

function loadStudy(): StudyState {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Partial<StudyState>
    const sourceMaterials = Array.isArray(stored.materials) ? stored.materials : []
    const legacyAssignments: Assignment[] = sourceMaterials.flatMap((material) => {
      if (material.kind !== 'assignment' || (material.source !== 'Blackboard' && material.source !== 'Gradescope') || !material.url) return []
      return [{
        id: `legacy-assignment-${material.id}`,
        courseId: material.courseId,
        source: material.source,
        sourceCourseName: '',
        term: material.term || (material.source === 'Gradescope' ? '未分期' : 'Blackboard'),
        title: material.title,
        url: material.url,
        dueLabel: material.meta,
        status: 'unknown',
        lastSyncedAt: '',
      }]
    })
    return {
      courses: Array.isArray(stored.courses) ? stored.courses : [],
      materials: sourceMaterials.filter((material) => material.kind !== 'assignment' || (material.source !== 'Blackboard' && material.source !== 'Gradescope')),
      assignments: Array.isArray(stored.assignments) ? stored.assignments : legacyAssignments,
      journal: Array.isArray(stored.journal) ? stored.journal : [],
      knowledgeRatings: stored.knowledgeRatings && typeof stored.knowledgeRatings === 'object' ? stored.knowledgeRatings as Record<string, ConceptRating> : {},
      reviewSelections: stored.reviewSelections && typeof stored.reviewSelections === 'object' ? stored.reviewSelections as StudyState['reviewSelections'] : {},
      reviewSessions: stored.reviewSessions && typeof stored.reviewSessions === 'object' ? stored.reviewSessions as StudyState['reviewSessions'] : {},
      reviewSchedule: Array.isArray(stored.reviewSchedule) ? stored.reviewSchedule.filter((entry): entry is ReviewScheduleEntry => Boolean(entry && typeof entry.id === 'string' && typeof entry.scheduledDate === 'string')) : [],
      dismissedReviewSuggestions: stored.dismissedReviewSuggestions && typeof stored.dismissedReviewSuggestions === 'object' ? stored.dismissedReviewSuggestions as Record<string, string> : {},
      growthSnapshots: Array.isArray(stored.growthSnapshots) ? stored.growthSnapshots.filter((snapshot): snapshot is GrowthSnapshot => Boolean(snapshot && typeof snapshot.date === 'string' && Array.isArray(snapshot.courses))) : [],
      syncInbox: Array.isArray(stored.syncInbox) ? stored.syncInbox.filter((item): item is SyncInboxItem => Boolean(item && typeof item.id === 'string' && typeof item.kind === 'string' && typeof item.createdAt === 'string')) : [],
      learningEvents: Array.isArray(stored.learningEvents) ? stored.learningEvents.filter((item): item is LearningEvent => Boolean(item && typeof item.id === 'string' && typeof item.type === 'string' && typeof item.occurredAt === 'string')).slice(-5000) : [],
      achievementAwards: Array.isArray(stored.achievementAwards) ? stored.achievementAwards.filter((item): item is AchievementAward => Boolean(item && typeof item.id === 'string' && typeof item.achievementId === 'string' && typeof item.awardedAt === 'string')) : [],
      achievementBackfillVersion: typeof stored.achievementBackfillVersion === 'number' ? stored.achievementBackfillVersion : 0,
    }
  } catch {
    return emptyStudy
  }
}

function buildTree(materials: Material[]): TreeNode {
  const root: TreeNode = { folders: new Map(), entries: [] }
  for (const material of materials) {
    let current = root
    for (const segment of material.path?.filter(Boolean) ?? []) {
      let next = current.folders.get(segment)
      if (!next) {
        next = { folders: new Map(), entries: [] }
        current.folders.set(segment, next)
      }
      current = next
    }
    if (material.kind !== 'folder') current.entries.push(material)
  }
  return root
}

function folderKey(courseId: string, parts: string[]) {
  return `${courseId}::${parts.join('/')}`
}

function messageOf(error: unknown) {
  return error instanceof Error ? error.message : '操作没有完成，请稍后重试。'
}

function calendarDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function materialIcon(material: Material) {
  if (material.kind === 'assignment') return <Send size={14} />
  if (material.kind === 'link') return <Link2 size={14} />
  return <FileText size={14} />
}

function materialKnowledgeRole(material: Material): 'courseware' | 'reference' {
  if (material.knowledgeRole) return material.knowledgeRole
  const label = [material.title, ...(material.path ?? [])].join(' ').toLocaleLowerCase()
  return /(?:textbook|reference|course reader|教材|教科书|课本|参考书)/u.test(label) ? 'reference' : 'courseware'
}

function buildKnowledgeDocuments(study: Pick<StudyState, 'courses' | 'materials'>) {
  const coursesById = new Map(study.courses.map((course) => [course.id, course]))
  return study.materials.filter((material) => material.localPath).map((material) => ({
    materialId: material.id,
    courseId: material.courseId,
    courseName: coursesById.get(material.courseId)?.name ?? '未分类课程',
    title: material.title,
    localPath: material.localPath!,
    type: material.type,
    sourceUrl: material.url,
    knowledgeRole: materialKnowledgeRole(material),
  }))
}

function effectiveAssignmentStatus(assignment: Assignment): AssignmentStatus {
  return assignment.manualStatus === 'completed' ? 'manual_completed' : assignment.status
}

function assignmentCompleted(assignment: Assignment) {
  return ['submitted', 'graded', 'manual_completed'].includes(effectiveAssignmentStatus(assignment))
}

function assignmentStatusLabel(assignment: Assignment) {
  const status = effectiveAssignmentStatus(assignment)
  if (status === 'graded') return assignment.score !== undefined && assignment.maxScore !== undefined ? `已批改 ${assignment.score}/${assignment.maxScore}` : '已批改'
  if (status === 'submitted') return '已提交，待批改'
  if (status === 'manual_completed') return '手动完成'
  if (status === 'not_submitted') return '未提交'
  return '待确认'
}

function knowledgeDocumentBucket(document: KnowledgeIndex['documents'][number]): Exclude<KnowledgeDocumentFilter, 'all'> {
  if (document.status === 'parsed' || document.status === 'ocr') return 'ready'
  if (document.status === 'image') return 'ocr'
  if (document.status === 'unsupported' || document.status === 'skipped') return 'unsupported'
  return 'failed'
}

type TreeProps = {
  node: TreeNode
  course: Course
  path: string[]
  expanded: ReadonlySet<string>
  busyKey: string | null
  fileStates: ReadonlyMap<string, FileState>
  onToggle: (path: string[]) => void
  onCache: (material: Material) => void
  onOpenSubmission: (url: string) => void
  onOpenLink: (url: string) => void
}

function MaterialTree({ node, course, path, expanded, busyKey, fileStates, onToggle, onCache, onOpenSubmission, onOpenLink }: TreeProps) {
  return (
    <>
      {[...node.folders.entries()].map(([name, child]) => {
        const nextPath = [...path, name]
        const key = folderKey(course.id, nextPath)
        const isOpen = isFolderExpanded(expanded, key)
        return (
          <div className="folder-branch" key={key}>
            <button className="folder-row" onClick={() => onToggle(nextPath)} aria-expanded={isOpen}>
              <span>{isOpen ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
              {isOpen ? <FolderOpen size={15} /> : <Folder size={15} />}
              <strong>{name}</strong>
              <small>{child.entries.length + child.folders.size}</small>
            </button>
            {isOpen && <div className="folder-children"><MaterialTree {...{ node: child, course, path: nextPath, expanded, busyKey, fileStates, onToggle, onCache, onOpenSubmission, onOpenLink }} /></div>}
          </div>
        )
      })}
      {node.entries.map((material) => {
        const caching = busyKey === `cache:${material.id}`
        const courseCaching = busyKey === 'cache-course'
        const fileState = material.localPath ? fileStates.get(material.localPath) : undefined
        const missing = fileState === 'missing'
        const canCache = material.kind !== 'assignment' && material.source === 'Blackboard' && Boolean(material.url) && (!material.localPath || missing)
        return (
          <div className={`library-entry ${material.kind ?? 'file'}`} key={material.id}>
            <span className="entry-icon">{materialIcon(material)}</span>
            <div>
              <strong title={material.title}>{material.title}</strong>
              <span>{material.meta || material.type}</span>
            </div>
            {material.localPath ? <em className={missing ? 'cache-missing' : ''}>{missing ? '文件缺失' : fileState === 'available' ? '已缓存' : '检查中'}</em> : null}
            {canCache ? <button className="submission-button" disabled={caching || courseCaching} onClick={() => onCache(material)}>{caching ? '缓存中…' : missing ? '重新缓存' : '缓存到本地'}</button> : null}
            {material.kind === 'assignment' && material.url ? <button className="submission-button" onClick={() => onOpenSubmission(material.url!)}>前往提交</button> : null}
            {material.kind === 'link' && material.url ? <button className="submission-button" onClick={() => onOpenLink(material.url!)}>打开链接</button> : null}
          </div>
        )
      })}
    </>
  )
}

type KnowledgeDocumentListProps = {
  documents: KnowledgeIndex['documents']
  expanded: ReadonlySet<string>
  onToggle: (materialId: string) => void
  onRoleChange: (materialId: string, role: 'courseware' | 'reference') => void
  onOcr: (materialId: string) => void
  onRefine: (materialId: string) => void
  onEditLocation: (document: KnowledgeDocument, concept: KnowledgeAiConcept) => void
  versionGroups: ReadonlyMap<string, MaterialVersionGroup>
  onVersionChange: (group: MaterialVersionGroup, localPath: string) => void
  aiConfigured: boolean
  busyKey: string | null
}

function knowledgeLocationLabel(location: KnowledgeLocation) {
  const range = location.end && location.end !== location.start ? `${location.start}–${location.end}` : String(location.start)
  return location.kind === 'pptx-slide' ? `幻灯片 ${range}` : location.kind === 'pdf-page' ? `第 ${range} 页` : `章节 ${range}`
}

function knowledgeLocationsLabel(locations: KnowledgeLocation[] = []) {
  if (!locations.length) return ''
  const visible = locations.slice(0, 2).map(knowledgeLocationLabel).join('、')
  return locations.length > 2 ? `${visible} 等 ${locations.length} 处` : visible
}

function inferredKnowledgeLocationKind(document: KnowledgeDocument): KnowledgeLocation['kind'] {
  const located = document.ai?.concepts.flatMap((concept) => [...(concept.locations ?? []), ...(concept.locationCandidates ?? [])])[0]
  if (located?.kind) return located.kind
  const format = `${document.format ?? ''} ${document.localPath}`.toLowerCase()
  return /\.pptx?\b/.test(format) ? 'pptx-slide' : /\.pdf\b/.test(format) ? 'pdf-page' : 'docx-section'
}

function pageLocationEditorFor(document: KnowledgeDocument, conceptTitle: string): PageLocationEditorState | null {
  const concept = document.ai?.concepts.find((item) => item.title === conceptTitle)
  if (!concept) return null
  return {
    materialId: document.materialId,
    documentTitle: document.title,
    conceptTitle,
    kind: inferredKnowledgeLocationKind(document),
    pageCount: document.ai?.pageIndex?.pages ?? document.segmentCount ?? 0,
    locations: concept.locations ?? [],
    candidates: concept.locationCandidates ?? [],
  }
}

function KnowledgeDocumentList({ documents, expanded, onToggle, onRoleChange, onOcr, onRefine, onEditLocation, versionGroups, onVersionChange, aiConfigured, busyKey }: KnowledgeDocumentListProps) {
  return <div className="knowledge-document-list">{documents.map((document) => {
    const isParsed = document.status === 'parsed' || document.status === 'ocr'
    const isExpanded = expanded.has(document.materialId)
    const isReference = document.knowledgeRole === 'reference'
    const originalAi = document.aiProfiles?.original ?? (document.ai?.mode === 'original' || document.ai?.analysisMethod === 'original-file' ? document.ai : undefined)
    const originalAiCurrent = Boolean(originalAi && (!originalAi.sourceHash || originalAi.sourceHash === document.hash))
    const legacyAi = !originalAi && document.ai
    const versionGroup = versionGroups.get(document.materialId)
    const displayTitle = versionGroup?.displayTitle ?? document.title
    const indexedConcepts = document.ai?.concepts?.length ? document.ai.concepts : document.outlineLocations ?? []
    const locatedCount = indexedConcepts.filter((concept) => concept.locations?.length).length
    const candidateCount = document.ai?.pageIndex?.candidates ?? document.ai?.concepts.filter((concept) => concept.locationCandidates?.length).length ?? 0
    return <article className={isExpanded ? 'expanded-document' : ''} key={document.materialId}>
      <div className="knowledge-document-heading">
        <FileText size={15} />
        <div className="knowledge-document-main">
          <strong title={document.title}>{displayTitle}</strong>
          <span>{document.courseName} · {isParsed ? (document.outline?.length ?? 0) + ' 个本资料知识点' : document.error ?? '等待解析'}{isReference ? ' · 教材/参考资料' : ''}</span>
        </div>
      </div>
      <div className="knowledge-document-actions">
        {isParsed && <button className="knowledge-document-toggle" onClick={() => onToggle(document.materialId)} aria-expanded={isExpanded}>{isExpanded ? '收起知识点' : '查看知识点'}</button>}
        {document.status === 'image' && <button className="knowledge-document-toggle" disabled={busyKey === 'ocr:' + document.materialId || Boolean(busyKey?.startsWith('reindex'))} onClick={() => onOcr(document.materialId)}>{busyKey === 'ocr:' + document.materialId ? 'OCR 中…' : '本地 OCR'}</button>}
        {isParsed && !isReference && <button className="knowledge-document-toggle" disabled={!aiConfigured || busyKey === 'version-switch'} onClick={() => onRefine(document.materialId)}>{originalAiCurrent ? '重新 AI 精炼' : 'AI 精炼'}</button>}
        <button className="knowledge-document-toggle" onClick={() => onRoleChange(document.materialId, isReference ? 'courseware' : 'reference')}>{isReference ? '改为课件' : '设为教材'}</button>
        {versionGroup && versionGroup.versions.length > 1 ? <label className={`material-version-picker ${versionGroup.relation}`}><span>{versionGroup.relation === 'source-conflict' ? '来源冲突' : `${versionGroup.versions.length} 个版本`}</span><select value={versionGroup.activePath} disabled={busyKey === 'version-switch'} onChange={(event) => onVersionChange(versionGroup, event.target.value)}>{versionGroup.versions.map((version, index) => <option key={version.id} value={version.localPath}>{index === 0 ? '最新 · ' : ''}{version.descriptor}{version.importedAt ? ` · ${new Date(version.importedAt).toLocaleDateString()}` : ''}</option>)}</select></label> : null}
        <em className={'knowledge-status ' + document.status}>{isParsed ? (document.status === 'ocr' ? '已 OCR' : isReference ? '参考资料' : '已解析') : document.status === 'failed' ? '失败' : document.status === 'image' ? '等待 OCR' : document.status === 'empty' ? '无文本' : '暂不支持'}</em>
        {originalAi ? <em className={'knowledge-status ai-refined ' + (originalAiCurrent ? '' : 'stale')} title={`模型：${originalAi.model}；${new Date(originalAi.generatedAt).toLocaleString()}`}>{originalAiCurrent ? 'AI 已精炼' : 'AI 待更新'}</em> : legacyAi ? <em className="knowledge-status ai-refined stale" title="旧版文本精炼结果会继续保留；重新精炼时会按当前 API 能力自动选择精炼方式。">旧版 AI 结果</em> : null}
        {originalAiCurrent ? <em className="knowledge-status ai-mode">{originalAi?.analysisMethod === 'original-file' ? '原件直传' : originalAi?.analysisMethod === 'structured-pages' ? '分页兼容' : 'AI 分析'}</em> : null}
        {originalAiCurrent && originalAi?.coverage ? <em className="knowledge-status page-analyzed" title={originalAi.coverage.percent < 100 ? '当前精炼流程只覆盖了部分页面' : '当前精炼流程已覆盖完整资料'}>页面分析 {originalAi.coverage.percent}%</em> : null}
        {isParsed && indexedConcepts.length ? <em className="knowledge-status page-indexed" title={`${locatedCount}/${indexedConcepts.length} 个知识点已有确认页码或幻灯片范围`}>知识定位 {locatedCount}/{indexedConcepts.length}</em> : null}
        {candidateCount ? <em className="knowledge-status page-candidate" title="这些范围尚未达到自动确认阈值，可展开知识点后人工确认或忽略">候选页 {candidateCount} 项</em> : null}
      </div>
      {isParsed && isExpanded && <div className="document-concepts"><span>{document.ai?.summary || (isReference ? '该教材提取的参考主题（不会进入课程知识点）' : '本资料提取的候选知识点')}{document.ai?.locationBatches ? ` · AI 分 ${document.ai.locationBatches} 组分析页面` : ''}</span><div>{indexedConcepts.length ? indexedConcepts.map((concept) => { const aiConcept = 'evidence' in concept ? concept as KnowledgeAiConcept : null; const candidates = aiConcept?.locationCandidates ?? []; return <i className={`${concept.locations?.length ? 'located' : ''} ${candidates.length ? 'has-candidates' : ''}`} key={concept.title} title={'evidence' in concept ? concept.evidence : concept.title}><b>{concept.title}</b>{concept.locations?.length ? <small>{knowledgeLocationsLabel(concept.locations)}</small> : <small>尚无已确认页码</small>}{candidates.length ? <small className="candidate-location">待确认：{knowledgeLocationsLabel(candidates)}</small> : null}{aiConcept ? <button type="button" onClick={() => onEditLocation(document, aiConcept)}>编辑页码</button> : null}</i> }) : <small>未提取到足够可靠的知识点。</small>}</div></div>}
    </article>
  })}</div>
}

export default function App() {
  const [study, setStudy] = useState<StudyState>(loadStudy)
  const studyRef = useRef(study)
  const [section, setSection] = useState<Section>('overview')
  const [appPreferences, setAppPreferences] = useState<AppPreferences>(loadAppPreferences)
  const [systemDark, setSystemDark] = useState(() => window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false)
  const [showLaunchAnimation, setShowLaunchAnimation] = useState(() => loadAppPreferences().launchAnimationEnabled)
  const [keepRunningInTray, setKeepRunningInTray] = useState(false)
  const [appBehaviorBusy, setAppBehaviorBusy] = useState(false)
  const [autoSyncStatus, setAutoSyncStatus] = useState<AutoSyncStatus>(loadAutoSyncStatus)
  const [vaultRoot, setVaultRoot] = useState('正在读取资料库位置…')
  const [fileStates, setFileStates] = useState<Map<string, FileState>>(() => new Map())
  const [autoCacheEnabled, setAutoCacheEnabled] = useState(() => localStorage.getItem('xuejing-auto-cache-v1') !== 'false')
  const [connected, setConnected] = useState(false)
  const [gradescopeConnected, setGradescopeConnected] = useState(false)
  const [platformStatusReady, setPlatformStatusReady] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [showCommandCenter, setShowCommandCenter] = useState(false)
  const [commandQuery, setCommandQuery] = useState('')
  const [commandSelectionIndex, setCommandSelectionIndex] = useState(0)
  const [bodySearchResults, setBodySearchResults] = useState<BodySearchResult[]>([])
  const [bodySearchBusy, setBodySearchBusy] = useState(false)
  const commandInputRef = useRef<HTMLInputElement | null>(null)
  const [recordingShortcutId, setRecordingShortcutId] = useState<string | null>(null)
  const [shortcutError, setShortcutError] = useState('')
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set())
  const [showImport, setShowImport] = useState(false)
  const [showMigration, setShowMigration] = useState(false)
  const [migrationTarget, setMigrationTarget] = useState('')
  const [migrationProgress, setMigrationProgress] = useState<{ completed: number; total: number; title: string } | null>(null)
  const [knowledgeIndex, setKnowledgeIndex] = useState<KnowledgeIndex | null>(null)
  const [materialVersionCatalog, setMaterialVersionCatalog] = useState<MaterialVersionCatalog>({ groups: [], duplicates: [] })
  const [knowledgeProgress, setKnowledgeProgress] = useState<{ completed: number; total: number; title: string } | null>(null)
  const [expandedKnowledgeDocuments, setExpandedKnowledgeDocuments] = useState<Set<string>>(() => new Set())
  const [knowledgeCourseFilter, setKnowledgeCourseFilter] = useState<'current' | 'all' | string>('current')
  const [knowledgeDocumentFilter, setKnowledgeDocumentFilter] = useState<KnowledgeDocumentFilter>('ready')
  const [pageLocationEditor, setPageLocationEditor] = useState<PageLocationEditorState | null>(null)
  const [pageLocationDraftStart, setPageLocationDraftStart] = useState('')
  const [pageLocationDraftEnd, setPageLocationDraftEnd] = useState('')
  const [mapCourseFilter, setMapCourseFilter] = useState('all')
  const [reviewCourseFilter, setReviewCourseFilter] = useState<'current' | string>('current')
  const [reviewExamDate, setReviewExamDate] = useState(() => localStorage.getItem('xuejing-review-exam-date-v1') ?? '')
  const [focusPhase, setFocusPhase] = useState<'focus' | 'break'>('focus')
  const [focusSeconds, setFocusSeconds] = useState(() => loadAppPreferences().focusMinutes * 60)
  const [focusRunning, setFocusRunning] = useState(false)
  const [growthRange, setGrowthRange] = useState<7 | 30>(7)
  const [growthCourseFilter, setGrowthCourseFilter] = useState('all')
  const [showAllGrowthCourses, setShowAllGrowthCourses] = useState(false)
  const [achievementCategory, setAchievementCategory] = useState<'all' | typeof ACHIEVEMENTS[number]['category']>('all')
  const [achievementView, setAchievementView] = useState<'all' | 'earned' | 'progress'>('all')
  const [showAllAchievements, setShowAllAchievements] = useState(false)
  const [achievementBackfillNotice, setAchievementBackfillNotice] = useState(0)
  const [celebrationQueue, setCelebrationQueue] = useState<Celebration[]>([])
  const [activeCelebration, setActiveCelebration] = useState<Celebration | null>(null)
  const celebrationHistoryRef = useRef<CelebrationHistoryItem[]>(loadCelebrationHistory())
  const celebratedAwardIdsRef = useRef<Set<string>>(new Set(study.achievementAwards.map((award) => award.id)))
  const [learningMonth, setLearningMonth] = useState(() => localDateKey(new Date()).slice(0, 7) + '-01')
  const [learningDay, setLearningDay] = useState(() => localDateKey(new Date()))
  const [learningCalendarKind, setLearningCalendarKind] = useState<LearningCalendarKind | 'all'>('all')
  const [learningCalendarCourse, setLearningCalendarCourse] = useState('all')
  const [calendarAnchor, setCalendarAnchor] = useState(() => calendarDateKey(new Date()))
  const [calendarSelection, setCalendarSelection] = useState<string[]>([])
  const [calendarBatchDate, setCalendarBatchDate] = useState('')
  const [expandedCalendarHistory, setExpandedCalendarHistory] = useState<string[]>([])
  const [showAiSettings, setShowAiSettings] = useState(false)
  const [showBatchRefinement, setShowBatchRefinement] = useState(false)
  const [batchRefinementSelection, setBatchRefinementSelection] = useState<string[]>([])
  const [refinementJobs, setRefinementJobs] = useState<RefinementJob[]>([])
  const [showRefinementTaskPanel, setShowRefinementTaskPanel] = useState(false)
  const [aiConfig, setAiConfig] = useState<AiConfiguration>({ configured: false, provider: 'custom', baseUrl: '', model: '' })
  const [aiProviderPresets, setAiProviderPresets] = useState<AiProviderPreset[]>([])
  const [aiModels, setAiModels] = useState<string[]>([])
  const [aiApiKey, setAiApiKey] = useState('')
  const [showEmailSettings, setShowEmailSettings] = useState(false)
  const [emailConfig, setEmailConfig] = useState<EmailSettings>({ configured: false, enabled: false, host: '', port: 465, secure: true, username: '', from: '', recipient: '', notifyCourseUpdates: true, notifyDeadlines: true, syncEmailMode: 'important', syncDigestHour: 20 })
  const [emailPassword, setEmailPassword] = useState('')
  const [emailTestState, setEmailTestState] = useState<{ kind: 'testing' | 'success' | 'error'; message: string } | null>(null)
  const [emailDigestQueue, setEmailDigestQueue] = useState<SyncInboxItem[]>(loadEmailDigestQueue)
  const [emailDigestLastSent, setEmailDigestLastSent] = useState(() => localStorage.getItem(EMAIL_DIGEST_LAST_SENT_KEY) ?? '')
  const immediateEmailQueueRef = useRef<SyncInboxItem[]>([])
  const immediateEmailTimerRef = useRef<number | null>(null)
  const emailDigestSendingRef = useRef(false)
  const [inboxFilter, setInboxFilter] = useState<'unread' | 'all' | 'archived'>('unread')
  const [inboxSourceFilter, setInboxSourceFilter] = useState<'all' | 'Blackboard' | 'Gradescope' | 'Email'>('all')

  useEffect(() => {
    studyRef.current = study
  }, [study])

  const recordLearningEvent = useCallback((learningEvent: LearningEvent) => {
    setStudy((current) => {
      const learningEvents = mergeLearningEvents(current.learningEvents, [learningEvent])
      return learningEvents.length === current.learningEvents.length && learningEvents.every((item, index) => item === current.learningEvents[index]) ? current : { ...current, learningEvents }
    })
  }, [])

  const achievementContext = useMemo(() => ({
    events: study.learningEvents,
    courses: study.courses,
    materials: study.materials,
    assignments: study.assignments,
    journal: study.journal,
    reviewSessions: study.reviewSessions,
    knowledgeRatings: study.knowledgeRatings,
  }), [study.assignments, study.courses, study.journal, study.knowledgeRatings, study.learningEvents, study.materials, study.reviewSessions])

  useEffect(() => {
    if (study.achievementBackfillVersion >= 1) return
    const historicalEvents = backfillLearningEvents({ courses: study.courses, materials: study.materials, assignments: study.assignments, journal: study.journal, reviewSessions: study.reviewSessions, knowledgeRatings: study.knowledgeRatings })
    const learningEvents = mergeLearningEvents(study.learningEvents, historicalEvents)
    const context = { ...achievementContext, events: learningEvents }
    const awards = evaluateAchievements(context, study.achievementAwards, new Date().toISOString(), true)
    setStudy((current) => ({ ...current, learningEvents: mergeLearningEvents(current.learningEvents, historicalEvents), achievementAwards: [...current.achievementAwards, ...awards], achievementBackfillVersion: 1 }))
    if (awards.length) setAchievementBackfillNotice(awards.length)
  }, [achievementContext, study.achievementAwards, study.achievementBackfillVersion, study.assignments, study.courses, study.journal, study.knowledgeRatings, study.learningEvents, study.materials, study.reviewSessions])

  useEffect(() => {
    if (study.achievementBackfillVersion < 1) return
    const awards = evaluateAchievements(achievementContext, study.achievementAwards)
    if (!awards.length) return
    setStudy((current) => ({ ...current, achievementAwards: [...current.achievementAwards, ...awards.filter((award) => !current.achievementAwards.some((item) => item.achievementId === award.achievementId))] }))
  }, [achievementContext, study.achievementAwards, study.achievementBackfillVersion])

  const anyReviewActive = Object.values(study.reviewSessions).some((session) => session.active)
  useEffect(() => {
    const unseen = study.achievementAwards.filter((award) => !celebratedAwardIdsRef.current.has(award.id))
    if (!unseen.length) return
    unseen.forEach((award) => celebratedAwardIdsRef.current.add(award.id))
    const planned = planCelebrations(unseen, celebrationHistoryRef.current, new Date().toISOString(), appPreferences.celebrationMode, anyReviewActive)
    if (planned.length) setCelebrationQueue((current) => [...current, ...planned])
  }, [anyReviewActive, appPreferences.celebrationMode, study.achievementAwards])

  useEffect(() => {
    if (anyReviewActive) return
    setCelebrationQueue((current) => current.map((item) => item.delayed ? { ...item, delayed: false } : item))
  }, [anyReviewActive])

  useEffect(() => {
    if (activeCelebration || !celebrationQueue.length) return
    const index = celebrationQueue.findIndex((item) => !item.delayed)
    if (index < 0) return
    const next = celebrationQueue[index]
    setCelebrationQueue((current) => current.filter((_, itemIndex) => itemIndex !== index))
    setActiveCelebration(next)
    const displayedAt = new Date().toISOString()
    celebrationHistoryRef.current = [...celebrationHistoryRef.current, { displayedAt, tier: next.tier }].slice(-100)
    localStorage.setItem(CELEBRATION_HISTORY_KEY, JSON.stringify(celebrationHistoryRef.current))
  }, [activeCelebration, celebrationQueue])

  useEffect(() => {
    if (!activeCelebration) return
    const timeout = window.setTimeout(() => setActiveCelebration(null), activeCelebration.tier === 'milestone' ? 6500 : 4200)
    return () => window.clearTimeout(timeout)
  }, [activeCelebration])

  useEffect(() => {
    if (showEmailSettings) return
    setEmailPassword('')
    setEmailTestState(null)
  }, [showEmailSettings])

  const [aiConnectionState, setAiConnectionState] = useState<{ kind: 'testing' | 'success' | 'error'; message: string } | null>(null)
  const [showBlackboardCredentials, setShowBlackboardCredentials] = useState(false)
  const [blackboardCredential, setBlackboardCredential] = useState({ configured: false, username: '' })
  const [blackboardPassword, setBlackboardPassword] = useState('')
  const [importCourseId, setImportCourseId] = useState('')
  const [newCourseName, setNewCourseName] = useState('')
  const [importPath, setImportPath] = useState('手动导入')
  const [importKnowledgeRole, setImportKnowledgeRole] = useState<'courseware' | 'reference'>('courseware')
  const [journalText, setJournalText] = useState('')
  const [journalMood, setJournalMood] = useState<JournalEntry['mood']>('平稳')
  const [journalDate, setJournalDate] = useState(() => localDateKey(new Date()))
  const [editingJournalId, setEditingJournalId] = useState<string | null>(null)
  const [assignmentCourseFilter, setAssignmentCourseFilter] = useState('all')
  const [showCompletedAssignments, setShowCompletedAssignments] = useState(false)
  const [showManualAssignment, setShowManualAssignment] = useState(false)
  const [manualAssignmentCourseId, setManualAssignmentCourseId] = useState('')
  const [manualAssignmentCourseName, setManualAssignmentCourseName] = useState('')
  const [manualAssignmentTitle, setManualAssignmentTitle] = useState('')
  const [manualAssignmentDueAt, setManualAssignmentDueAt] = useState('')
  const [manualAssignmentDetails, setManualAssignmentDetails] = useState('')
  const [manualAssignmentUrl, setManualAssignmentUrl] = useState('')
  const [assignmentAnalysisId, setAssignmentAnalysisId] = useState<string | null>(null)
  const [assignmentKnowledgeDraft, setAssignmentKnowledgeDraft] = useState<string[]>([])
  const [deadlineEditorId, setDeadlineEditorId] = useState<string | null>(null)
  const [deadlineDraft, setDeadlineDraft] = useState('')
  const [courseCompletionId, setCourseCompletionId] = useState<string | null>(null)
  const [removeCourseManualSchedule, setRemoveCourseManualSchedule] = useState(false)
  const [deadlineRemindersEnabled, setDeadlineRemindersEnabled] = useState(() => localStorage.getItem('xuejing-deadline-reminders-v1') === 'true')
  const [deadlineNow, setDeadlineNow] = useState(() => new Date())
  const autoSyncAfterLogin = useRef(false)
  const autoSyncGradescopeAfterLogin = useRef(false)
  const syncLockRef = useRef(false)
  const automaticSyncRunRef = useRef(false)
  const recommendedVersionsAppliedRef = useRef<Set<string>>(new Set())
  const autoSyncTimerRef = useRef<number | null>(null)
  const autoSyncLaunchHandledRef = useRef(false)
  const autoSyncFailuresRef = useRef(0)
  const autoSyncBlockedRef = useRef({ Blackboard: false, Gradescope: false })
  const syncBlackboardRunnerRef = useRef<() => Promise<boolean>>(async () => false)
  const syncGradescopeRunnerRef = useRef<() => Promise<boolean>>(async () => false)

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!media) return
    const listener = (event: MediaQueryListEvent) => setSystemDark(event.matches)
    media.addEventListener('change', listener)
    return () => media.removeEventListener('change', listener)
  }, [])

  useEffect(() => {
    localStorage.setItem(APP_PREFERENCES_KEY, JSON.stringify(appPreferences))
    document.documentElement.dataset.theme = resolveTheme(appPreferences.theme, systemDark)
    document.documentElement.dataset.motion = appPreferences.motionEnabled ? 'full' : 'reduced'
    window.xuejing?.app.setZoomFactor(appPreferences.uiScale)
  }, [appPreferences, systemDark])

  useEffect(() => {
    localStorage.setItem('xuejing-auto-sync-status-v1', JSON.stringify(autoSyncStatus))
  }, [autoSyncStatus])

  useEffect(() => {
    if (!showLaunchAnimation) return
    const timer = window.setTimeout(() => setShowLaunchAnimation(false), appPreferences.motionEnabled ? 1050 : 250)
    return () => window.clearTimeout(timer)
  }, [appPreferences.motionEnabled, showLaunchAnimation])

  useEffect(() => {
    let cancelled = false
    void window.xuejing?.app.settings().then((settings) => { if (!cancelled) setKeepRunningInTray(settings.keepRunningInTray) })
    return () => { cancelled = true }
  }, [])

  const updateAppPreference = <K extends keyof AppPreferences>(key: K, value: AppPreferences[K]) => {
    setAppPreferences((current) => ({ ...current, [key]: value }))
  }

  const updateAutoSyncPreference = <K extends keyof AutoSyncPreferences>(key: K, value: AutoSyncPreferences[K]) => {
    setAppPreferences((current) => ({ ...current, autoSync: { ...current.autoSync, [key]: value } }))
  }

  const toggleDeadlineEmailThreshold = (days: DeadlineEmailThreshold) => {
    const current = appPreferences.autoSync.deadlineEmailThresholdDays
    updateAutoSyncPreference('deadlineEmailThresholdDays', current.includes(days) ? current.filter((value) => value !== days) : [...current, days].sort((left, right) => left - right))
  }

  const updateBackgroundBehavior = async (enabled: boolean) => {
    setAppBehaviorBusy(true)
    try {
      const result = await window.xuejing?.app.saveSettings({ keepRunningInTray: enabled })
      if (!result) throw new Error('当前环境不支持后台常驻设置')
      setKeepRunningInTray(result.keepRunningInTray)
      showToast(result.keepRunningInTray ? '关闭主窗口后，学径会继续在系统托盘运行。' : '关闭主窗口后，学径将完全退出。')
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setAppBehaviorBusy(false)
    }
  }
  const knowledgeDocuments = useMemo(() => {
    return buildKnowledgeDocuments(study)
  }, [study.courses, study.materials])

  const showToast = useCallback((text: string) => {
    setToast(text)
    window.setTimeout(() => setToast((current) => current === text ? null : current), 4200)
  }, [])

  const verifyCachedFiles = useCallback(async () => {
    const paths = [...new Set(study.materials.flatMap((material) => material.localPath ? [material.localPath] : []))]
    if (!window.xuejing?.vault.verifyFiles || !paths.length) {
      setFileStates(new Map())
      return
    }
    try {
      const result = await window.xuejing.vault.verifyFiles({ paths })
      setFileStates(new Map(result.map((item) => [item.path, item.exists ? 'available' : 'missing'])))
    } catch {
      // 校验失败时不覆盖已有状态，避免误标记为缺失。
    }
  }, [study.materials])

  const reconcileBlackboardCache = useCallback(async () => {
    if (!window.xuejing?.vault.matchBlackboardFiles) return
    const candidates = study.materials.filter((material) => material.source === 'Blackboard' && material.kind === 'file' && material.url && !material.localPath)
    if (!candidates.length) return
    try {
      const matches = await window.xuejing.vault.matchBlackboardFiles({ urls: candidates.map((material) => material.url!) })
      if (!matches.length) return
      const byUrl = new Map(matches.map((item) => [item.url, item]))
      setStudy((current) => ({
        ...current,
        materials: current.materials.map((material) => {
          const item = material.url ? byUrl.get(material.url) : undefined
          return item && !material.localPath ? { ...material, title: item.title, type: item.type, localPath: item.localPath, meta: '已从资料库校验' } : material
        }),
      }))
    } catch {
      // 对账失败不影响正常同步和缓存。
    }
  }, [study.materials])

  const refreshKnowledgeStatus = useCallback(async () => {
    if (!window.xuejing?.knowledge.status) return
    try {
      const [result, versions] = await Promise.all([
        window.xuejing.knowledge.status({ documents: knowledgeDocuments }),
        window.xuejing.vault.materialVersions?.({ documents: knowledgeDocuments }).catch(() => null),
      ])
      setKnowledgeIndex(result)
      if (versions) setMaterialVersionCatalog(versions)
    } catch {
      // 知识库尚未建立或本地索引暂不可读时，保持空状态。
    }
  }, [knowledgeDocuments])

  const buildKnowledgeBase = async () => {
    if (!window.xuejing?.knowledge.build) return showToast('请在 Windows 桌面应用中构建知识库。')
    if (busyKey?.startsWith('reindex')) return showToast('页级索引正在写入，请完成后再构建知识库。')
    if (!knowledgeDocuments.length) return showToast('请先缓存或导入 PDF、PPTX 等课程资料。')
    setBusyKey('knowledge-build')
    setKnowledgeProgress({ completed: 0, total: knowledgeDocuments.length, title: '' })
    try {
      const result = await window.xuejing.knowledge.build({ documents: knowledgeDocuments })
      setKnowledgeIndex(result)
      const occurredAt = new Date().toISOString()
      recordLearningEvent({ id: `knowledge-build:${occurredAt}`, type: 'knowledge_build', occurredAt, value: 1, title: `解析 ${result.stats.parsed} 份资料` })
      showToast(`知识库已更新：解析 ${result.stats.parsed} 份资料，生成 ${result.stats.concepts} 个知识条目。`)
    } catch (error) {
      showToast(messageOf(error))
    } finally { setBusyKey(null) }
  }

  const applyMaterialVersionPaths = useCallback(async (replacements: Map<string, string>, automatic = false) => {
    const api = window.xuejing
    if (!api?.knowledge.build || !replacements.size) return false
    const snapshot = studyRef.current
    const nextStudy = {
      ...snapshot,
      materials: snapshot.materials.map((material) => replacements.has(material.id) ? { ...material, localPath: replacements.get(material.id), meta: automatic ? '已自动使用最新资料版本' : '已切换资料版本' } : material),
    }
    setBusyKey('version-switch')
    setKnowledgeProgress({ completed: 0, total: nextStudy.materials.length, title: automatic ? '正在启用最新资料版本…' : '正在切换资料版本…' })
    try {
      const documents = buildKnowledgeDocuments(nextStudy)
      const result = await api.knowledge.build({ documents })
      const versions = await api.vault.materialVersions({ documents })
      studyRef.current = nextStudy
      setStudy(nextStudy)
      setKnowledgeIndex(result)
      setMaterialVersionCatalog(versions)
      if (!automatic) showToast('资料版本已切换；知识库已使用该版本重新建立，切回旧版本时会恢复对应的 AI 结果。')
      return true
    } catch (error) {
      showToast(`资料版本切换失败：${messageOf(error)}`)
      return false
    } finally {
      setBusyKey(null)
    }
  }, [showToast])

  const switchMaterialVersion = async (group: MaterialVersionGroup, localPath: string) => {
    if (localPath === group.activePath) return
    if (group.relation === 'source-conflict' && !window.confirm('这个 Blackboard 来源曾返回内容差异很大的文件，可能不是普通新旧版本。确认切换并重新建立该资料的知识库吗？')) return
    await applyMaterialVersionPaths(new Map([[group.materialId, localPath]]))
  }

  const cleanupDuplicateFiles = async () => {
    const paths = materialVersionCatalog.duplicates.flatMap((group) => group.safeCleanupPaths)
    if (!paths.length) return showToast('没有可安全清理的完全重复孤立文件。')
    if (!window.confirm(`发现 ${paths.length} 个内容完全相同、且没有被课程资料或清单引用的孤立副本。是否从资料库中删除？`)) return
    setBusyKey('duplicate-cleanup')
    try {
      const result = await window.xuejing?.vault.cleanupDuplicates({ documents: knowledgeDocuments, paths })
      if (!result) return
      const versions = await window.xuejing?.vault.materialVersions({ documents: knowledgeDocuments })
      if (versions) setMaterialVersionCatalog(versions)
      showToast(`已清理 ${result.removed.length} 个完全重复副本${result.rejected.length ? `，${result.rejected.length} 个因仍被引用而保留` : ''}。`)
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const runKnowledgeOcr = async (materialId: string) => {
    const api = window.xuejing?.knowledge
    if (busyKey?.startsWith('reindex')) return showToast('页级索引正在写入，请完成后再运行 OCR。')
    if (!api?.ocr) return showToast('请在 Windows 桌面应用中运行本地 OCR。')
    setBusyKey('ocr:' + materialId)
    setKnowledgeProgress({ completed: 0, total: 1, title: '正在准备本地 OCR…' })
    try {
      const result = await api.ocr({ documents: knowledgeDocuments, materialId })
      setKnowledgeIndex(result)
      showToast('OCR 已完成。该扫描 PDF 的知识点现在可以展开查看。')
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const runBatchOcr = async () => {
    const api = window.xuejing?.knowledge
    if (busyKey?.startsWith('reindex')) return showToast('页级索引正在写入，请完成后再运行 OCR。')
    const materialIds = visibleKnowledgeDocuments.filter((document) => document.status === 'image').map((document) => document.materialId)
    if (!materialIds.length) return showToast('当前课程没有等待 OCR 的扫描 PDF。请先构建知识库。')
    if (!api?.ocrBatch) return showToast('请在 Windows 桌面应用中运行本地 OCR。')
    setBusyKey('ocr-batch')
    setKnowledgeProgress({ completed: 0, total: materialIds.length, title: '正在准备批量 OCR…' })
    try {
      const result = await api.ocrBatch({ documents: knowledgeDocuments, materialIds })
      setKnowledgeIndex(result)
      showToast(result.batch.failed.length ? '批量 OCR 完成：成功 ' + result.batch.completed + ' 份，失败 ' + result.batch.failed.length + ' 份。' : '批量 OCR 完成：已识别 ' + result.batch.completed + ' 份扫描 PDF。')
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const openPageLocationEditor = (document: KnowledgeDocument, concept: KnowledgeAiConcept) => {
    const editor = pageLocationEditorFor(document, concept.title)
    if (!editor) return
    setPageLocationEditor(editor)
    setPageLocationDraftStart('')
    setPageLocationDraftEnd('')
  }

  const updatePageLocation = async (action: 'add' | 'remove' | 'confirm' | 'reject', location?: KnowledgeLocation) => {
    const api = window.xuejing?.knowledge
    if (!pageLocationEditor || !api?.updatePageLocation) return
    const start = location?.start ?? Number(pageLocationDraftStart)
    const end = location?.end ?? Number(pageLocationDraftEnd || pageLocationDraftStart)
    const kind = location?.kind ?? pageLocationEditor.kind
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) return showToast('请输入有效的开始页和结束页。')
    setBusyKey('page-location')
    try {
      const result = await api.updatePageLocation({ documents: knowledgeDocuments, materialId: pageLocationEditor.materialId, conceptTitle: pageLocationEditor.conceptTitle, action, location: { kind, start, end } })
      setKnowledgeIndex(result)
      const updatedDocument = result.documents.find((document) => document.materialId === pageLocationEditor.materialId)
      setPageLocationEditor(updatedDocument ? pageLocationEditorFor(updatedDocument, pageLocationEditor.conceptTitle) : null)
      setPageLocationDraftStart('')
      setPageLocationDraftEnd('')
      showToast(action === 'confirm' ? '候选范围已确认为知识定位。' : action === 'reject' ? '候选范围已忽略。' : action === 'remove' ? '该页码范围已删除。' : '已添加人工页码范围。')
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const runCloudRefinement = async (materialId: string, force = false) => {
    const api = window.xuejing?.knowledge
    if (!aiConfig.configured) {
      setShowAiSettings(true)
      return showToast('请先保存云端 API 配置；资料只会在你点击 AI 精炼时发送。')
    }
    if (!api?.refine) return showToast('请在 Windows 桌面应用中使用 AI 精炼。')
    if (force && !window.confirm('这份资料已经按当前内容完成 AI 精炼。重新精炼会替换现有摘要和知识点，不会新增重复条目。是否继续？')) return
    setBusyKey('refine:' + materialId)
    setKnowledgeProgress({ completed: 0, total: 1, title: '正在准备 AI 精炼…' })
    try {
      const result = await api.refine({ documents: knowledgeDocuments, materialId, force })
      setKnowledgeIndex(result)
      const occurredAt = new Date().toISOString()
      recordLearningEvent({ id: `ai-refine:${materialId}:${occurredAt}`, type: 'ai_refine', occurredAt, materialId, value: 1, title: '完成 AI 精炼' })
      showToast('AI 精炼完成：课程知识点已根据该资料更新。')
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const openBatchCloudRefinement = () => {
    if (busyKey?.startsWith('reindex')) return showToast('页级索引正在写入，请完成后再启动 AI 精炼。')
    if (activeRefinementJob) {
      setShowRefinementTaskPanel(true)
      return showToast('已有 AI 精炼任务正在后台运行，可在任务面板中暂停或停止。')
    }
    if (!activeKnowledgeCourseId) return showToast('请先在知识库顶部选择一门具体课程，再批量 AI 精炼。')
    if (!aiConfig.configured) {
      setShowAiSettings(true)
      return showToast('请先保存云端 API 配置。')
    }
    if (!batchRefinementCandidates.length) return showToast('当前课程没有可进行 AI 精炼的已解析课件。')
    setBatchRefinementSelection(defaultRefinementSelection(batchRefinementCandidates))
    setShowBatchRefinement(true)
  }

  const openDocumentCloudRefinement = (materialId: string) => {
    if (busyKey?.startsWith('reindex')) return showToast('页级索引正在写入，请完成后再启动 AI 精炼。')
    const document = knowledgeIndex?.documents.find((item) => item.materialId === materialId)
    if (document?.knowledgeRole === 'reference') return showToast('教材和参考资料只进行本地解析、搜索和阅读，不参与 AI 知识点精炼。')
    if (activeRefinementJob) {
      setShowRefinementTaskPanel(true)
      return showToast('已有 AI 精炼任务正在运行，请先等待、暂停或停止。')
    }
    if (!aiConfig.configured) {
      setShowAiSettings(true)
      return showToast('请先保存云端 API 配置。')
    }
    setBatchRefinementSelection([materialId])
    setShowBatchRefinement(true)
  }

  const runBatchCloudRefinement = async () => {
    const api = window.xuejing?.knowledge
    const selected = new Set(batchRefinementSelection)
    const materialIds = batchRefinementCandidates.filter((document) => selected.has(document.materialId)).map((document) => document.materialId)
    const jobCourseId = activeKnowledgeCourseId ?? batchRefinementCandidates.find((document) => selected.has(document.materialId))?.courseId
    if (!materialIds.length) return showToast('请至少选择一份需要精炼的资料。')
    if (!api?.startRefinementJob || !jobCourseId) return showToast('请在 Windows 桌面应用中使用后台 AI 精炼。')
    setBusyKey('refine-job-start')
    try {
      const job = await api.startRefinementJob({ documents: knowledgeDocuments, materialIds, courseId: jobCourseId, mode: 'original', force: true })
      setRefinementJobs((current) => [job, ...current.filter((item) => item.id !== job.id)])
      setShowBatchRefinement(false)
      setBatchRefinementSelection([])
      showToast(`AI 精炼已转入后台：${materialIds.length} 份资料。你可以继续使用其他页面。`)
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const controlRefinementJob = async (action: 'pause' | 'cancel' | 'resume' | 'restart' | 'dismiss', jobId: string) => {
    const api = window.xuejing?.knowledge
    if (!api) return
    setBusyKey('refinement-control')
    try {
      const result = action === 'pause' ? await api.pauseRefinementJob(jobId)
        : action === 'cancel' ? await api.cancelRefinementJob(jobId)
          : action === 'resume' ? await api.resumeRefinementJob({ jobId })
            : action === 'restart' ? await api.resumeRefinementJob({ jobId, restart: true })
              : await api.dismissRefinementJob(jobId)
      if ('id' in result) setRefinementJobs((current) => [result, ...current.filter((item) => item.id !== result.id)])
      else {
        setRefinementJobs((current) => current.filter((item) => item.id !== jobId))
        setShowRefinementTaskPanel(false)
      }
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const saveAiConfiguration = async () => {
    const api = window.xuejing?.ai
    if (!api?.saveSettings) return showToast('请在 Windows 桌面应用中保存 AI 配置。')
    setBusyKey('ai-settings')
    try {
      const result = await api.saveSettings({ provider: aiConfig.provider, baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiApiKey || undefined, capabilities: aiConfig.capabilities })
      setAiConfig(result)
      setAiApiKey('')
      setShowAiSettings(false)
      showToast('云端 API 配置已加密保存。资料仍只会在你点击 AI 精炼时发送。')
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const testAiConnection = async () => {
    const api = window.xuejing?.ai
    if (!api?.testConnection) return showToast('请在 Windows 桌面应用中测试 AI 配置。')
    setBusyKey('ai-test')
    setAiConnectionState({ kind: 'testing', message: '正在发送最小测试请求…' })
    try {
      const result = await api.testConnection({ provider: aiConfig.provider, baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiApiKey || undefined })
      setAiConfig((current) => ({ ...current, provider: result.capabilities.provider, capabilities: result.capabilities }))
      setAiConnectionState({ kind: 'success', message: `连接正常：${result.model}，${result.latencyMs} ms；精炼方式：${result.capabilities.refinementMode === 'original-file' ? '原件直传' : '本地分页兼容'}` })
    } catch (error) {
      setAiConnectionState({ kind: 'error', message: messageOf(error) })
    } finally {
      setBusyKey(null)
    }
  }

  const loadAiModels = async () => {
    const api = window.xuejing?.ai
    if (!api?.listModels) return showToast('当前环境不支持读取模型列表。')
    setBusyKey('ai-models')
    setAiConnectionState({ kind: 'testing', message: '正在从官方或兼容接口读取模型列表…' })
    try {
      const result = await api.listModels({ provider: aiConfig.provider, baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiApiKey || undefined })
      setAiModels(result.models)
      setAiConnectionState({ kind: 'success', message: `已读取 ${result.models.length} 个可用模型；请选择后再进行能力检测。` })
    } catch (error) {
      setAiConnectionState({ kind: 'error', message: messageOf(error) })
    } finally {
      setBusyKey(null)
    }
  }

  const saveEmailConfiguration = async () => {
    const api = window.xuejing?.email
    if (!api?.saveSettings) return showToast('请在 Windows 桌面应用中保存邮箱配置。')
    setBusyKey('email-settings')
    try {
      const result = await api.saveSettings({ ...emailConfig, password: emailPassword || undefined })
      setEmailConfig(result)
      setEmailPassword('')
      setShowEmailSettings(false)
      showToast(result.enabled ? '邮箱通知配置已加密保存并启用。' : '邮箱配置已保存，邮件通知当前关闭。')
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const testEmailConfiguration = async () => {
    const api = window.xuejing?.email
    if (!api?.test) return showToast('请在 Windows 桌面应用中测试邮箱配置。')
    setBusyKey('email-test')
    setEmailTestState({ kind: 'testing', message: '正在连接 SMTP 并发送测试邮件…' })
    try {
      const result = await api.test({ ...emailConfig, password: emailPassword || undefined })
      setEmailTestState({ kind: 'success', message: `测试邮件已发送，耗时 ${result.latencyMs} ms。请检查收件箱或垃圾邮件。` })
    } catch (error) {
      setEmailTestState({ kind: 'error', message: messageOf(error) })
    } finally {
      setBusyKey(null)
    }
  }

  const openBlackboardCredentials = async () => {
    const api = window.xuejing?.credentials
    if (!api?.blackboard) return showToast('请在 Windows 桌面应用中管理 Blackboard 登录信息。')
    try {
      const result = await api.blackboard()
      setBlackboardCredential(result)
      setBlackboardPassword('')
      setShowBlackboardCredentials(true)
    } catch (error) {
      showToast(messageOf(error))
    }
  }

  const saveBlackboardCredentials = async () => {
    const api = window.xuejing?.credentials
    if (!api?.saveBlackboard) return showToast('请在 Windows 桌面应用中保存 Blackboard 登录信息。')
    setBusyKey('blackboard-credentials')
    try {
      const result = await api.saveBlackboard({ username: blackboardCredential.username, password: blackboardPassword || undefined })
      setBlackboardCredential(result)
      setBlackboardPassword('')
      setShowBlackboardCredentials(false)
      showToast('Blackboard 账号和密码已使用 Windows 系统安全存储保存；下次登录页会自动填入，仍由你完成学校认证。')
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const clearBlackboardCredentials = async () => {
    const api = window.xuejing?.credentials
    if (!api?.clearBlackboard) return
    if (!window.confirm('将删除本机加密保存的 Blackboard 账号和密码；不会退出当前 Blackboard 会话。是否继续？')) return
    setBusyKey('blackboard-credentials')
    try {
      const result = await api.clearBlackboard()
      setBlackboardCredential(result)
      setBlackboardPassword('')
      showToast('已删除本机保存的 Blackboard 登录信息。')
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const toggleKnowledgeDocument = (materialId: string) => {
    setExpandedKnowledgeDocuments((current) => {
      const next = new Set(current)
      if (next.has(materialId)) next.delete(materialId)
      else next.add(materialId)
      return next
    })
  }

  const changeKnowledgeRole = (materialId: string, knowledgeRole: 'courseware' | 'reference') => {
    setStudy((current) => ({
      ...current,
      materials: current.materials.map((material) => material.id === materialId ? { ...material, knowledgeRole } : material),
    }))
    showToast(knowledgeRole === 'reference' ? '该资料已设为教材/参考资料，不会再扩充课程知识点。' : '该资料已设为课件，会参与课程知识点汇总。')
  }

  const setConceptRating = (conceptId: string, rating: ConceptRating) => {
    setStudy((current) => ({
      ...current,
      knowledgeRatings: { ...current.knowledgeRatings, [conceptId]: rating },
    }))
  }

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(study))
  }, [study])

  useEffect(() => {
    localStorage.setItem('xuejing-auto-cache-v1', String(autoCacheEnabled))
  }, [autoCacheEnabled])

  useEffect(() => {
    localStorage.setItem('xuejing-review-exam-date-v1', reviewExamDate)
  }, [reviewExamDate])

  useEffect(() => {
    if (!focusRunning) setFocusSeconds((focusPhase === 'focus' ? appPreferences.focusMinutes : appPreferences.breakMinutes) * 60)
  }, [appPreferences.breakMinutes, appPreferences.focusMinutes, focusPhase, focusRunning])

  useEffect(() => {
    if (!focusRunning) return
    const timer = window.setInterval(() => setFocusSeconds((current) => {
      if (current <= 1) {
        const nextPhase = focusPhase === 'focus' ? 'break' : 'focus'
        setFocusRunning(false)
        setFocusPhase(nextPhase)
        if (focusPhase === 'focus') {
          const occurredAt = new Date().toISOString()
          recordLearningEvent({ id: `focus:${occurredAt}`, type: 'focus_completed', occurredAt, value: appPreferences.focusMinutes, title: `${appPreferences.focusMinutes} 分钟专注` })
        }
        void window.xuejing?.deadlines.notify({ title: focusPhase === 'focus' ? '专注完成' : '休息完成', body: focusPhase === 'focus' ? `休息 ${appPreferences.breakMinutes} 分钟，再开始下一轮专注。` : `开始下一轮 ${appPreferences.focusMinutes} 分钟专注。` })
        return (nextPhase === 'focus' ? appPreferences.focusMinutes : appPreferences.breakMinutes) * 60
      }
      return current - 1
    }), 1000)
    return () => window.clearInterval(timer)
  }, [appPreferences.breakMinutes, appPreferences.focusMinutes, focusPhase, focusRunning, recordLearningEvent])

  useEffect(() => { void verifyCachedFiles() }, [verifyCachedFiles])
  useEffect(() => { void reconcileBlackboardCache() }, [reconcileBlackboardCache])
  useEffect(() => { void refreshKnowledgeStatus() }, [refreshKnowledgeStatus])
  useEffect(() => {
    let cancelled = false
    void window.xuejing?.ai?.settings().then((settings) => { if (!cancelled) setAiConfig(settings) })
    void window.xuejing?.ai?.presets().then((presets) => { if (!cancelled) setAiProviderPresets(presets) })
    void window.xuejing?.email?.settings().then((settings) => { if (!cancelled) setEmailConfig(settings) })
    void window.xuejing?.credentials?.blackboard().then((settings) => { if (!cancelled) setBlackboardCredential(settings) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (selectedCourseId && study.courses.some((course) => course.id === selectedCourseId)) return
    setSelectedCourseId(study.courses[0]?.id ?? null)
  }, [selectedCourseId, study.courses])

  useEffect(() => {
    const courseIds = study.courses.map((course) => course.id)
    setAssignmentCourseFilter((value) => normalizeCourseFilter(value, courseIds, 'all'))
    setGrowthCourseFilter((value) => normalizeCourseFilter(value, courseIds, 'all'))
    setMapCourseFilter((value) => normalizeCourseFilter(value, courseIds, 'all'))
    setKnowledgeCourseFilter((value) => normalizeCourseFilter(value, courseIds, 'current'))
    setReviewCourseFilter((value) => normalizeCourseFilter(value, courseIds, 'current'))
  }, [study.courses])

  const sendSyncDigest = useCallback(async (events: SyncInboxItem[]) => {
    if (!events.length || !window.xuejing?.email) return false
    try {
      await window.xuejing.email.sendSyncUpdate({ events: events.map(({ title, detail, source, kind, courseId }) => ({ title, detail, source, kind, courseId })) })
      return true
    } catch (error) {
      showToast(`同步已完成，但邮件通知发送失败：${messageOf(error)}`)
      return false
    }
  }, [showToast])

  const notifySyncChangesByEmail = useCallback((events: SyncInboxItem[]) => {
    if (!events.length || !emailConfig.enabled || !emailConfig.configured || emailConfig.syncEmailMode === 'off' || !window.xuejing?.email) return
    const selected = syncEmailEventsForMode(events, emailConfig.syncEmailMode)
    if (!selected.length) return
    if (emailConfig.syncEmailMode === 'daily') {
      setEmailDigestQueue((current) => mergeEmailDigestQueue(current, selected))
      return
    }
    immediateEmailQueueRef.current = mergeEmailDigestQueue(immediateEmailQueueRef.current, selected)
    if (immediateEmailTimerRef.current !== null) window.clearTimeout(immediateEmailTimerRef.current)
    immediateEmailTimerRef.current = window.setTimeout(() => {
      const pending = immediateEmailQueueRef.current
      immediateEmailQueueRef.current = []
      immediateEmailTimerRef.current = null
      void sendSyncDigest(pending)
    }, 15_000)
  }, [emailConfig.configured, emailConfig.enabled, emailConfig.syncEmailMode, sendSyncDigest])

  useEffect(() => {
    localStorage.setItem(EMAIL_DIGEST_QUEUE_KEY, JSON.stringify(emailDigestQueue))
  }, [emailDigestQueue])

  useEffect(() => {
    if (emailDigestLastSent) localStorage.setItem(EMAIL_DIGEST_LAST_SENT_KEY, emailDigestLastSent)
  }, [emailDigestLastSent])

  useEffect(() => {
    if (!emailConfig.enabled || !emailConfig.configured || emailConfig.syncEmailMode !== 'daily' || !emailDigestQueue.length) return
    const flush = async () => {
      if (emailDigestSendingRef.current || !shouldFlushDailyDigest(emailDigestLastSent, emailConfig.syncDigestHour)) return
      emailDigestSendingRef.current = true
      try {
        if (await sendSyncDigest(emailDigestQueue)) {
          setEmailDigestQueue([])
          setEmailDigestLastSent(new Date().toISOString())
        }
      } finally {
        emailDigestSendingRef.current = false
      }
    }
    void flush()
    const timer = window.setInterval(() => { void flush() }, 60_000)
    return () => window.clearInterval(timer)
  }, [emailConfig.configured, emailConfig.enabled, emailConfig.syncDigestHour, emailConfig.syncEmailMode, emailDigestLastSent, emailDigestQueue, sendSyncDigest])

  useEffect(() => () => {
    if (immediateEmailTimerRef.current !== null) window.clearTimeout(immediateEmailTimerRef.current)
  }, [])

  const resolveConnectionWarning = useCallback((source: 'Blackboard' | 'Gradescope') => {
    setStudy((current) => {
      const syncInbox = resolveSyncConnectionItems(current.syncInbox, source)
      if (syncInbox.every((item, index) => item === current.syncInbox[index])) return current
      const next = { ...current, syncInbox }
      studyRef.current = next
      return next
    })
  }, [])

  const syncBlackboard = useCallback(async () => {
    const silent = automaticSyncRunRef.current
    const api = window.xuejing?.blackboard
    if (!api) { if (!silent) showToast('请在 Windows 桌面应用中使用 Blackboard 同步。'); return false }
    if (syncLockRef.current) { if (!silent) showToast('另一项平台同步正在进行，请稍后再试。'); return false }
    syncLockRef.current = true
    setBusyKey('sync')
    try {
      const courseResult = await api.sync()
      setConnected(courseResult.connected)
      if (!courseResult.connected) {
        autoSyncBlockedRef.current.Blackboard = true
        setStudy((current) => {
          const next = { ...current, syncInbox: mergeSyncInbox(current.syncInbox, [syncConnectionRequiredItem('Blackboard', courseResult.message)]) }
          studyRef.current = next
          return next
        })
        if (!silent) showToast(courseResult.message)
        return false
      }
      autoSyncBlockedRef.current.Blackboard = false
      resolveConnectionWarning('Blackboard')
      if (!courseResult.courses.length) { if (!silent) showToast(courseResult.message); return true }
      setBusyKey('scan')
      const materialResult = await api.syncMaterials(courseResult.courses)
      const snapshot = studyRef.current
      const courseMerge = mergeBlackboardCourses(snapshot.courses, courseResult.courses)
      const materialMerge = mergeBlackboardMaterials(snapshot.materials, courseMerge.courses, materialResult.materials.filter((material) => material.kind !== 'assignment'))
      const assignmentMerge = mergeBlackboardAssignments(snapshot.assignments, courseMerge.courses, materialResult.materials
        .filter((material): material is typeof material & { url: string } => material.kind === 'assignment' && Boolean(material.url))
        .map((material) => ({ courseName: material.courseName, title: material.title, url: material.url, meta: material.meta, dueAt: material.dueAt, status: material.status, score: material.score, maxScore: material.maxScore })))
      const changes = detectSyncChanges(snapshot, { courses: courseMerge.courses, materials: materialMerge.materials, assignments: assignmentMerge.assignments }, 'Blackboard')
      const syncedAt = new Date().toISOString()
      const nextStudy: StudyState = { ...snapshot, courses: courseMerge.courses, materials: materialMerge.materials, assignments: assignmentMerge.assignments, syncInbox: mergeSyncInbox(snapshot.syncInbox, changes), learningEvents: mergeLearningEvents(snapshot.learningEvents, [{ id: `sync:Blackboard:${syncedAt}`, type: 'platform_sync', occurredAt: syncedAt, title: '同步 Blackboard' }]) }
      studyRef.current = nextStudy
      setStudy(nextStudy)
      notifySyncChangesByEmail(changes)
      const cachedUrls = new Set(snapshot.materials.filter((material) => material.localPath && material.url).map((material) => material.url))
      const courseByName = new Map(courseMerge.courses.map((course) => [course.name.replace(/\s+/g, ' ').trim().toLowerCase(), course]))
      const automaticFiles = materialResult.materials
        .filter((material) => material.kind === 'file' && Boolean(material.url) && !cachedUrls.has(material.url))
        .map((material) => ({
          material,
          course: courseByName.get(material.courseName.replace(/\s+/g, ' ').trim().toLowerCase()),
          clientId: materialMerge.materials.find((entry) => entry.url === material.url)?.id,
        }))
        .filter((item): item is { material: typeof materialResult.materials[number]; course: Course; clientId: string } => Boolean(item.course && item.clientId))
      if (autoCacheEnabled && automaticFiles.length) {
        setBusyKey('auto-cache')
        const cacheResult = await api.cacheFiles({ files: automaticFiles.map(({ material, course, clientId }) => ({ clientId, url: material.url!, title: material.title, courseName: course.name, folderPath: material.path ?? [] })) })
        setStudy((current) => {
          const next = { ...current, materials: applyCachedItems(current.materials, cacheResult.completed) }
          studyRef.current = next
          return next
        })
        if (cacheResult.completed[0]) setVaultRoot(cacheResult.completed[0].vaultRoot)
        if (!silent) showToast(`${materialResult.message}；自动缓存 ${cacheResult.completed.length} 份${cacheResult.failed.length ? `，${cacheResult.failed.length} 份失败` : ''}。`)
      } else {
        if (!silent) showToast(`${courseResult.message}；${materialResult.message}`)
      }
      return true
    } catch (error) {
      if (!silent) showToast(messageOf(error))
      return false
    } finally {
      setBusyKey(null)
      syncLockRef.current = false
    }
  }, [autoCacheEnabled, notifySyncChangesByEmail, resolveConnectionWarning, showToast])

  const syncGradescope = useCallback(async () => {
    const silent = automaticSyncRunRef.current
    const api = window.xuejing?.gradescope
    if (!api) { if (!silent) showToast('请在 Windows 桌面应用中使用 Gradescope 同步。'); return false }
    if (syncLockRef.current) { if (!silent) showToast('另一项平台同步正在进行，请稍后再试。'); return false }
    syncLockRef.current = true
    setBusyKey('gradescope-sync')
    try {
      const result = await api.sync()
      setGradescopeConnected(result.connected)
      if (!result.connected) {
        autoSyncBlockedRef.current.Gradescope = true
        setStudy((current) => {
          const next = { ...current, syncInbox: mergeSyncInbox(current.syncInbox, [syncConnectionRequiredItem('Gradescope', result.message)]) }
          studyRef.current = next
          return next
        })
        if (!silent) showToast(result.message)
        return false
      }
      autoSyncBlockedRef.current.Gradescope = false
      resolveConnectionWarning('Gradescope')
      const snapshot = studyRef.current
      const courseMerge = mergeGradescopeCourses(snapshot.courses, result.courses)
      const assignmentMerge = mergeGradescopeAssignments(snapshot.assignments, courseMerge.courses, result.assignments)
      const changes = detectSyncChanges(snapshot, { courses: courseMerge.courses, materials: snapshot.materials, assignments: assignmentMerge.assignments }, 'Gradescope')
      const syncedAt = new Date().toISOString()
      const nextStudy: StudyState = { ...snapshot, courses: courseMerge.courses, assignments: assignmentMerge.assignments, syncInbox: mergeSyncInbox(snapshot.syncInbox, changes), learningEvents: mergeLearningEvents(snapshot.learningEvents, [{ id: `sync:Gradescope:${syncedAt}`, type: 'platform_sync', occurredAt: syncedAt, title: '同步 Gradescope' }]) }
      studyRef.current = nextStudy
      setStudy(nextStudy)
      notifySyncChangesByEmail(changes)
      if (!silent) showToast(result.message)
      return true
    } catch (error) {
      if (!silent) showToast(messageOf(error))
      return false
    } finally {
      setBusyKey(null)
      syncLockRef.current = false
    }
  }, [notifySyncChangesByEmail, resolveConnectionWarning, showToast])

  useEffect(() => {
    syncBlackboardRunnerRef.current = syncBlackboard
    syncGradescopeRunnerRef.current = syncGradescope
  }, [syncBlackboard, syncGradescope])

  useEffect(() => {
    if (autoSyncTimerRef.current !== null) window.clearTimeout(autoSyncTimerRef.current)
    if (!platformStatusReady) {
      setAutoSyncStatus((current) => ({ ...current, state: 'paused', nextAt: undefined, message: '正在恢复平台登录状态' }))
      return
    }
    if (!appPreferences.autoSync.enabled || (!appPreferences.autoSync.blackboard && !appPreferences.autoSync.gradescope)) {
      setAutoSyncStatus((current) => ({ ...current, state: 'idle', nextAt: undefined, message: '自动同步已关闭' }))
      return
    }
    let cancelled = false
    const schedule = (delayMs: number, status: AutoSyncStatus['state'] = 'scheduled', message = '等待下一次自动同步') => {
      if (cancelled) return
      const nextAt = new Date(Date.now() + delayMs).toISOString()
      setAutoSyncStatus((current) => ({ ...current, state: status, nextAt, message }))
      autoSyncTimerRef.current = window.setTimeout(run, delayMs)
    }
    const run = async () => {
      if (cancelled) return
      if (isQuietHour(appPreferences.autoSync)) {
        schedule(30 * 60_000, 'paused', '免打扰时段内暂停自动同步')
        return
      }
      if (syncLockRef.current) {
        schedule(5 * 60_000, 'paused', '其他同步正在进行，稍后重试')
        return
      }
      const runBlackboard = appPreferences.autoSync.blackboard && !autoSyncBlockedRef.current.Blackboard
      const runGradescope = appPreferences.autoSync.gradescope && !autoSyncBlockedRef.current.Gradescope
      if (!runBlackboard && !runGradescope) {
        schedule(automaticSyncDelayMs(appPreferences.autoSync.intervalMinutes, 0), 'paused', '平台登录已过期，重新登录后恢复自动同步')
        return
      }
      const attemptedAt = new Date().toISOString()
      setAutoSyncStatus((current) => ({ ...current, state: 'syncing', lastAttempt: attemptedAt, nextAt: undefined, message: '正在后台同步课程与作业' }))
      automaticSyncRunRef.current = true
      const results: boolean[] = []
      try {
        if (runBlackboard) results.push(await syncBlackboardRunnerRef.current())
        if (runGradescope) results.push(await syncGradescopeRunnerRef.current())
      } finally {
        automaticSyncRunRef.current = false
      }
      const allSucceeded = results.length > 0 && results.every(Boolean)
      const anySucceeded = results.some(Boolean)
      const failures = allSucceeded ? 0 : autoSyncFailuresRef.current + 1
      autoSyncFailuresRef.current = failures
      const delay = automaticSyncDelayMs(appPreferences.autoSync.intervalMinutes, failures)
      setAutoSyncStatus((current) => ({ ...current, state: allSucceeded ? 'scheduled' : 'error', lastAttempt: attemptedAt, lastSuccess: anySucceeded ? new Date().toISOString() : current.lastSuccess, consecutiveFailures: failures, message: allSucceeded ? '自动同步完成' : '部分或全部平台同步失败，已延迟下次尝试' }))
      schedule(delay, allSucceeded ? 'scheduled' : 'error', allSucceeded ? '自动同步完成，等待下一次同步' : '同步失败，已启用退避重试')
    }
    const initialDelay = appPreferences.autoSync.syncOnLaunch && !autoSyncLaunchHandledRef.current ? 8_000 : automaticSyncDelayMs(appPreferences.autoSync.intervalMinutes, 0)
    autoSyncLaunchHandledRef.current = true
    schedule(initialDelay)
    return () => {
      cancelled = true
      if (autoSyncTimerRef.current !== null) window.clearTimeout(autoSyncTimerRef.current)
      autoSyncTimerRef.current = null
    }
  }, [appPreferences.autoSync, platformStatusReady])

  useEffect(() => {
    const bridge = window.xuejing
    if (!bridge) {
      setVaultRoot('网页预览模式：资料库仅可在桌面应用中设置')
      setPlatformStatusReady(true)
      return
    }
    let cancelled = false
    void bridge.vault.settings().then((result) => { if (!cancelled) setVaultRoot(result.vaultRoot) })
    void bridge.vault.repairExtensions().then((result) => {
      if (cancelled) return
      setVaultRoot(result.vaultRoot)
      const repaired = new Map(result.repairedFiles.map((file) => [file.from, file.to]))
      if (repaired.size) setStudy((current) => ({ ...current, materials: current.materials.map((material) => material.localPath && repaired.has(material.localPath) ? { ...material, localPath: repaired.get(material.localPath) } : material) }))
    })
    void Promise.allSettled([bridge.blackboard.status(), bridge.gradescope.status()]).then(([blackboard, gradescope]) => {
      if (cancelled) return
      if (blackboard.status === 'fulfilled') {
        setConnected(blackboard.value.connected)
        if (blackboard.value.connected) resolveConnectionWarning('Blackboard')
      }
      if (gradescope.status === 'fulfilled') {
        setGradescopeConnected(gradescope.value.connected)
        if (gradescope.value.connected) resolveConnectionWarning('Gradescope')
      }
      setPlatformStatusReady(true)
    })
    void bridge.knowledge.refinementJobs().then((jobs) => { if (!cancelled) setRefinementJobs(jobs) })
    const dispose = bridge.blackboard.onConnectionChanged((status) => {
      if (cancelled) return
      setConnected(status.connected)
      if (status.connected) { autoSyncBlockedRef.current.Blackboard = false; resolveConnectionWarning('Blackboard') }
      if (status.connected && autoSyncAfterLogin.current) {
        autoSyncAfterLogin.current = false
        void syncBlackboard()
      }
    })
    const disposeGradescope = bridge.gradescope.onConnectionChanged((status) => {
      if (cancelled) return
      setGradescopeConnected(status.connected)
      if (status.connected) { autoSyncBlockedRef.current.Gradescope = false; resolveConnectionWarning('Gradescope') }
      if (status.connected && autoSyncGradescopeAfterLogin.current) {
        autoSyncGradescopeAfterLogin.current = false
        void syncGradescope()
      }
    })
    const disposeMigration = bridge.vault.onMigrationProgress((progress) => { if (!cancelled) setMigrationProgress(progress) })
    const disposeKnowledge = bridge.knowledge.onProgress((progress) => { if (!cancelled) setKnowledgeProgress(progress) })
    const disposeRefinement = bridge.knowledge.onRefinementJobChange((job) => {
      if (!cancelled) setRefinementJobs((current) => [job, ...current.filter((item) => item.id !== job.id)])
    })
    return () => { cancelled = true; dispose(); disposeGradescope(); disposeMigration(); disposeKnowledge(); disposeRefinement() }
  }, [resolveConnectionWarning, syncBlackboard, syncGradescope])

  useEffect(() => {
    if (!refinementJobs[0]) return
    void refreshKnowledgeStatus()
  }, [refinementJobs[0]?.completedIds.length, refinementJobs[0]?.status, refreshKnowledgeStatus])

  useEffect(() => {
    const completed = refinementJobs.flatMap((job) => job.completedIds.map((materialId) => ({ id: `ai-refine-job:${job.id}:${materialId}`, type: 'ai_refine' as const, occurredAt: job.updatedAt || new Date().toISOString(), courseId: job.courseId, materialId, value: 1, title: '后台 AI 精炼完成' })))
    if (!completed.length) return
    setStudy((current) => ({ ...current, learningEvents: mergeLearningEvents(current.learningEvents, completed) }))
  }, [refinementJobs])

  const connectBlackboard = async () => {
    const api = window.xuejing?.blackboard
    if (!api) return showToast('请在 Windows 桌面应用中连接 Blackboard。')
    try {
      autoSyncAfterLogin.current = true
      await api.connect()
      showToast('已打开学校统一认证窗口；登录成功后会自动同步。')
    } catch (error) {
      autoSyncAfterLogin.current = false
      showToast(messageOf(error))
    }
  }

  const connectGradescope = async () => {
    const api = window.xuejing?.gradescope
    if (!api) return showToast('请在 Windows 桌面应用中连接 Gradescope。')
    try {
      autoSyncGradescopeAfterLogin.current = true
      await api.connect()
      showToast('已打开 Gradescope 登录窗口；登录成功后会自动同步课程和作业提交入口。')
    } catch (error) {
      autoSyncGradescopeAfterLogin.current = false
      showToast(messageOf(error))
    }
  }

  const disconnectBlackboard = async () => {
    const api = window.xuejing?.blackboard
    if (!api?.disconnect) return showToast('请在 Windows 桌面应用中退出 Blackboard。')
    if (!window.confirm('将清除本机保存的 Blackboard 登录会话。下次连接需要重新登录，是否继续？')) return
    try {
      await api.disconnect()
      setConnected(false)
      showToast('已退出 Blackboard，并清除了此电脑上的登录会话。')
    } catch (error) { showToast(messageOf(error)) }
  }

  const disconnectGradescope = async () => {
    const api = window.xuejing?.gradescope
    if (!api?.disconnect) return showToast('请在 Windows 桌面应用中退出 Gradescope。')
    if (!window.confirm('将清除本机保存的 Gradescope 登录会话。下次连接需要重新登录，是否继续？')) return
    try {
      await api.disconnect()
      setGradescopeConnected(false)
      showToast('已退出 Gradescope，并清除了此电脑上的登录会话。')
    } catch (error) { showToast(messageOf(error)) }
  }

  const chooseVault = async () => {
    if (!window.xuejing) return showToast('请在 Windows 桌面应用中设置资料库位置。')
    try {
      const result = await window.xuejing.vault.chooseRoot()
      if (result.cancelled || !result.vaultRoot) return
      setMigrationTarget(result.vaultRoot)
      setMigrationProgress(null)
      setShowMigration(true)
    } catch (error) { showToast(messageOf(error)) }
  }

  const migrateVault = async (mode: 'copy' | 'move' | 'switch') => {
    if (!window.xuejing?.vault.migrate || !migrationTarget) return
    setBusyKey('migrate')
    try {
      const result = await window.xuejing.vault.migrate({ targetRoot: migrationTarget, mode })
      setVaultRoot(result.vaultRoot)
      const relocated = new Map(result.relocated.map((item) => [item.from, item.to]))
      if (relocated.size) setStudy((current) => ({ ...current, materials: current.materials.map((material) => material.localPath && relocated.has(material.localPath) ? { ...material, localPath: relocated.get(material.localPath) } : material) }))
      setShowMigration(false)
      setMigrationProgress(null)
      showToast(mode === 'switch' ? '已切换资料库位置；旧资料仍保留在原位置。' : `资料库迁移完成：复制 ${result.copied} 份，复用 ${result.deduplicated} 份${result.missing ? `，${result.missing} 份缺失` : ''}。`)
      void verifyCachedFiles()
    } catch (error) {
      showToast(messageOf(error))
    } finally { setBusyKey(null) }
  }

  const cacheMaterial = async (material: Material) => {
    if (!window.xuejing?.blackboard.cacheFile || !material.url) return showToast('此资料没有可缓存的 Blackboard 文件链接。')
    const course = study.courses.find((item) => item.id === material.courseId)
    if (!course) return showToast('找不到这份资料所属的课程。')
    setBusyKey(`cache:${material.id}`)
    try {
      const result = await window.xuejing.blackboard.cacheFile({ url: material.url, title: material.title, courseName: course.name, folderPath: material.path ?? [] })
      setVaultRoot(result.vaultRoot)
      setStudy((current) => ({
        ...current,
        materials: current.materials.map((item) => item.id === material.id ? { ...item, title: result.item.title, type: result.item.type, localPath: result.item.localPath, meta: result.item.meta } : item),
      }))
      showToast(result.item.deduplicated ? '资料库已有相同文件，已复用本地副本。' : '已缓存到本地资料库，后续可进行解析。')
    } catch (error) {
      showToast(messageOf(error))
    } finally { setBusyKey(null) }
  }

  const cacheCurrentCourse = async () => {
    if (!selectedCourse || !window.xuejing?.blackboard.cacheFiles) return showToast('请先选择一门课程。')
    const files = selectedMaterials.filter((material) => material.source === 'Blackboard' && material.kind === 'file' && material.url && (!material.localPath || fileStates.get(material.localPath) === 'missing'))
    if (!files.length) return showToast('这门课没有需要缓存的 Blackboard 文件。')
    setBusyKey('cache-course')
    try {
      const result = await window.xuejing.blackboard.cacheFiles({ files: files.map((file) => ({ clientId: file.id, url: file.url!, title: file.title, courseName: selectedCourse.name, folderPath: file.path ?? [] })) })
      setStudy((current) => ({
        ...current,
        materials: applyCachedItems(current.materials, result.completed),
      }))
      if (result.completed[0]) setVaultRoot(result.completed[0].vaultRoot)
      showToast(result.failed.length ? `已缓存 ${result.completed.length} 份，${result.failed.length} 份失败；可稍后重试。` : `已缓存本课程全部 ${result.completed.length} 份文件。`)
    } catch (error) {
      showToast(messageOf(error))
    } finally { setBusyKey(null) }
  }

  const repairCachedExtensions = async (quiet = false) => {
    if (!window.xuejing?.vault.repairExtensions) return
    try {
      const result = await window.xuejing.vault.repairExtensions()
      setVaultRoot(result.vaultRoot)
      const repaired = new Map(result.repairedFiles.map((file) => [file.from, file.to]))
      if (repaired.size) setStudy((current) => ({ ...current, materials: current.materials.map((material) => material.localPath && repaired.has(material.localPath) ? { ...material, localPath: repaired.get(material.localPath) } : material) }))
      if (!quiet) showToast(result.repaired ? `已修复 ${result.repaired} 个缺少扩展名的缓存文件。` : '没有需要修复的缓存文件。')
    } catch (error) {
      if (!quiet) showToast(messageOf(error))
    }
  }

  const importLocalFiles = async () => {
    if (!window.xuejing) return showToast('请在 Windows 桌面应用中导入文件。')
    const existing = study.courses.find((course) => course.id === importCourseId)
    const courseName = existing?.name ?? newCourseName.trim()
    if (!courseName) return showToast('请先选择课程，或输入一个新课程名称。')
    const folderPath = importPath.split(/[\\/]+/).map((part) => part.trim()).filter(Boolean)
    setBusyKey('import')
    try {
      const result = await window.xuejing.vault.importFiles({ courseName, folderPath: folderPath.length ? folderPath : ['手动导入'] })
      if (result.cancelled) return
      const course = existing ?? {
        id: `manual-${Date.now()}`,
        code: 'MANUAL',
        name: courseName,
        instructor: '',
        color: courseColors[study.courses.length % courseColors.length],
        sources: ['手动添加' as const],
      }
      setStudy((current) => {
        const importedAt = new Date().toISOString()
        const materials: Material[] = result.items.map((item) => ({
          id: item.id, courseId: course.id, title: item.title, type: item.type, source: '手动添加', meta: item.meta,
          concepts: [], localPath: item.localPath, path: item.path, folder: item.path.at(-1), kind: 'file', knowledgeRole: importKnowledgeRole,
        }))
        const incomingIds = new Set(materials.map((item) => item.id))
        return {
          ...current,
          courses: existing ? current.courses : [...current.courses, course],
          materials: [...current.materials.filter((item) => !incomingIds.has(item.id)), ...materials],
          learningEvents: result.items.length ? mergeLearningEvents(current.learningEvents, [{ id: `material-import:${course.id}:${importedAt}`, type: 'material_import', occurredAt: importedAt, courseId: course.id, value: 1, title: `导入 ${result.items.length} 份资料` }]) : current.learningEvents,
        }
      })
      setVaultRoot(result.vaultRoot ?? vaultRoot)
      setSelectedCourseId(course.id)
      setShowImport(false)
      showToast(result.items.length ? `已收纳 ${result.items.length} 份文件，原文件不会被移动或覆盖。` : '没有导入任何文件。')
    } catch (error) {
      showToast(messageOf(error))
    } finally { setBusyKey(null) }
  }

  const saveJournal = () => {
    const content = journalText.trim()
    if (!content) return showToast('先写下一点这一天的收获或困难。')
    const now = new Date().toISOString()
    const id = editingJournalId ?? `journal-${Date.now()}`
    setStudy((current) => {
      const entry: JournalEntry = { id, date: journalDate, content, mood: journalMood, updatedAt: now }
      const journal = editingJournalId ? current.journal.map((item) => item.id === editingJournalId ? entry : item) : [entry, ...current.journal]
      return { ...current, journal, learningEvents: mergeLearningEvents(current.learningEvents, [{ id: `journal:${id}`, type: 'journal_saved', occurredAt: now, title: content.slice(0, 40) }]) }
    })
    setJournalText('')
    setEditingJournalId(null)
    showToast(editingJournalId ? '学习记录已更新。' : `${journalDate} 的学习记录已保存。`)
  }

  const editJournal = (entry: JournalEntry) => {
    setLearningDay(entry.date)
    setJournalDate(entry.date)
    setJournalText(entry.content)
    setJournalMood(entry.mood)
    setEditingJournalId(entry.id)
  }

  const cancelJournalEdit = () => {
    setJournalText('')
    setJournalMood('平稳')
    setEditingJournalId(null)
  }

  const deleteJournal = (entry: JournalEntry) => {
    if (!window.confirm(`删除 ${entry.date} 的这条学习记录？`)) return
    setStudy((current) => ({ ...current, journal: current.journal.filter((item) => item.id !== entry.id) }))
    if (editingJournalId === entry.id) cancelJournalEdit()
    showToast('学习记录已删除。')
  }

  const selectedCourse = study.courses.find((course) => course.id === selectedCourseId) ?? null
  const courseIds = useMemo(() => study.courses.map((course) => course.id), [study.courses])
  const chooseCourseFilter = (value: string, update: (value: string) => void) => {
    update(value)
    if (value !== 'all' && value !== 'current' && courseIds.includes(value)) setSelectedCourseId(value)
  }
  const activeCourseIdSet = useMemo(() => activeCourseIds(study.courses), [study.courses])
  const libraryMaterials = useMemo(() => study.materials.filter((material) => material.kind !== 'assignment'), [study.materials])
  const selectedMaterials = useMemo(() => selectedCourse ? libraryMaterials.filter((material) => material.courseId === selectedCourse.id) : [], [libraryMaterials, selectedCourse])
  const selectedTree = useMemo(() => buildTree(selectedMaterials), [selectedMaterials])
  const pendingAssignments = useMemo(() => study.assignments.filter((assignment) => !assignmentCompleted(assignment)), [study.assignments])
  const assignmentCourses = useMemo(() => study.courses.filter((course) => study.assignments.some((assignment) => assignment.courseId === course.id)), [study.assignments, study.courses])
  useEffect(() => {
    if (assignmentCourseFilter !== 'all' && !assignmentCourses.some((course) => course.id === assignmentCourseFilter)) setAssignmentCourseFilter('all')
  }, [assignmentCourseFilter, assignmentCourses])
  const visibleAssignments = useMemo(() => study.assignments.filter((assignment) => {
    if (assignmentCourseFilter !== 'all' && assignment.courseId !== assignmentCourseFilter) return false
    return showCompletedAssignments || !assignmentCompleted(assignment)
  }), [assignmentCourseFilter, showCompletedAssignments, study.assignments])
  const assignmentTerms = useMemo(() => {
    const groups = new Map<string, Assignment[]>()
    for (const assignment of visibleAssignments) {
      const term = assignment.term || (assignment.source === 'Gradescope' ? '未分期' : 'Blackboard')
      const list = groups.get(term) ?? []
      list.push(assignment)
      groups.set(term, list)
    }
    return [...groups.entries()]
  }, [visibleAssignments])
  const courseNames = useMemo(() => new Map(study.courses.map((course) => [course.id, course.name])), [study.courses])
  const unreadInboxCount = useMemo(() => unreadSyncInboxCount(study.syncInbox), [study.syncInbox])
  const visibleInboxItems = useMemo(() => study.syncInbox.filter((item) => {
    if (inboxSourceFilter !== 'all' && item.source !== inboxSourceFilter) return false
    if (inboxFilter === 'unread') return !item.readAt && !item.archivedAt
    if (inboxFilter === 'archived') return Boolean(item.archivedAt)
    return !item.archivedAt
  }), [inboxFilter, inboxSourceFilter, study.syncInbox])
  const conceptEvidence = useMemo(() => buildConceptEvidence(knowledgeIndex?.concepts ?? [], study.knowledgeRatings, study.reviewSessions), [knowledgeIndex, study.knowledgeRatings, study.reviewSessions])
  const configuredSearchCommands = useMemo(() => SEARCH_COMMANDS.map((command) => ({ ...command, shortcut: shortcutForAction(appPreferences.shortcuts, command.id) })), [appPreferences.shortcuts])
  const commandCenterShortcut = shortcutForAction(appPreferences.shortcuts, 'command-center')
  const globalSearchEntries = useMemo(() => buildGlobalSearchEntries({ courses: study.courses, materials: study.materials, assignments: study.assignments, concepts: knowledgeIndex?.concepts ?? [], reviewSessions: study.reviewSessions, reviewSchedule: study.reviewSchedule, commands: configuredSearchCommands }), [configuredSearchCommands, knowledgeIndex, study.assignments, study.courses, study.materials, study.reviewSchedule, study.reviewSessions])
  const localCommandResults = useMemo(() => searchGlobalEntries(globalSearchEntries, commandQuery), [commandQuery, globalSearchEntries])
  const commandCenterResults = useMemo(() => mergeBodySearchResults(localCommandResults, bodySearchResults, globalSearchEntries), [bodySearchResults, globalSearchEntries, localCommandResults])
  const upcomingDeadlines = useMemo(() => pendingAssignments
    .filter((assignment) => deadlineState(assignment, deadlineNow) !== 'unknown')
    .sort((a, b) => new Date(assignmentDueAt(a)!).getTime() - new Date(assignmentDueAt(b)!).getTime())
    .slice(0, 6), [deadlineNow, pendingAssignments])
  const activeKnowledgeCourseId = concreteCourseId(knowledgeCourseFilter, selectedCourseId, courseIds)
  const visibleKnowledgeDocuments = useMemo(() => knowledgeIndex?.documents.filter((document) => !activeKnowledgeCourseId || document.courseId === activeKnowledgeCourseId) ?? [], [activeKnowledgeCourseId, knowledgeIndex])
  const batchRefinementCandidates = useMemo(() => eligibleRefinementDocuments(visibleKnowledgeDocuments)
    .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN', { numeric: true })), [visibleKnowledgeDocuments])
  const batchRefinementSelected = useMemo(() => new Set(batchRefinementSelection), [batchRefinementSelection])
  const batchRefinementCurrentCount = useMemo(() => batchRefinementCandidates
    .filter((document) => batchRefinementSelected.has(document.materialId) && refinementState(document) === 'current').length,
  [batchRefinementCandidates, batchRefinementSelected])
  const versionGroupsByMaterialId = useMemo(() => new Map(materialVersionCatalog.groups.map((group) => [group.materialId, group])), [materialVersionCatalog.groups])
  const batchRefinementBytes = useMemo(() => batchRefinementCandidates.filter((document) => batchRefinementSelected.has(document.materialId)).reduce((total, document) => {
    const group = versionGroupsByMaterialId.get(document.materialId)
    return total + (group?.versions.find((version) => version.current)?.bytes ?? 0)
  }, 0), [batchRefinementCandidates, batchRefinementSelected, versionGroupsByMaterialId])
  const latestRefinementJob = refinementJobs[0] ?? null
  const activeRefinementJob = refinementJobs.find((job) => ['running', 'pausing', 'cancelling'].includes(job.status)) ?? null
  useEffect(() => {
    if (busyKey || activeRefinementJob) return
    const { replacements, signatures } = recommendedVersionChanges(materialVersionCatalog.groups, recommendedVersionsAppliedRef.current)
    if (!replacements.size) return
    signatures.forEach((signature) => recommendedVersionsAppliedRef.current.add(signature))
    void applyMaterialVersionPaths(replacements, true).then((success) => {
      if (!success) signatures.forEach((signature) => recommendedVersionsAppliedRef.current.delete(signature))
      else showToast(`已自动为 ${replacements.size} 份资料启用最新的相近版本。`)
    })
  }, [activeRefinementJob, applyMaterialVersionPaths, busyKey, materialVersionCatalog.groups, showToast])
  const visibleKnowledgeConcepts = useMemo(() => knowledgeIndex?.concepts.filter((concept) => !activeKnowledgeCourseId || concept.courseIds.includes(activeKnowledgeCourseId)) ?? [], [activeKnowledgeCourseId, knowledgeIndex])
  const knowledgeDocumentCounts = useMemo(() => visibleKnowledgeDocuments.reduce<Record<Exclude<KnowledgeDocumentFilter, 'all'>, number>>((counts, document) => {
    counts[knowledgeDocumentBucket(document)] += 1
    return counts
  }, { ready: 0, ocr: 0, unsupported: 0, failed: 0 }), [visibleKnowledgeDocuments])
  const displayedKnowledgeDocuments = useMemo(() => visibleKnowledgeDocuments
    .filter((document) => knowledgeDocumentFilter === 'all' || knowledgeDocumentBucket(document) === knowledgeDocumentFilter)
    .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN', { numeric: true })), [knowledgeDocumentFilter, visibleKnowledgeDocuments])
  const activeReviewCourseId = concreteCourseId(reviewCourseFilter, selectedCourseId, courseIds)
  const reviewDocuments = useMemo(() => (knowledgeIndex?.documents ?? []).filter((document) => !activeReviewCourseId || document.courseId === activeReviewCourseId), [activeReviewCourseId, knowledgeIndex])
  const reviewConcepts = useMemo(() => (knowledgeIndex?.concepts ?? [])
    .filter((concept) => !activeReviewCourseId || concept.courseIds.includes(activeReviewCourseId))
    .sort((left, right) => (study.knowledgeRatings[left.id] ?? 0) - (study.knowledgeRatings[right.id] ?? 0) || right.sourceIds.length - left.sourceIds.length || left.title.localeCompare(right.title, 'zh-CN')), [activeReviewCourseId, knowledgeIndex, study.knowledgeRatings])
  const analyzedAssignment = study.assignments.find((assignment) => assignment.id === assignmentAnalysisId) ?? null
  const assignmentCourseConcepts = useMemo(() => (knowledgeIndex?.concepts ?? [])
    .filter((concept) => concept.courseIds.includes(analyzedAssignment?.courseId ?? '')),
  [analyzedAssignment?.courseId, knowledgeIndex])
  const assignmentCandidateSignature = assignmentCourseConcepts.map((concept) => `${concept.id}:${concept.title}`)
  const assignmentAiMatchSourceKey = analyzedAssignment ? assignmentAiSourceKey(
    analyzedAssignment.title,
    `${analyzedAssignment.detailsText ?? ''}\n${(analyzedAssignment.files ?? []).map((file) => `${file.id}:${file.addedAt}`).join('\n')}`,
    assignmentCandidateSignature,
  ) : ''
  const assignmentAiMatch = analyzedAssignment?.aiKnowledge?.sourceKey === assignmentAiMatchSourceKey ? analyzedAssignment.aiKnowledge : null
  const assignmentAiMatchStale = Boolean(analyzedAssignment?.aiKnowledge && !assignmentAiMatch)
  const reviewAssignments = useMemo(() => study.assignments
    .filter((assignment) => !activeReviewCourseId || assignment.courseId === activeReviewCourseId)
    .sort((left, right) => (assignmentDueAt(left) ?? '').localeCompare(assignmentDueAt(right) ?? '')),
  [activeReviewCourseId, study.assignments])
  const reviewRatedCount = reviewConcepts.filter((concept) => (study.knowledgeRatings[concept.id] ?? 0) > 0).length
  const reviewMastery = reviewConcepts.length ? Math.round(reviewConcepts.reduce((sum, concept) => sum + (study.knowledgeRatings[concept.id] ?? 0), 0) / (reviewConcepts.length * 4) * 100) : 0
  const reviewWeakCount = reviewConcepts.filter((concept) => (study.knowledgeRatings[concept.id] ?? 0) > 0 && (study.knowledgeRatings[concept.id] ?? 0) <= 2).length
  const reviewDaysLeft = reviewExamDate ? Math.max(1, Math.ceil((new Date(reviewExamDate + 'T23:59:59').getTime() - deadlineNow.getTime()) / 86_400_000)) : null
  const reviewDailyTarget = reviewDaysLeft ? Math.max(1, Math.ceil(reviewWeakCount / reviewDaysLeft)) : null
  const reviewWorkspaceDocuments = useMemo(() => {
    const sourceById = new Map(knowledgeDocuments.map((document) => [document.materialId, document]))
    const materialById = new Map(study.materials.map((material) => [material.id, material]))
    return reviewDocuments.filter((document) => document.status === 'parsed' || document.status === 'ocr').map((document) => ({ ...document, type: sourceById.get(document.materialId)?.type ?? '文件', path: materialById.get(document.materialId)?.path }))
  }, [knowledgeDocuments, reviewDocuments, study.materials])
  const reviewSelection: ReviewSelection = activeReviewCourseId ? study.reviewSelections[activeReviewCourseId] ?? { materialIds: [], conceptIds: [], focus: '', mode: 'smart' } : { materialIds: [], conceptIds: [], focus: '', mode: 'smart' }
  const reviewSession = activeReviewCourseId ? study.reviewSessions[activeReviewCourseId] ?? null : null
  const reviewToday = calendarDateKey(deadlineNow)
  const automaticReviewDocuments = useMemo(() => (knowledgeIndex?.documents ?? []).filter((document) => activeCourseIdSet.has(document.courseId)), [activeCourseIdSet, knowledgeIndex])
  const automaticReviewConcepts = useMemo(() => (knowledgeIndex?.concepts ?? []).flatMap((concept) => {
    const courseIds = concept.courseIds.filter((courseId) => activeCourseIdSet.has(courseId))
    return courseIds.length ? [{ ...concept, courseIds }] : []
  }), [activeCourseIdSet, knowledgeIndex])
  const automaticReviewSessions = useMemo(() => Object.fromEntries(Object.entries(study.reviewSessions).filter(([courseId]) => activeCourseIdSet.has(courseId))), [activeCourseIdSet, study.reviewSessions])
  const automaticReviewSchedule = useMemo(() => study.reviewSchedule.filter((entry) => activeCourseIdSet.has(entry.courseId)), [activeCourseIdSet, study.reviewSchedule])
  const reviewQueue = useMemo(() => buildReviewQueue(automaticReviewDocuments, automaticReviewConcepts, study.knowledgeRatings, automaticReviewSessions, appPreferences.reviewQueueLimit, automaticReviewSchedule, reviewToday).filter((item) => {
    if (item.scheduleSource === 'manual') return true
    const scheduledDate = item.scheduledDate ?? suggestedNextReviewDate(item, automaticReviewSessions)
    return !scheduledDate || !suggestionIsDismissed(reviewTargetKey(item), scheduledDate, study.dismissedReviewSuggestions)
  }), [appPreferences.reviewQueueLimit, automaticReviewConcepts, automaticReviewDocuments, automaticReviewSchedule, automaticReviewSessions, reviewToday, study.dismissedReviewSuggestions, study.knowledgeRatings])
  const scheduledReviews = useMemo(() => {
    const manualTargets = new Set(study.reviewSchedule.map((entry) => entry.id))
    const automatic = automaticReviewDocuments.filter((document) => document.status === 'parsed' || document.status === 'ocr').flatMap((document) => {
      const item: ReviewQueueItem = { id: `interval:${document.materialId}`, courseId: document.courseId, courseName: document.courseName, title: document.title, reason: '系统间隔建议', priority: 0, materialId: document.materialId }
      if (manualTargets.has(reviewTargetKey(item))) return []
      const scheduledDate = suggestedNextReviewDate(item, automaticReviewSessions)
      if (!scheduledDate || suggestionIsDismissed(reviewTargetKey(item), scheduledDate, study.dismissedReviewSuggestions)) return []
      return [{ ...createReviewScheduleEntry(item, scheduledDate, `${scheduledDate}T00:00:00`), source: 'interval' as const }]
    })
    return [...study.reviewSchedule.map((entry) => ({ ...entry, source: 'manual' as const })), ...automatic].sort((left, right) => left.scheduledDate.localeCompare(right.scheduledDate) || left.title.localeCompare(right.title, 'zh-CN'))
  }, [automaticReviewDocuments, automaticReviewSessions, study.dismissedReviewSuggestions, study.reviewSchedule])
  const calendarWeek = useMemo(() => weekDateKeys(calendarAnchor), [calendarAnchor])
  const calendarHistory = useMemo(() => buildReviewHistory(knowledgeIndex?.documents ?? [], study.reviewSessions), [knowledgeIndex, study.reviewSessions])
  const calendarWeekLabel = `${calendarWeek[0].replaceAll('-', '.')} — ${calendarWeek[6].replaceAll('-', '.')}`
  const reviewInactiveDayCount = useMemo(() => inactiveReviewDays(study.reviewSessions, deadlineNow), [deadlineNow, study.reviewSessions])
  const overdueSystemSuggestions = useMemo(() => scheduledReviews.filter((entry) => entry.source === 'interval' && entry.scheduledDate < reviewToday), [reviewToday, scheduledReviews])
  const completedQuickTests = useMemo(() => Object.values(study.reviewSessions).flatMap((session) => session.quickTests ?? []).filter((test) => test.status === 'completed'), [study.reviewSessions])
  const quickTestAverage = completedQuickTests.length ? Math.round(completedQuickTests.reduce((sum, test) => sum + (test.score ?? 0), 0) / completedQuickTests.length) : null
  const growthCourseMetrics = useMemo(() => buildCourseGrowthMetrics(knowledgeIndex?.documents ?? [], knowledgeIndex?.concepts ?? [], study.knowledgeRatings, study.reviewSessions), [knowledgeIndex, study.knowledgeRatings, study.reviewSessions])
  useEffect(() => {
    if (growthCourseFilter !== 'all' && !growthCourseMetrics.some((course) => course.courseId === growthCourseFilter)) setGrowthCourseFilter('all')
  }, [growthCourseFilter, growthCourseMetrics])
  const growthActivity = useMemo(() => buildGrowthActivity(study.reviewSessions, growthRange, deadlineNow), [deadlineNow, growthRange, study.reviewSessions])
  const growthActivityMax = Math.max(1, ...growthActivity.map((day) => day.total))
  const growthContactedCount = growthCourseMetrics.reduce((sum, course) => sum + course.contactedMaterials, 0)
  const growthConfirmedCount = growthCourseMetrics.reduce((sum, course) => sum + course.confirmedMaterials, 0)
  const growthUnderstoodCount = growthCourseMetrics.reduce((sum, course) => sum + course.understoodMaterials, 0)
  const growthVerifiedCount = growthCourseMetrics.reduce((sum, course) => sum + course.verifiedMaterials, 0)
  const growthTotalMaterialCount = growthCourseMetrics.reduce((sum, course) => sum + course.totalMaterials, 0)
  const growthActiveDays = growthActivity.filter((day) => day.total > 0).length
  const growthConceptEvidence = Object.values(conceptEvidence)
  const growthVerifiedConceptCount = growthConceptEvidence.filter((evidence) => evidence.latestTestScore !== null && evidence.latestTestScore >= 80).length
  const growthConflictConceptCount = growthConceptEvidence.filter((evidence) => evidence.status === 'conflict').length
  const growthSnapshotSeries = useMemo(() => buildGrowthSnapshotSeries(study.growthSnapshots, growthRange, deadlineNow, growthCourseFilter), [deadlineNow, growthCourseFilter, growthRange, study.growthSnapshots])
  const recordedGrowthSnapshots = growthSnapshotSeries.filter((point) => point.recorded)
  const latestGrowthSnapshot = recordedGrowthSnapshots.at(-1) ?? null
  const previousGrowthSnapshot = recordedGrowthSnapshots.at(-2) ?? null
  const growthSnapshotMax = Math.max(1, ...growthSnapshotSeries.flatMap((point) => [point.weakMaterials, point.weakConcepts, point.verifiedConcepts]))
  const growthSnapshotCourseName = growthCourseFilter === 'all' ? '全部课程' : growthCourseMetrics.find((course) => course.courseId === growthCourseFilter)?.courseName ?? '所选课程'
  const visibleGrowthCourseMetrics = visibleCourseMetrics(growthCourseMetrics, showAllGrowthCourses)
  const growthSnapshotDelta = (key: 'weakMaterials' | 'weakConcepts' | 'verifiedConcepts' | 'conflicts') => latestGrowthSnapshot && previousGrowthSnapshot ? latestGrowthSnapshot[key] - previousGrowthSnapshot[key] : null
  const achievementItems = useMemo(() => achievementProgress(achievementContext, study.achievementAwards), [achievementContext, study.achievementAwards])
  const earnedAchievementCount = achievementItems.filter((item) => item.awarded).length
  const visibleAchievementItems = useMemo(() => {
    const filtered = achievementItems.filter((item) => (achievementCategory === 'all' || item.definition.category === achievementCategory) && (achievementView === 'all' || (achievementView === 'earned' ? item.awarded : !item.awarded)))
      .sort((left, right) => Number(Boolean(right.awarded)) - Number(Boolean(left.awarded)) || (right.awarded?.awardedAt ?? '').localeCompare(left.awarded?.awardedAt ?? '') || right.percent - left.percent)
    return showAllAchievements ? filtered : filtered.slice(0, 12)
  }, [achievementCategory, achievementItems, achievementView, showAllAchievements])
  const learningCalendarItems = useMemo(() => buildLearningCalendarItems({ events: study.learningEvents, journal: study.journal, awards: study.achievementAwards, assignments: study.assignments }), [study.achievementAwards, study.assignments, study.journal, study.learningEvents])
  const filteredLearningCalendarItems = useMemo(() => filterLearningCalendarItems(learningCalendarItems, learningCalendarKind, learningCalendarCourse), [learningCalendarCourse, learningCalendarItems, learningCalendarKind])
  const learningMonthGrid = useMemo(() => buildMonthGrid(learningMonth, filteredLearningCalendarItems, deadlineNow), [deadlineNow, filteredLearningCalendarItems, learningMonth])
  const selectedLearningItems = filteredLearningCalendarItems.filter((item) => item.date === learningDay)
  const selectedJournalEntries = study.journal.filter((entry) => entry.date === learningDay)

  useEffect(() => {
    if (!growthCourseMetrics.length) return
    const next = createGrowthSnapshot(growthCourseMetrics, reviewToday)
    setStudy((current) => {
      const growthSnapshots = upsertGrowthSnapshot(current.growthSnapshots, next)
      return growthSnapshots === current.growthSnapshots ? current : { ...current, growthSnapshots }
    })
  }, [growthCourseMetrics, reviewToday])

  useEffect(() => {
    if (!showCommandCenter) return
    setCommandSelectionIndex(0)
    window.setTimeout(() => commandInputRef.current?.focus(), 0)
  }, [showCommandCenter])

  useEffect(() => {
    setCommandSelectionIndex((current) => Math.min(current, Math.max(0, commandCenterResults.length - 1)))
  }, [commandCenterResults.length])

  useEffect(() => {
    const query = commandQuery.trim()
    if (!showCommandCenter || query.startsWith('>') || query.length < 2 || !window.xuejing?.knowledge.search || !knowledgeDocuments.length) {
      setBodySearchResults([])
      setBodySearchBusy(false)
      return
    }
    let cancelled = false
    setBodySearchResults([])
    setBodySearchBusy(true)
    const timer = window.setTimeout(() => {
      void window.xuejing!.knowledge.search({ documents: knowledgeDocuments, query, limit: 18 }).then((results) => {
        if (!cancelled) setBodySearchResults(results)
      }).catch(() => {
        if (!cancelled) setBodySearchResults([])
      }).finally(() => {
        if (!cancelled) setBodySearchBusy(false)
      })
    }, 220)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [commandQuery, knowledgeDocuments, showCommandCenter])

  useEffect(() => {
    if (!analyzedAssignment) {
      setAssignmentKnowledgeDraft([])
      return
    }
    const manual = analyzedAssignment.manualKnowledgeIds?.filter((id) => assignmentCourseConcepts.some((concept) => concept.id === id)) ?? []
    setAssignmentKnowledgeDraft(manual.length ? manual : assignmentAiMatch?.conceptIds ?? [])
  }, [analyzedAssignment?.id, assignmentCourseConcepts])

  const saveReviewSelection = (next: typeof reviewSelection) => {
    if (!activeReviewCourseId) return showToast('请先选择一门具体课程，再保存复习内容。')
    setStudy((current) => ({ ...current, reviewSelections: { ...current.reviewSelections, [activeReviewCourseId]: next } }))
  }
  const saveReviewSession = (next: ReviewSession | null) => {
    if (!activeReviewCourseId) return
    setStudy((current) => {
      const reviewSessions = { ...current.reviewSessions }
      const previous = reviewSessions[activeReviewCourseId]
      const events: LearningEvent[] = []
      if (next) reviewSessions[activeReviewCourseId] = next
      else delete reviewSessions[activeReviewCourseId]
      if (next && (!previous || previous.startedAt !== next.startedAt)) events.push({ id: `review-start:${activeReviewCourseId}:${next.startedAt}`, type: 'review_started', occurredAt: next.startedAt, courseId: activeReviewCourseId, sessionId: next.startedAt, title: '开始复习会话' })
      if (next && previous?.active && !next.active) {
        const occurredAt = new Date().toISOString()
        const minutes = Math.max(1, Math.round((new Date(occurredAt).getTime() - new Date(next.startedAt).getTime()) / 60_000))
        events.push({ id: `review-complete:${activeReviewCourseId}:${next.startedAt}`, type: 'review_completed', occurredAt, courseId: activeReviewCourseId, sessionId: next.startedAt, value: minutes, title: `完成 ${minutes} 分钟复习` })
      }
      const previousAssessments = new Set((previous?.materialReviewHistory ?? []).map((record) => `${record.materialId}:${record.assessedAt}`))
      for (const record of next?.materialReviewHistory ?? []) if (!previousAssessments.has(`${record.materialId}:${record.assessedAt}`)) events.push({ id: `material-confirm:${activeReviewCourseId}:${record.materialId}:${record.assessedAt}`, type: 'material_confirmed', occurredAt: record.assessedAt, courseId: activeReviewCourseId, materialId: record.materialId, value: 1, title: '完成资料掌握确认' })
      const previousTests = new Set((previous?.quickTests ?? []).filter((test) => test.status === 'completed').map((test) => test.id))
      for (const test of next?.quickTests ?? []) if (test.status === 'completed' && !previousTests.has(test.id)) events.push({ id: `quick-test:${test.id}`, type: 'quick_test_completed', occurredAt: new Date().toISOString(), courseId: activeReviewCourseId, sessionId: next?.startedAt, score: test.score, value: 1, title: `快速测试 ${test.score}%` })
      return { ...current, reviewSessions, learningEvents: mergeLearningEvents(current.learningEvents, events) }
    })
  }
  const setReviewScheduleDate = (item: ReviewQueueItem | ReviewScheduleEntry, scheduledDate: string) => {
    setStudy((current) => {
      const id = reviewTargetKey(item)
      const remaining = current.reviewSchedule.filter((entry) => entry.id !== id)
      const occurredAt = new Date().toISOString()
      if (!scheduledDate) return { ...current, reviewSchedule: remaining, learningEvents: mergeLearningEvents(current.learningEvents, [{ id: `schedule:${id}:${occurredAt}`, type: 'schedule_adjusted', occurredAt, courseId: item.courseId, title: '移除复习日程' }]) }
      const queueItem: ReviewQueueItem = { ...item, id, reason: '手动安排', priority: 0 }
      return { ...current, reviewSchedule: [...remaining, createReviewScheduleEntry(queueItem, scheduledDate)], learningEvents: mergeLearningEvents(current.learningEvents, [{ id: `schedule:${id}:${occurredAt}`, type: 'schedule_adjusted', occurredAt, courseId: item.courseId, title: `调整复习日程至 ${scheduledDate}` }]) }
    })
  }
  const updateCalendarDates = (updates: Record<string, string>) => {
    const targets = scheduledReviews.filter((entry) => updates[entry.id])
    if (!targets.length) return
    setStudy((current) => {
      const targetIds = new Set(targets.map((entry) => entry.id))
      const remaining = current.reviewSchedule.filter((entry) => !targetIds.has(entry.id))
      const changed = targets.map((entry) => createReviewScheduleEntry({ ...entry, reason: '日程调整', priority: 0 }, updates[entry.id]))
      return { ...current, reviewSchedule: [...remaining, ...changed] }
    })
    setCalendarSelection([])
    setCalendarBatchDate('')
  }
  const shiftSelectedCalendarItems = (days: number) => updateCalendarDates(Object.fromEntries(scheduledReviews.filter((entry) => calendarSelection.includes(entry.id)).map((entry) => [entry.id, shiftDate(entry.scheduledDate, days)])))
  const distributeSelectedCalendarItems = () => {
    const existingDates = Object.fromEntries(scheduledReviews.filter((entry) => !calendarSelection.includes(entry.id)).map((entry) => [entry.id, entry.scheduledDate]))
    updateCalendarDates(distributeAcrossWeek(calendarSelection, existingDates, calendarAnchor))
  }
  const moveSelectedToWeekend = () => updateCalendarDates(Object.fromEntries(calendarSelection.map((id) => [id, calendarWeek[5]])))
  const moveSelectedToDate = () => {
    if (!calendarBatchDate) return
    updateCalendarDates(Object.fromEntries(calendarSelection.map((id) => [id, calendarBatchDate])))
  }
  const toggleCalendarSelection = (id: string) => setCalendarSelection((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  const toggleCalendarHistory = (date: string) => setExpandedCalendarHistory((current) => current.includes(date) ? current.filter((item) => item !== date) : [...current, date])
  const changeCalendarAnchor = (date: string) => { setCalendarAnchor(date); setCalendarSelection([]); setCalendarBatchDate(''); setExpandedCalendarHistory([]) }
  const dismissReviewSuggestion = (entry: ReviewScheduleEntry) => {
    setStudy((current) => ({ ...current, dismissedReviewSuggestions: { ...current.dismissedReviewSuggestions, [entry.id]: entry.scheduledDate } }))
    setCalendarSelection((current) => current.filter((id) => id !== entry.id))
  }
  const dismissOverdueSuggestions = () => {
    setStudy((current) => ({ ...current, dismissedReviewSuggestions: { ...current.dismissedReviewSuggestions, ...Object.fromEntries(overdueSystemSuggestions.map((entry) => [entry.id, entry.scheduledDate])) } }))
    setCalendarSelection([])
  }
  const redistributeOverdueSuggestions = () => {
    const existing = Object.fromEntries(scheduledReviews.filter((entry) => !overdueSystemSuggestions.some((overdue) => overdue.id === entry.id)).map((entry) => [entry.id, entry.scheduledDate]))
    updateCalendarDates(distributeAcrossWeek(overdueSystemSuggestions.map((entry) => entry.id), existing, reviewToday))
  }
  const openCalendarItem = (item: { id: string; courseId: string; courseName: string; title: string; materialId?: string; conceptId?: string; label?: string }) => openReviewQueueItem({ ...item, reason: item.label ?? '从复习日程打开', priority: 0 })
  const openReviewQueueItem = (item: ReviewQueueItem) => {
    setStudy((current) => ({ ...current, reviewSelections: { ...current.reviewSelections, [item.courseId]: selectionForReviewQueueItem(item) } }))
    setSelectedCourseId(item.courseId)
    setReviewCourseFilter(item.courseId)
    setSection('review')
  }
  const openGrowthReview = (courseId: string, materialIds: string[] = []) => {
    if (materialIds.length) {
      setStudy((current) => ({ ...current, reviewSelections: { ...current.reviewSelections, [courseId]: { materialIds, conceptIds: [], focus: '', mode: 'manual' } } }))
    }
    setSelectedCourseId(courseId)
    setReviewCourseFilter(courseId)
    setSection('review')
  }
  const openConceptReview = (conceptId: string, courseId: string) => {
    setStudy((current) => ({ ...current, reviewSelections: { ...current.reviewSelections, [courseId]: { materialIds: [], conceptIds: [conceptId], focus: '', mode: 'manual' } } }))
    setSelectedCourseId(courseId)
    setReviewCourseFilter(courseId)
    setSection('review')
  }
  const openGrowthEvidenceReview = (courseId: string, materialIds: string[], conceptIds: string[]) => {
    setStudy((current) => ({ ...current, reviewSelections: { ...current.reviewSelections, [courseId]: { materialIds, conceptIds, focus: '', mode: 'manual' } } }))
    setSelectedCourseId(courseId)
    setReviewCourseFilter(courseId)
    setSection('review')
  }
  const confirmCourseCompletion = () => {
    if (!courseCompletionId) return
    const course = study.courses.find((item) => item.id === courseCompletionId)
    setStudy((current) => {
      const occurredAt = new Date().toISOString()
      const result = completeCourse(current.courses, current.reviewSchedule, current.reviewSessions, courseCompletionId, {
        removeFutureManualSchedule: removeCourseManualSchedule,
        today: reviewToday,
      })
      return { ...current, ...result, learningEvents: mergeLearningEvents(current.learningEvents, [{ id: `course-complete:${courseCompletionId}:${occurredAt}`, type: 'course_completed', occurredAt, courseId: courseCompletionId, title: course?.name ?? '课程结课' }]) }
    })
    setCourseCompletionId(null)
    setRemoveCourseManualSchedule(false)
    showToast(`${course?.name ?? '课程'}已标记为结课，自动复习安排已停止。`)
  }
  const restoreCourse = (course: Course) => {
    setStudy((current) => ({ ...current, courses: reopenCourse(current.courses, course.id) }))
    showToast(`${course.name}已重新开课，将恢复进入自动复习建议。`)
  }
  const cachedCount = study.materials.filter((material) => material.localPath && fileStates.get(material.localPath) === 'available').length
  const missingCount = study.materials.filter((material) => material.localPath && fileStates.get(material.localPath) === 'missing').length

  useEffect(() => {
    localStorage.setItem('xuejing-deadline-reminders-v1', String(deadlineRemindersEnabled))
  }, [deadlineRemindersEnabled])

  useEffect(() => {
    const timer = window.setInterval(() => setDeadlineNow(new Date()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    if (!deadlineRemindersEnabled || !window.xuejing?.deadlines?.notify) return
    let cancelled = false
    const notify = async () => {
      let seen: Record<string, true> = {}
      try { seen = JSON.parse(localStorage.getItem('xuejing-deadline-notices-v1') ?? '{}') as Record<string, true> } catch { /* 忽略损坏的历史提醒记录。 */ }
      const candidates = pendingAssignments
        .map((assignment) => ({ assignment, bucket: deadlineReminderBucket(assignment, deadlineNow) }))
        .filter((item): item is { assignment: Assignment; bucket: string } => Boolean(item.bucket))
        .filter((item) => !seen[`${item.assignment.id}:${assignmentDueAt(item.assignment)}:${item.bucket}`])
        .slice(0, 3)
      for (const { assignment, bucket } of candidates) {
        if (cancelled) return
        const key = `${assignment.id}:${assignmentDueAt(assignment)}:${bucket}`
        const course = courseNames.get(assignment.courseId) ?? assignment.sourceCourseName
        const result = await window.xuejing?.deadlines.notify({ title: `DDL 提醒：${deadlineLabel(assignment, deadlineNow)}`, body: `${course} · ${assignment.title}` })
        if (result?.shown) seen[key] = true
      }
      localStorage.setItem('xuejing-deadline-notices-v1', JSON.stringify(seen))
    }
    void notify()
    return () => { cancelled = true }
  }, [courseNames, deadlineNow, deadlineRemindersEnabled, pendingAssignments])

  useEffect(() => {
    if (!emailConfig.enabled || !emailConfig.configured || !emailConfig.notifyDeadlines || !window.xuejing?.email) return
    if (isQuietHour(appPreferences.autoSync, deadlineNow)) return
    let cancelled = false
    const notifyByEmail = async () => {
      let seen: Record<string, true> = {}
      let failedAt: Record<string, string> = {}
      try { seen = JSON.parse(localStorage.getItem('xuejing-deadline-email-notices-v1') ?? '{}') as Record<string, true> } catch { /* 忽略损坏的邮件提醒记录。 */ }
      try { failedAt = JSON.parse(localStorage.getItem('xuejing-deadline-email-failures-v1') ?? '{}') as Record<string, string> } catch { /* 忽略损坏的失败记录。 */ }
      const candidates = deadlineEmailCandidates(study.assignments, activeCourseIdSet, appPreferences.autoSync.deadlineEmailThresholdDays, seen, deadlineNow)
        .filter((candidate) => !failedAt[candidate.key] || deadlineNow.getTime() - new Date(failedAt[candidate.key]).getTime() >= 30 * 60_000)
      if (!candidates.length || cancelled) return
      const fingerprint = candidates.map((candidate) => candidate.key).join('|')
      try {
        const result = await window.xuejing?.email.sendDeadlineDigest({ items: candidates.map(({ assignment, dueAt, thresholdDays }) => ({ course: courseNames.get(assignment.courseId) ?? assignment.sourceCourseName, title: assignment.title, deadline: new Date(dueAt).toLocaleString('zh-CN', { hour12: false }), label: `提前 ${thresholdDays} 天提醒 · ${deadlineLabel(assignment, deadlineNow)}` })) })
        if (result?.sent) {
          for (const candidate of candidates) { seen[candidate.key] = true; delete failedAt[candidate.key] }
          setStudy((current) => {
            const next = { ...current, syncInbox: mergeSyncInbox(current.syncInbox, [emailDeliveryInboxItem('sent', `SMTP 已接受发送至 ${emailConfig.recipient} 的 ${candidates.length} 项 DDL 提醒。若未收到，请检查垃圾邮件或收件服务器策略。`, fingerprint)]) }
            studyRef.current = next
            return next
          })
        }
      } catch (error) {
        const failedTime = new Date().toISOString()
        for (const candidate of candidates) failedAt[candidate.key] = failedTime
        setStudy((current) => {
          const next = { ...current, syncInbox: mergeSyncInbox(current.syncInbox, [emailDeliveryInboxItem('failed', messageOf(error), fingerprint)]) }
          studyRef.current = next
          return next
        })
        showToast(`DDL 邮件提醒发送失败：${messageOf(error)}`)
      }
      localStorage.setItem('xuejing-deadline-email-notices-v1', JSON.stringify(seen))
      localStorage.setItem('xuejing-deadline-email-failures-v1', JSON.stringify(failedAt))
    }
    void notifyByEmail()
    return () => { cancelled = true }
  }, [activeCourseIdSet, appPreferences.autoSync, courseNames, deadlineNow, emailConfig.configured, emailConfig.enabled, emailConfig.notifyDeadlines, emailConfig.recipient, showToast, study.assignments])

  useEffect(() => {
    if (!appPreferences.reviewRemindersEnabled || !reviewQueue.length || !window.xuejing?.deadlines?.notify) return
    const noticeKey = `xuejing-review-notice:${reviewToday}`
    if (localStorage.getItem(noticeKey) === 'shown') return
    let cancelled = false
    void window.xuejing.deadlines.notify({ title: `今日复习提醒：${reviewQueue.length} 项`, body: `${reviewQueue[0].courseName} · ${reviewQueue[0].title}` }).then((result) => {
      if (!cancelled && result?.shown) localStorage.setItem(noticeKey, 'shown')
    })
    return () => { cancelled = true }
  }, [appPreferences.reviewRemindersEnabled, reviewQueue, reviewToday])

  const toggleFolder = (path: string[]) => setExpandedFolders((current) => toggledFolders(current, folderKey(selectedCourseId ?? '', path)))
  const openSubmission = async (url?: string) => {
    if (!url) return showToast('这份手动作业没有设置网页链接。')
    try {
      const host = new URL(url).hostname
      if (host === 'www.gradescope.com') {
        await window.xuejing?.gradescope.openSubmission(url)
        showToast('已在默认浏览器打开 Gradescope 作业页；请在页面中自行上传并最终提交。')
      } else {
        if (host === 'elearning.shanghaitech.edu.cn') await window.xuejing?.blackboard.openSubmission(url)
        else await window.xuejing?.external.openUrl(url)
        showToast('已在默认浏览器打开 Blackboard 提交页面。')
      }
    } catch (error) { showToast(messageOf(error)) }
  }
  const openLink = async (url: string) => {
    try { await window.xuejing?.external.openUrl(url); showToast('已在默认浏览器打开链接。') } catch (error) { showToast(messageOf(error)) }
  }

  const openMapDocumentInReview = (materialId: string, courseId: string, conceptId?: string) => {
    const conceptIds = conceptId ? [conceptId] : (knowledgeIndex?.concepts ?? []).filter((concept) => concept.courseIds.includes(courseId) && concept.sourceIds.includes(materialId)).map((concept) => concept.id).slice(0, 8)
    setStudy((current) => ({
      ...current,
      reviewSelections: { ...current.reviewSelections, [courseId]: { materialIds: [materialId], conceptIds, focus: current.reviewSelections[courseId]?.focus ?? '', mode: 'manual' } },
      reviewSessions: { ...current.reviewSessions, [courseId]: createReviewSession([materialId], conceptIds, current.reviewSessions[courseId]) },
    }))
    setSelectedCourseId(courseId)
    setReviewCourseFilter(courseId)
    setSection('review')
  }

  const openAssignmentAnalysis = (assignment: Assignment) => {
    setAssignmentAnalysisId(assignment.id)
  }

  const openManualAssignment = () => {
    const defaultCourse = study.courses.find((course) => course.id === selectedCourseId) ?? study.courses[0]
    setManualAssignmentCourseId(defaultCourse?.id ?? '')
    setManualAssignmentCourseName('')
    setManualAssignmentTitle('')
    setManualAssignmentDueAt('')
    setManualAssignmentDetails('')
    setManualAssignmentUrl('')
    setShowManualAssignment(true)
  }

  const saveManualAssignment = () => {
    const selectedCourse = study.courses.find((course) => course.id === manualAssignmentCourseId)
    const createdAt = new Date().toISOString()
    const stamp = Date.now()
    const course: Course = selectedCourse ?? {
      id: `manual-course-${stamp}`,
      code: 'MANUAL',
      name: manualAssignmentCourseName.trim(),
      instructor: '',
      color: courseColors[study.courses.length % courseColors.length],
      sources: ['手动添加'],
    }
    try {
      const assignment = createManualAssignment({
        courseId: course.id,
        courseName: course.name,
        title: manualAssignmentTitle,
        dueAt: manualAssignmentDueAt,
        detailsText: manualAssignmentDetails,
        url: manualAssignmentUrl,
      }, { id: `manual-assignment-${stamp}`, now: createdAt })
      setStudy((current) => ({
        ...current,
        courses: selectedCourse ? current.courses : [...current.courses, course],
        assignments: [...current.assignments, assignment],
      }))
      setSelectedCourseId(course.id)
      setAssignmentCourseFilter(course.id)
      setShowManualAssignment(false)
      setAssignmentAnalysisId(assignment.id)
      showToast('已添加手动作业，并打开分析页面；可继续添加题目文件或请求 AI 匹配。')
    } catch (error) {
      showToast(messageOf(error))
    }
  }

  const readAssignmentDetails = async () => {
    if (!analyzedAssignment || analyzedAssignment.source !== 'Blackboard' || !analyzedAssignment.url) return
    const api = window.xuejing?.assignments
    if (!api?.details) return showToast('请在 Windows 桌面应用中读取作业说明。')
    setBusyKey('assignment-details:' + analyzedAssignment.id)
    try {
      const result = await api.details({ source: analyzedAssignment.source, url: analyzedAssignment.url })
      setStudy((current) => ({
        ...current,
        assignments: current.assignments.map((assignment) => assignment.id === analyzedAssignment.id ? { ...assignment, detailsText: result.text, detailsFetchedAt: result.fetchedAt } : assignment),
      }))
      showToast(result.text ? '已读取作业说明。确认内容后可点击“AI 匹配知识点”。' : '该页面没有读取到可用于匹配的题目说明；可添加作业文件或手动选择知识点。')
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const requestAssignmentAiMatch = async () => {
    if (!analyzedAssignment) return
    if (!assignmentCourseConcepts.length) return showToast('当前课程还没有可供 AI 选择的知识点。请先在知识库中构建课程知识点。')
    if (!aiConfig.configured) {
      setShowAiSettings(true)
      return showToast('请先配置 AI API；只有你点击“AI 匹配知识点”时才会发送题目说明。')
    }
    setBusyKey('assignment-ai-match:' + analyzedAssignment.id)
    try {
      const fileResult = analyzedAssignment.files?.length
        ? await window.xuejing?.assignments.fileContents({ files: analyzedAssignment.files.map((file) => ({ localPath: file.localPath, title: file.title })) })
        : { contents: [] }
      const readableFiles = fileResult?.contents.filter((file) => file.text.trim()) ?? []
      const fileErrors = fileResult?.contents.filter((file) => file.error).map((file) => `${file.title}：${file.error}`).join('；') ?? ''
      if (!analyzedAssignment.detailsText?.trim() && !readableFiles.length) {
        throw new Error(fileErrors || '请先为 Blackboard 读取作业说明，或添加可解析的 PDF、DOCX、PPTX/PPT、LaTeX 作业文件。')
      }
      const context = [
        `作业标题：${analyzedAssignment.title}`,
        analyzedAssignment.detailsText?.trim() ? `网页作业说明：\n${analyzedAssignment.detailsText.trim()}` : '',
        ...readableFiles.map((file) => `作业附件：${file.title}\n${file.text}`),
        '',
        '可选择的课程知识点（方括号内是必须原样返回的 ID）：',
        ...assignmentCourseConcepts.map((concept) => `[${concept.id}] ${concept.title}`),
      ].filter(Boolean).join('\n\n').slice(0, 60_000)
      const result = await window.xuejing?.ai.chat({
        context,
        messages: [{
          role: 'user',
          content: '请只根据作业说明，选择完成这份作业前应复习的课程知识点。只返回 JSON，不要 Markdown：{"conceptIds":["最多 8 个给定的完整 ID"],"explanation":"不超过 180 字，说明每项与题目的关系"}。没有足够证据时返回 {"conceptIds":[],"explanation":"原因"}。不得编造 ID，不得根据学生自评或课程薄弱项补充推荐。',
        }],
      })
      const parsed = parseAssignmentAiMatch(result?.content ?? '', assignmentCourseConcepts.map((concept) => concept.id))
      if (!parsed) throw new Error('AI 没有返回可验证的课程知识点。请检查题目说明是否包含具体要求后重试。')
      const generatedAt = new Date().toISOString()
      const sourceKey = assignmentAiSourceKey(
        analyzedAssignment.title,
        `${analyzedAssignment.detailsText ?? ''}\n${(analyzedAssignment.files ?? []).map((file) => `${file.id}:${file.addedAt}`).join('\n')}`,
        assignmentCourseConcepts.map((concept) => `${concept.id}:${concept.title}`),
      )
      setStudy((current) => ({
        ...current,
        assignments: current.assignments.map((assignment) => assignment.id === analyzedAssignment.id ? {
          ...assignment,
          aiKnowledge: { ...parsed, model: result?.model ?? aiConfig.model, generatedAt, sourceKey },
        } : assignment),
      }))
      setAssignmentKnowledgeDraft(parsed.conceptIds)
      showToast(`AI 已提出 ${parsed.conceptIds.length} 个知识点建议；请确认后再保存。`)
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const addAssignmentFiles = async () => {
    if (!analyzedAssignment) return
    const api = window.xuejing?.assignments
    if (!api?.importFiles) return showToast('请在 Windows 桌面应用中添加作业文件。')
    setBusyKey('assignment-files:' + analyzedAssignment.id)
    try {
      const result = await api.importFiles({ courseName: courseNames.get(analyzedAssignment.courseId) ?? analyzedAssignment.sourceCourseName, assignmentId: analyzedAssignment.id, assignmentTitle: analyzedAssignment.title })
      if (result.cancelled || !result.items.length) return
      if (result.vaultRoot) setVaultRoot(result.vaultRoot)
      setStudy((current) => ({
        ...current,
        assignments: current.assignments.map((assignment) => {
          if (assignment.id !== analyzedAssignment.id) return assignment
          const files = [...(assignment.files ?? [])]
          const existingPaths = new Set(files.map((file) => file.localPath))
          for (const item of result.items) {
            if (existingPaths.has(item.localPath)) continue
            files.push({ id: item.id, title: item.title, type: item.type, localPath: item.localPath, addedAt: new Date().toISOString(), managed: item.managed })
            existingPaths.add(item.localPath)
          }
          return { ...assignment, files }
        }),
      }))
      showToast(`已将 ${result.items.length} 个文件关联到这份作业；原文件不会被修改。`)
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const removeAssignmentFile = async (file: AssignmentFile) => {
    if (!analyzedAssignment) return
    setBusyKey('assignment-file-remove:' + analyzedAssignment.id)
    try {
      if (file.managed) {
        const result = await window.xuejing?.assignments.removeFiles({ assignmentId: analyzedAssignment.id, filePaths: [file.localPath] })
        if (!result || result.rejected.length) throw new Error('无法确认该文件属于当前作业，未删除资料库文件。')
      }
      setStudy((current) => ({
        ...current,
        assignments: current.assignments.map((assignment) => assignment.id === analyzedAssignment.id ? { ...assignment, files: assignment.files?.filter((item) => item.id !== file.id) } : assignment),
      }))
      showToast(file.managed ? '已移除作业文件，并删除资料库中该作业专属副本。' : '已取消旧作业文件的关联；旧版本文件仍保留在资料库中。')
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const openAssignmentFile = async (filePath: string) => {
    try {
      const result = await window.xuejing?.documents.openLocal(filePath)
      if (!result?.opened) throw new Error('无法打开本地作业文件')
    } catch (error) {
      showToast(messageOf(error))
    }
  }

  const saveAssignmentKnowledge = (ids = assignmentKnowledgeDraft) => {
    if (!analyzedAssignment) return
    const validIds = [...new Set(ids)].filter((id) => assignmentCourseConcepts.some((concept) => concept.id === id))
    const occurredAt = new Date().toISOString()
    setStudy((current) => ({
      ...current,
      assignments: current.assignments.map((assignment) => assignment.id === analyzedAssignment.id ? { ...assignment, manualKnowledgeIds: validIds.length ? validIds : undefined } : assignment),
      learningEvents: validIds.length ? mergeLearningEvents(current.learningEvents, [{ id: `assignment-analysis:${analyzedAssignment.id}:${occurredAt}`, type: 'assignment_analyzed', occurredAt, assignmentId: analyzedAssignment.id, courseId: analyzedAssignment.courseId, title: analyzedAssignment.title }]) : current.learningEvents,
    }))
    showToast(validIds.length ? `已保存 ${validIds.length} 个作业前置知识点；后续同步会保留。` : '已清除手动映射，将恢复自动建议。')
  }

  const bringAssignmentKnowledgeToReview = () => {
    if (!analyzedAssignment || !assignmentKnowledgeDraft.length) return showToast('请先至少选择一个知识点。')
    const selectedConcepts = assignmentCourseConcepts.filter((concept) => assignmentKnowledgeDraft.includes(concept.id))
    const materialIds = [...new Set(selectedConcepts.flatMap((concept) => concept.sourceIds))]
    setStudy((current) => ({
      ...current,
      assignments: current.assignments.map((assignment) => assignment.id === analyzedAssignment.id ? { ...assignment, manualKnowledgeIds: selectedConcepts.map((concept) => concept.id) } : assignment),
      reviewSelections: {
        ...current.reviewSelections,
        [analyzedAssignment.courseId]: {
          materialIds,
          conceptIds: selectedConcepts.map((concept) => concept.id),
          focus: `完成「${analyzedAssignment.title}」前的前置复习`,
          mode: 'manual',
        },
      },
    }))
    setAssignmentAnalysisId(null)
    setSelectedCourseId(analyzedAssignment.courseId)
    setReviewCourseFilter(analyzedAssignment.courseId)
    setSection('review')
    showToast(`已将 ${selectedConcepts.length} 个知识点和 ${materialIds.length} 份来源课件带入复习选择。`)
  }

  const toggleAssignmentCompletion = (assignment: Assignment) => {
    const occurredAt = new Date().toISOString()
    const markingCompleted = assignment.manualStatus !== 'completed'
    setStudy((current) => ({
      ...current,
      assignments: current.assignments.map((item) => item.id !== assignment.id ? item : {
        ...item,
        manualStatus: item.manualStatus === 'completed' ? undefined : 'completed',
      }),
      learningEvents: markingCompleted ? mergeLearningEvents(current.learningEvents, [{ id: `assignment-complete:${assignment.id}`, type: 'assignment_completed', occurredAt, assignmentId: assignment.id, courseId: assignment.courseId, title: assignment.title }]) : current.learningEvents,
    }))
    showToast(assignment.manualStatus === 'completed' ? '已恢复为待处理作业。' : '已标记为手动完成；下次同步仍会保留该标记。')
  }

  const openDeadlineEditor = (assignment: Assignment) => {
    setDeadlineEditorId(assignment.id)
    setDeadlineDraft(toDateTimeLocalValue(assignmentDueAt(assignment)))
  }

  const saveManualDeadline = (value = deadlineDraft) => {
    if (!deadlineEditorId) return
    const manualDueAt = value ? new Date(value).toISOString() : undefined
    if (value && Number.isNaN(new Date(value).getTime())) return showToast('请输入有效的截止日期和时间。')
    setStudy((current) => ({
      ...current,
      assignments: current.assignments.map((item) => item.id === deadlineEditorId ? { ...item, manualDueAt } : item),
    }))
    setDeadlineEditorId(null)
    showToast(manualDueAt ? '已保存人工截止时间；它会优先于平台同步值。' : '已清除人工截止时间，将恢复使用平台同步值。')
  }

  const closeCommandCenter = () => {
    setShowCommandCenter(false)
    setCommandQuery('')
    setBodySearchResults([])
    setBodySearchBusy(false)
  }

  const saveShortcutBinding = (bindingId: string, binding: { enabled: boolean; accelerator: string }) => {
    setAppPreferences((current) => ({ ...current, shortcuts: { ...current.shortcuts, [bindingId]: binding } }))
  }

  const toggleShortcutBinding = (bindingId: string, enabled: boolean) => {
    const binding = appPreferences.shortcuts[bindingId]
    if (!binding) return
    if (enabled) {
      const conflict = shortcutConflict(appPreferences.shortcuts, bindingId, binding.accelerator)
      if (conflict) { setShortcutError(`无法启用：与“${conflict.label}”的 ${displayAccelerator(binding.accelerator)} 冲突。`); return }
    }
    setShortcutError('')
    saveShortcutBinding(bindingId, { ...binding, enabled })
  }

  const resetShortcutBinding = (bindingId: string) => {
    const fallback = DEFAULT_SHORTCUT_PREFERENCES[bindingId]
    if (!fallback) return
    const conflict = shortcutConflict(appPreferences.shortcuts, bindingId, fallback.accelerator)
    if (fallback.enabled && conflict) { setShortcutError(`无法恢复默认：${displayAccelerator(fallback.accelerator)} 已被“${conflict.label}”使用。`); return }
    setShortcutError('')
    saveShortcutBinding(bindingId, { ...fallback })
  }

  const resetAllShortcutBindings = () => {
    setShortcutError('')
    setRecordingShortcutId(null)
    updateAppPreference('shortcuts', normalizeShortcutPreferences(DEFAULT_SHORTCUT_PREFERENCES))
  }

  const revealMaterialInLibrary = (material: Material) => {
    setSelectedCourseId(material.courseId)
    setExpandedFolders((current) => {
      const next = new Set(current)
      const parts = material.path ?? []
      for (let length = 1; length <= parts.length; length += 1) next.add(folderKey(material.courseId, parts.slice(0, length)))
      return next
    })
    setSection('library')
  }

  const executeAppCommand = (commandId: string) => {
    const navigation: Record<string, Section> = { 'nav-1': 'overview', 'nav-inbox': 'inbox', 'nav-2': 'library', 'nav-3': 'assignments', 'nav-4': 'knowledge', 'nav-5': 'map', 'nav-6': 'review', 'nav-7': 'schedule', 'nav-8': 'focus', 'nav-9': 'growth', 'nav-0': 'settings', 'nav-settings': 'settings' }
    if (navigation[commandId]) {
      setSection(navigation[commandId])
      return
    }
    if (commandId === 'sync-blackboard') void (connected ? syncBlackboard() : connectBlackboard())
    else if (commandId === 'sync-gradescope') void (gradescopeConnected ? syncGradescope() : connectGradescope())
    else if (commandId === 'import-materials') setShowImport(true)
    else if (commandId === 'build-knowledge') { setSection('knowledge'); void buildKnowledgeBase() }
    else if (commandId === 'toggle-focus') { setSection('focus'); setFocusRunning((current) => !current) }
    else if (commandId === 'add-assignment') { setSection('assignments'); openManualAssignment() }
  }

  const executeSearchEntry = (entry: GlobalSearchEntry) => {
    closeCommandCenter()
    if (entry.kind === 'command' && entry.commandId) return executeAppCommand(entry.commandId)
    if (entry.kind === 'course' && entry.courseId) {
      setSelectedCourseId(entry.courseId)
      setSection('library')
      return
    }
    if (entry.kind === 'material' && entry.materialId) {
      const material = study.materials.find((item) => item.id === entry.materialId)
      if (!material) return
      if (material.kind === 'link' && material.url) return void openLink(material.url)
      if (material.localPath && material.kind !== 'folder') {
        const indexed = knowledgeIndex?.documents.find((document) => document.materialId === material.id)
        if (indexed && (indexed.status === 'parsed' || indexed.status === 'ocr')) return openMapDocumentInReview(material.id, material.courseId)
        return void window.xuejing?.documents.openLocal(material.localPath)
      }
      revealMaterialInLibrary(material)
      return
    }
    if (entry.kind === 'concept' && entry.conceptId && entry.courseId) return openConceptReview(entry.conceptId, entry.courseId)
    if (entry.kind === 'assignment' && entry.assignmentId) {
      const assignment = study.assignments.find((item) => item.id === entry.assignmentId)
      if (assignment) { setSection('assignments'); openAssignmentAnalysis(assignment) }
      return
    }
    if (entry.kind === 'review' && entry.courseId) {
      if (entry.materialId) return openMapDocumentInReview(entry.materialId, entry.courseId)
      if (entry.conceptId) return openConceptReview(entry.conceptId, entry.courseId)
      setSelectedCourseId(entry.courseId)
      setReviewCourseFilter(entry.courseId)
      setSection('review')
    }
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (recordingShortcutId) {
        event.preventDefault()
        if (event.key === 'Escape') { setRecordingShortcutId(null); setShortcutError(''); return }
        const accelerator = acceleratorFromEvent(event)
        if (!accelerator) {
          if (!['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) setShortcutError('快捷键必须包含 Ctrl、Alt 或 Meta，并使用字母、数字、标点或 F1～F12。')
          return
        }
        const conflict = shortcutConflict(appPreferences.shortcuts, recordingShortcutId, accelerator)
        if (conflict) { setShortcutError(`${displayAccelerator(accelerator)} 已被“${conflict.label}”使用，请换一个组合。`); return }
        const current = appPreferences.shortcuts[recordingShortcutId]
        saveShortcutBinding(recordingShortcutId, { enabled: current?.enabled ?? true, accelerator })
        setRecordingShortcutId(null)
        setShortcutError('')
        return
      }
      if (showCommandCenter) {
        if (event.key === 'Escape') { event.preventDefault(); closeCommandCenter(); return }
        if (event.key === 'ArrowDown') { event.preventDefault(); setCommandSelectionIndex((current) => commandCenterResults.length ? (current + 1) % commandCenterResults.length : 0); return }
        if (event.key === 'ArrowUp') { event.preventDefault(); setCommandSelectionIndex((current) => commandCenterResults.length ? (current - 1 + commandCenterResults.length) % commandCenterResults.length : 0); return }
        if (event.key === 'Enter' && commandCenterResults[commandSelectionIndex]) { event.preventDefault(); executeSearchEntry(commandCenterResults[commandSelectionIndex]); return }
      }
      const target = event.target as HTMLElement | null
      const typing = Boolean(target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? ''))
      const commandId = resolveConfiguredShortcut(appPreferences.shortcuts, event, typing)
      if (!commandId) return
      event.preventDefault()
      if (commandId === 'command-center') {
        setShowCommandCenter(true)
        return
      }
      executeAppCommand(commandId)
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [appPreferences.shortcuts, commandCenterResults, commandSelectionIndex, connected, gradescopeConnected, recordingShortcutId, showCommandCenter])

  const updateInbox = (ids: string[], action: 'read' | 'unread' | 'archive') => {
    setStudy((current) => ({ ...current, syncInbox: updateSyncInboxItems(current.syncInbox, ids, action) }))
  }

  const openInboxItem = (item: SyncInboxItem) => {
    updateInbox([item.id], 'read')
    if (item.kind === 'email_sent' || item.kind === 'email_failed') {
      setEmailPassword('')
      setEmailTestState(null)
      setShowEmailSettings(true)
      return
    }
    if (item.kind === 'connection_required') {
      if (item.source === 'Blackboard') void connectBlackboard()
      else void connectGradescope()
      return
    }
    if (item.assignmentId) {
      setAssignmentAnalysisId(item.assignmentId)
      setSection('assignments')
      return
    }
    if (item.courseId) setSelectedCourseId(item.courseId)
    setSection('library')
  }

  const navItems: { id: Section; label: string; icon: typeof BookOpen }[] = [
    { id: 'overview', label: '学习总览', icon: GraduationCap }, { id: 'inbox', label: '学习收件箱', icon: Inbox }, { id: 'library', label: '课程资料', icon: BookOpen },
    { id: 'assignments', label: '作业中心', icon: Send }, { id: 'knowledge', label: '知识库', icon: Network }, { id: 'map', label: '知识图谱', icon: Network }, { id: 'review', label: '期末复习', icon: Database }, { id: 'schedule', label: '复习日程', icon: CalendarDays }, { id: 'focus', label: '专注计时', icon: Timer }, { id: 'growth', label: '成长日记', icon: FileText },
    { id: 'settings', label: '设置', icon: Settings2 },
  ]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">径</span>学径</div>
        <div className="semester"><span className="eyebrow">学习聚合平台</span><strong>本学期</strong><span>从真实课程资料开始建立你的学习地图</span></div>
        <nav className="nav-list">
          {navItems.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${section === id ? 'active' : ''}`} onClick={() => setSection(id)}><Icon size={17} />{label}{id === 'inbox' && unreadInboxCount ? <b>{unreadInboxCount}</b> : id === 'library' && libraryMaterials.length ? <b>{libraryMaterials.length}</b> : id === 'assignments' && pendingAssignments.length ? <b>{pendingAssignments.length}</b> : null}</button>)}
        </nav>
        <button className="command-center-trigger" onClick={() => setShowCommandCenter(true)}><Search size={14} /><span>全局搜索与快捷操作</span><kbd>{commandCenterShortcut ?? '按钮'}</kbd></button>
        <div className="sidebar-bottom">
           <div className="source-control"><button className="source-state" onClick={connected ? syncBlackboard : connectBlackboard}>
            <i className={connected ? '' : 'offline'} /><span><strong>Blackboard</strong><small>{connected ? '已连接，点击同步' : '未连接，点击登录'}</small></span><RefreshCw size={14} />
           </button><button className="source-logout" onClick={disconnectBlackboard}>退出</button></div>
          <div className="source-control"><button className="source-state" onClick={gradescopeConnected ? syncGradescope : connectGradescope}>
            <i className={gradescopeConnected ? '' : 'offline'} /><span><strong>Gradescope</strong><small>{gradescopeConnected ? '已连接，点击同步作业' : '未连接，点击登录'}</small></span><RefreshCw size={14} />
           </button><button className="source-logout" onClick={disconnectGradescope}>退出</button></div>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div className="topbar-title">{connected || gradescopeConnected ? `已连接：${[connected ? 'Blackboard' : '', gradescopeConnected ? 'Gradescope' : ''].filter(Boolean).join(' · ')}` : '等待连接 Blackboard 或 Gradescope'}</div><div className="top-actions"><button className="sync-button" disabled={busyKey === 'gradescope-sync'} onClick={gradescopeConnected ? syncGradescope : connectGradescope}><RefreshCw size={15} className={busyKey === 'gradescope-sync' ? 'spin' : ''} />{busyKey === 'gradescope-sync' ? '同步作业中…' : gradescopeConnected ? '同步 Gradescope' : '连接 Gradescope'}</button><button className="sync-button" disabled={busyKey === 'sync' || busyKey === 'scan'} onClick={syncBlackboard}><RefreshCw size={15} className={busyKey === 'sync' || busyKey === 'scan' ? 'spin' : ''} />{busyKey === 'sync' || busyKey === 'scan' ? '同步中…' : '同步 Blackboard'}</button><button className="primary-button" onClick={() => setShowImport(true)}><Upload size={15} />导入本地资料</button></div></header>
        <div className="content-scroll">
          {section === 'overview' && <section>
            <div className="page-heading"><div><span className="eyebrow">学习总览</span><h1>{study.courses.length ? '你的资料已经开始汇聚。' : '先把本学期的真实信息放进来。'}</h1><p>连接 Blackboard 后会自动读取课程与目录；也可以先手动导入电脑、微信或 QQ 中的资料。</p></div><button className="primary-button" onClick={connected ? syncBlackboard : connectBlackboard}>{connected ? <RefreshCw size={15} /> : <LogIn size={15} />}{connected ? '同步课程资料' : '连接 Blackboard'}</button></div>
            <div className="growth-stats"><div><span>课程</span><strong>{study.courses.length}</strong><small>来自同步或手动添加</small></div><div><span>已发现资料</span><strong>{study.materials.length}</strong><small>按 Blackboard 原目录收纳</small></div><div><span>本地缓存</span><strong>{cachedCount}</strong><small>{missingCount ? `${missingCount} 份文件缺失` : '已验证文件存在'}</small></div></div>
            <div className="panel deadline-overview"><div className="panel-title"><div><Send size={16} /><h2>近期 DDL</h2></div><div className="deadline-overview-actions"><span>{pendingAssignments.length} 个待处理</span><button className={deadlineRemindersEnabled ? 'reminders-on' : ''} onClick={() => setDeadlineRemindersEnabled((enabled) => !enabled)}>桌面提醒：{deadlineRemindersEnabled ? '开' : '关'}</button><button onClick={() => setSection('assignments')}>全部作业</button></div></div>{upcomingDeadlines.length ? <div className="deadline-overview-list">{upcomingDeadlines.map((assignment) => <article key={assignment.id}><span className={'deadline-dot ' + deadlineState(assignment, deadlineNow)} /><div><strong>{assignment.title}</strong><small>{courseNames.get(assignment.courseId) ?? assignment.sourceCourseName}</small></div><em className={deadlineState(assignment, deadlineNow)}>{deadlineLabel(assignment, deadlineNow)}</em><button onClick={() => openDeadlineEditor(assignment)}>设置</button></article>)}</div> : <p className="muted">暂未发现带有效截止时间的待处理作业。可在“作业中心”为 Blackboard 作业手动补充 DDL。</p>}</div>
            <div className="panel review-queue-panel">
              <div className="panel-title"><div><Database size={16} /><h2>今日复习队列</h2></div><div className="review-queue-actions"><span>显示 {reviewQueue.length}/{appPreferences.reviewQueueLimit} 项，可在设置中调整</span><button onClick={() => setSection('schedule')}>周日程</button><button onClick={() => setSection('review')}>打开期末复习</button></div></div>
              {reviewQueue.length ? <div className="review-queue-list">{reviewQueue.map((item, index) => {
                const progress = reviewQueueProgress(item, study.reviewSessions)
                const manualSchedule = study.reviewSchedule.find((entry) => entry.id === reviewTargetKey(item))
                return <article key={item.id}><b>{index + 1}</b><div><strong>{item.title}</strong><small>{item.courseName} · {item.reason}</small><span className={`review-queue-progress ${progress.stage}`}>{progress.label}</span></div><label className="review-queue-date"><span>安排日期</span><input type="date" value={manualSchedule?.scheduledDate ?? item.scheduledDate ?? ''} onChange={(event) => setReviewScheduleDate(item, event.target.value)} /></label><button onClick={() => openReviewQueueItem(item)}>{progress.stage === 'in_progress' ? '继续复习' : '打开复习'}</button></article>
              })}</div> : <div className="review-queue-empty"><span>当前没有到期的高优先级内容。</span><small>未来日程仍会保留；完成掌握确认或快速测试后，系统会计算下一次间隔复习日期。</small><button className="outline-button" onClick={() => setSection('review')}>去复习并建立记录</button></div>}
              {scheduledReviews.length ? <div className="review-schedule-list"><div><strong>可编辑复习日程</strong><span>{scheduledReviews.length} 项 · 手动日期会覆盖系统的间隔建议</span></div><div className="review-schedule-scroll">{scheduledReviews.map((entry) => <article key={entry.id}><div><strong>{entry.title}</strong><small>{entry.courseName} · {entry.source === 'manual' ? '手动安排' : '系统建议'} · {entry.scheduledDate < reviewToday ? '已到期' : entry.scheduledDate === reviewToday ? '今天' : '待开始'}</small></div><input type="date" value={entry.scheduledDate} onChange={(event) => setReviewScheduleDate(entry, event.target.value)} />{entry.source === 'manual' ? <button onClick={() => setReviewScheduleDate(entry, '')}>{suggestedNextReviewDate(entry, study.reviewSessions) ? '恢复系统' : '移除'}</button> : <button onClick={() => dismissReviewSuggestion(entry)}>忽略本次</button>}</article>)}</div></div> : null}
            </div>
            <div className="panel empty-action-panel"><Database size={26} /><div><h2>资料库：{vaultRoot}</h2><p>缓存和手动导入只复制文件到资料库，不会改动你电脑中已有的课程文件。</p></div><button className="outline-button" onClick={chooseVault}>选择位置</button></div>
          </section>}

          {section === 'inbox' && <section className="sync-inbox-page">
            <div className="page-heading"><div><span className="eyebrow">学习收件箱</span><h1>只看同步后真正发生的变化。</h1><p>Blackboard 与 Gradescope 的新增课程、资料、作业、DDL、提交状态和成绩变化会集中到这里；重复同步不会重复提醒。</p></div><div className="inbox-heading-actions"><button className="outline-button" disabled={!unreadInboxCount} onClick={() => updateInbox(study.syncInbox.filter((item) => !item.readAt && !item.archivedAt).map((item) => item.id), 'read')}><BookOpenCheck size={14} />全部已读</button><button className="primary-button" onClick={() => setShowEmailSettings(true)}><Mail size={14} />邮箱通知</button></div></div>
            <div className="sync-inbox-toolbar"><div><button className={inboxFilter === 'unread' ? 'selected' : ''} onClick={() => setInboxFilter('unread')}>未读 {unreadInboxCount}</button><button className={inboxFilter === 'all' ? 'selected' : ''} onClick={() => setInboxFilter('all')}>全部</button><button className={inboxFilter === 'archived' ? 'selected' : ''} onClick={() => setInboxFilter('archived')}>已归档</button></div><select value={inboxSourceFilter} onChange={(event) => setInboxSourceFilter(event.target.value as typeof inboxSourceFilter)}><option value="all">全部来源</option><option value="Blackboard">Blackboard</option><option value="Gradescope">Gradescope</option><option value="Email">邮件通知</option></select></div>
            {visibleInboxItems.length ? <div className="sync-inbox-list">{visibleInboxItems.map((item) => {
              const kindLabel = { sync_summary: '同步摘要', course_added: '新课程', material_added: '新资料', material_batch_added: '资料批次', assignment_added: '新作业', deadline_changed: 'DDL', assignment_status_changed: '状态', score_changed: '成绩', connection_required: '需登录', email_sent: '邮件', email_failed: '邮件失败' }[item.kind]
              return <article className={`${item.readAt ? 'read' : 'unread'} ${item.archivedAt ? 'archived' : ''}`} key={item.id}><span className={`sync-inbox-kind ${item.kind}`}>{kindLabel}</span><div><strong>{item.title}</strong><p>{item.detail}</p><small>{item.source} · {new Date(item.createdAt).toLocaleString('zh-CN', { hour12: false })}</small></div><div className="sync-inbox-actions">{!item.archivedAt ? <><button onClick={() => openInboxItem(item)}>打开</button><button onClick={() => updateInbox([item.id], item.readAt ? 'unread' : 'read')}>{item.readAt ? '标为未读' : '标为已读'}</button><button title="归档" onClick={() => updateInbox([item.id], 'archive')}><Archive size={14} /></button></> : <button onClick={() => updateInbox([item.id], 'unread')}>恢复到未读</button>}</div></article>
            })}</div> : <div className="empty-library"><Inbox size={31} /><strong>{inboxFilter === 'unread' ? '没有未读变化' : inboxFilter === 'archived' ? '还没有归档内容' : '学习收件箱还是空的'}</strong><span>同步 Blackboard 或 Gradescope 后，新发现的信息会出现在这里。</span><div><button className="outline-button" onClick={connected ? syncBlackboard : connectBlackboard}>同步 Blackboard</button><button className="outline-button inline-gap" onClick={gradescopeConnected ? syncGradescope : connectGradescope}>同步 Gradescope</button></div></div>}
          </section>}

          {section === 'library' && <section>
            <div className="page-heading action-heading"><div><span className="eyebrow">课程资料</span><h1>保持 Blackboard 的原始目录结构。</h1><p>这里仅收纳 Blackboard 与手动导入的课程资料；Gradescope 作业会在独立的“作业中心”按学期展示。自动缓存开启时，每次同步都会将新发现的 Blackboard 文件下载到本地资料库。</p></div><div className="library-actions"><button className={`outline-button ${autoCacheEnabled ? 'enabled-toggle' : ''}`} onClick={() => setAutoCacheEnabled((enabled) => !enabled)}><CloudDownload size={14} />自动缓存：{autoCacheEnabled ? '开' : '关'}</button><button className="outline-button" disabled={!selectedCourse || busyKey === 'cache-course'} onClick={cacheCurrentCourse}><CloudDownload size={14} />{busyKey === 'cache-course' ? '缓存中…' : '一键缓存本课程'}</button><button className="outline-button" onClick={syncBlackboard}><RefreshCw size={14} />同步</button><button className="primary-button" onClick={() => setShowImport(true)}><Plus size={15} />手动添加</button></div></div>
            <div className="vault-path" title={vaultRoot}>资料库：{vaultRoot}<button className="vault-repair" onClick={() => repairCachedExtensions()}>修复已缓存文件</button></div>
            {!study.courses.length ? <div className="empty-library"><BookOpen size={31} /><strong>还没有真实课程</strong><span>连接 Blackboard 同步，或手动导入一门课程的资料。</span><div><button className="primary-button" onClick={connectBlackboard}>连接 Blackboard</button><button className="outline-button inline-gap" onClick={() => setShowImport(true)}>导入本地资料</button></div></div> : <div className="library-explorer">
              <aside className="course-browser"><div className="browser-heading"><span>课程</span><small>{study.courses.length} 门</small></div>{study.courses.map((course) => <button className={selectedCourse?.id === course.id ? 'selected' : ''} onClick={() => setSelectedCourseId(course.id)} key={course.id}><i style={{ background: course.color }} /><span>{course.name}</span><small>{libraryMaterials.filter((material) => material.courseId === course.id).length}</small></button>)}</aside>
              <div className="tree-pane">{selectedCourse ? <><div className="tree-heading"><div><span className="eyebrow">课程资料</span><h2>{selectedCourse.name}</h2></div><span>{selectedMaterials.length} 个条目</span></div><div className="folder-tree">{selectedMaterials.length ? <MaterialTree node={selectedTree} course={selectedCourse} path={[]} expanded={expandedFolders} busyKey={busyKey} fileStates={fileStates} onToggle={toggleFolder} onCache={cacheMaterial} onOpenSubmission={openSubmission} onOpenLink={openLink} /> : <div className="empty-library compact"><Folder size={27} /><strong>该课程暂未发现资料</strong><span>可以再次同步 Blackboard，或手动导入这门课的文件。</span></div>}</div></> : null}</div>
            </div>}
          </section>}

          {section === 'assignments' && <section>
            <div className="assignment-manual-entry"><div><strong>其他平台或线下作业</strong><span>手动填写题目说明、DDL 与链接后，可直接使用现有分析流程。</span></div><button className="primary-button" onClick={openManualAssignment}><Plus size={15} />手动添加作业</button></div>
            <div className="page-heading"><div><span className="eyebrow">统一作业中心</span><h1>按学期和课程集中管理待办与提交入口。</h1><p>Gradescope 会同步提交状态和成绩；Blackboard 作业也会汇入此处。默认仅显示待处理作业，已完成内容可随时展开查看。</p></div><div className="assignment-actions"><select value={assignmentCourseFilter} onChange={(event) => chooseCourseFilter(event.target.value, setAssignmentCourseFilter)}><option value="all">全部课程</option>{assignmentCourses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><button className={`outline-button ${showCompletedAssignments ? 'enabled-toggle' : ''}`} onClick={() => setShowCompletedAssignments((current) => !current)}>{showCompletedAssignments ? '隐藏已完成' : '查看已完成'}</button><button className="outline-button" disabled={busyKey === 'gradescope-sync'} onClick={gradescopeConnected ? syncGradescope : connectGradescope}><RefreshCw size={14} className={busyKey === 'gradescope-sync' ? 'spin' : ''} />{busyKey === 'gradescope-sync' ? '同步中…' : gradescopeConnected ? '同步 Gradescope' : '连接 Gradescope'}</button><button className="outline-button" disabled={busyKey === 'sync' || busyKey === 'scan'} onClick={connected ? syncBlackboard : connectBlackboard}><RefreshCw size={14} className={busyKey === 'sync' || busyKey === 'scan' ? 'spin' : ''} />{connected ? '同步 Blackboard' : '连接 Blackboard'}</button></div></div>
            {!study.assignments.length ? <div className="empty-library"><Send size={31} /><strong>还没有同步到作业</strong><span>连接并同步 Gradescope 或 Blackboard 后，作业会自动汇总在这里。</span><button className="primary-button" onClick={gradescopeConnected ? syncGradescope : connectGradescope}>{gradescopeConnected ? '同步 Gradescope 作业' : '连接 Gradescope'}</button></div> : !visibleAssignments.length ? <div className="empty-library compact"><Send size={27} /><strong>当前筛选下没有待处理作业</strong><span>已提交、已批改和手动完成的作业默认隐藏。可点击“查看已完成”核对历史记录。</span></div> : <div className="assignment-term-list">{assignmentTerms.map(([term, assignments]) => {
              const byCourse = new Map<string, Assignment[]>()
              for (const assignment of assignments) {
                const key = assignment.sourceCourseName || courseNames.get(assignment.courseId) || '未匹配课程'
                const list = byCourse.get(key) ?? []
                list.push(assignment)
                byCourse.set(key, list)
              }
              return <section className="assignment-term" key={term}><div className="assignment-term-heading"><div><span className="eyebrow">{term === 'Blackboard' ? 'Blackboard 作业' : 'Gradescope 学期'}</span><h2>{term}</h2></div><span>{assignments.length} 个作业</span></div>{[...byCourse.entries()].map(([courseName, courseAssignments]) => <div className="assignment-course-group" key={courseName}><div className="assignment-course-heading"><strong>{courseName}</strong><span>{courseNames.get(courseAssignments[0].courseId) ?? ''}</span></div><div className="assignment-list">{courseAssignments.map((assignment) => <article key={assignment.id}><span className="assignment-icon"><Send size={15} /></span><div><strong>{assignment.title}</strong><span>{assignment.source} · {deadlineLabel(assignment, deadlineNow)}{assignment.dueLabel ? ` · ${assignment.dueLabel}` : ''}</span></div><em className={'assignment-status ' + effectiveAssignmentStatus(assignment)}>{assignmentStatusLabel(assignment)}</em><button className="assignment-analysis-button" onClick={() => openAssignmentAnalysis(assignment)}>分析复习</button><button className="assignment-manual-button" onClick={() => openDeadlineEditor(assignment)}>设置 DDL</button>{!['graded', 'submitted'].includes(effectiveAssignmentStatus(assignment)) ? <button className="assignment-manual-button" onClick={() => toggleAssignmentCompletion(assignment)}>{assignment.manualStatus === 'completed' ? '恢复待办' : '标为完成'}</button> : null}<button className="submission-button" onClick={() => openSubmission(assignment.url)}>前往提交</button></article>)}</div></div>)}</section>
            })}</div>}
          </section>}

          {section === "knowledge" && <section>
            <div className="page-heading action-heading"><div><span className="eyebrow">本地知识库</span><h1>本地构建资料索引，AI 自动选择合适的精炼方式。</h1><p>支持原件输入的 API 会直接分析课件；DeepSeek、Gemini 或仅支持对话的兼容接口会使用本地分页解析。教材与参考书只作本地阅读和搜索来源。</p></div><div className="knowledge-actions"><select className="knowledge-course-filter" value={activeKnowledgeCourseId ?? 'all'} onChange={(event) => chooseCourseFilter(event.target.value, setKnowledgeCourseFilter)}><option value="all">全部课程</option>{study.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><button className="outline-button" disabled={busyKey === "refine-job-start" || (!activeRefinementJob && (!aiConfig.configured || !activeKnowledgeCourseId))} onClick={openBatchCloudRefinement}>{busyKey === "refine-job-start" ? "创建任务中…" : activeRefinementJob ? "查看 AI 任务" : "批量 AI 精炼"}</button><button className="outline-button" disabled={busyKey === "ocr-batch" || !visibleKnowledgeDocuments.some((document) => document.status === "image")} onClick={runBatchOcr}>{busyKey === "ocr-batch" ? "批量 OCR 中…" : "批量 OCR"}</button><button className="primary-button" disabled={busyKey === "knowledge-build" || busyKey === 'version-switch'} onClick={buildKnowledgeBase}><Network size={15} />{busyKey === "knowledge-build" ? "构建中…" : "本地构建 / 更新"}</button><button className="outline-button" onClick={() => setShowAiSettings(true)}>AI 设置</button></div></div>
            <div className="growth-stats"><div><span>本地资料</span><strong>{knowledgeDocuments.length}</strong><small>已缓存或手动导入</small></div><div><span>已解析</span><strong>{knowledgeIndex?.stats.parsed ?? 0}</strong><small>{knowledgeIndex?.stats.unsupported ? (knowledgeIndex.stats.unsupported + " 份暂不支持") : "PDF、PPT/PPTX、DOCX、LaTeX 本地提取"}</small></div><div><span>课程知识点</span><strong>{knowledgeIndex?.stats.concepts ?? 0}</strong><small>{knowledgeIndex?.stats.reference ? (knowledgeIndex.stats.reference + " 份教材/参考资料未计入") : "仅由课件生成"}</small></div></div>
            {materialVersionCatalog.duplicates.some((group) => group.safeCleanupPaths.length) ? <div className="panel duplicate-file-notice"><div><strong>发现完全重复的历史孤立副本</strong><span>{materialVersionCatalog.duplicates.reduce((total, group) => total + group.safeCleanupPaths.length, 0)} 个文件内容与已保留资料完全相同，并且没有被课程资料或资料库清单引用。</span></div><button className="outline-button" disabled={busyKey === 'duplicate-cleanup'} onClick={cleanupDuplicateFiles}>{busyKey === 'duplicate-cleanup' ? '清理中…' : '检查并清理'}</button></div> : null}
            {knowledgeProgress && Boolean(['knowledge-build', 'ocr-batch', 'refine-batch', 'version-switch'].includes(busyKey ?? '') || busyKey?.startsWith('ocr:') || busyKey?.startsWith('refine:')) ? <div className="knowledge-progress"><span>{busyKey === 'refine-batch' || busyKey?.startsWith('refine:') ? `AI 精炼 ${knowledgeProgress.completed}/${knowledgeProgress.total}` : `正在处理 ${knowledgeProgress.completed}/${knowledgeProgress.total}`}</span><strong>{knowledgeProgress.title || "正在整理知识索引…"}</strong></div> : null}
            {visibleKnowledgeConcepts.length ? <div className="panel knowledge-graph-panel"><div className="panel-title"><div><h2>全景知识图谱</h2><p>资料级知识点、资料节点和课程知识点会在独立的可缩放地图中完整呈现，不再截断为少量条目。</p></div><button className="outline-button" onClick={() => { setMapCourseFilter(activeKnowledgeCourseId ?? 'all'); setSection('map') }}>打开知识图谱</button></div></div> : null}
            {!knowledgeDocuments.length ? <div className="empty-library"><Database size={31} /><strong>还没有可建立知识库的本地资料</strong><span>先在“课程资料”中缓存 Blackboard 文件或导入本地资料。</span><button className="primary-button" onClick={() => setSection("library")}>打开课程资料</button></div> : <div className="knowledge-layout"><div className="panel knowledge-panel"><div className="panel-title"><h2>资料级知识点</h2><span>{visibleKnowledgeDocuments.length} 份当前课程资料</span></div><div className="knowledge-document-filters"><button className={knowledgeDocumentFilter === 'ready' ? 'active' : ''} onClick={() => setKnowledgeDocumentFilter('ready')}>可用 {knowledgeDocumentCounts.ready}</button><button className={knowledgeDocumentFilter === 'ocr' ? 'active' : ''} onClick={() => setKnowledgeDocumentFilter('ocr')}>待 OCR {knowledgeDocumentCounts.ocr}</button><button className={knowledgeDocumentFilter === 'unsupported' ? 'active' : ''} onClick={() => setKnowledgeDocumentFilter('unsupported')}>暂不支持 {knowledgeDocumentCounts.unsupported}</button><button className={knowledgeDocumentFilter === 'failed' ? 'active' : ''} onClick={() => setKnowledgeDocumentFilter('failed')}>解析失败/无文本 {knowledgeDocumentCounts.failed}</button><button className={knowledgeDocumentFilter === 'all' ? 'active' : ''} onClick={() => setKnowledgeDocumentFilter('all')}>全部</button></div>{displayedKnowledgeDocuments.length ? <KnowledgeDocumentList documents={displayedKnowledgeDocuments} expanded={expandedKnowledgeDocuments} onToggle={toggleKnowledgeDocument} onRoleChange={changeKnowledgeRole} onOcr={runKnowledgeOcr} onRefine={openDocumentCloudRefinement} onEditLocation={openPageLocationEditor} versionGroups={versionGroupsByMaterialId} onVersionChange={switchMaterialVersion} aiConfigured={aiConfig.configured} busyKey={busyKey} /> : <p className="muted">当前分类没有资料。可切换上方筛选查看待 OCR、暂不支持或解析失败的文件。</p>}</div><div className="panel knowledge-panel concept-evidence-panel"><div className="panel-title"><div><h2>课程知识点</h2><p>自评与测试证据并列显示，测试不会覆盖你的主动判断。</p></div><span>{visibleKnowledgeConcepts.length} 个</span></div>{visibleKnowledgeConcepts.length ? <div className="knowledge-concept-list">{visibleKnowledgeConcepts.map((concept) => { const evidence = conceptEvidence[concept.id]; const courseId = activeKnowledgeCourseId ?? concept.courseIds[0]; return <article className={`concept-evidence-row ${evidence?.status ?? 'unassessed'}`} key={concept.id}><div><strong>{concept.title}</strong><span>{concept.aliases?.length ? `合并别名：${concept.aliases.join('、')} · ` : ''}{concept.sourceIds.length} 份课件来源 · {concept.locations?.length ? `${concept.locations.length} 处页级定位` : '尚未定位具体页'} · 最近复习 {evidence?.lastReviewedAt ? new Date(evidence.lastReviewedAt).toLocaleDateString() : '暂无记录'}</span></div><span className={`concept-evidence-status ${evidence?.status ?? 'unassessed'}`}>{conceptEvidenceLabels[evidence?.status ?? 'unassessed']}</span><div className="concept-evidence-values"><small>自评：{['未评估', '陌生', '模糊', '理解', '掌握'][evidence?.selfRating ?? 0]}</small><small>测试：{evidence?.latestTestScore === null || evidence?.latestTestScore === undefined ? '未覆盖' : `${evidence.latestTestScore}% · ${evidence.latestTestQuestions} 题`}</small></div>{courseId ? <button onClick={() => openConceptReview(concept.id, courseId)}>{concept.locations?.length ? '从定位页复习' : evidence && conceptNeedsReview(evidence) ? '复习薄弱点' : '加入复习'}</button> : null}</article> })}</div> : <p className="muted">课程知识点由课件的资料级知识点汇总而来。教材不会自动扩大这个列表。</p>}</div></div>}
          </section>}

          {section === 'map' && <section><div className="page-heading"><div><span className="eyebrow">知识图谱</span><h1>在一张可自由移动的学习地图中浏览知识。</h1><p>课程概览默认不堆叠全部关系线；知识点颜色显示自评与测试证据，描边表示已经被快速测试覆盖。</p></div></div>{knowledgeIndex?.documents.length ? <KnowledgeMap documents={knowledgeIndex.documents} concepts={knowledgeIndex.concepts} ratings={study.knowledgeRatings} evidence={conceptEvidence} courseFilter={mapCourseFilter} onCourseFilterChange={(value) => chooseCourseFilter(value, setMapCourseFilter)} onOpenDocument={openMapDocumentInReview} onReviewConcept={openConceptReview} /> : <div className="panel empty-action-panel"><Network size={26} /><div><h2>还没有可绘制的知识图谱</h2><p>先在知识库中构建或更新课程资料。只有已解析或已 OCR 的资料会进入图谱。</p></div><button className="primary-button" onClick={() => setSection('knowledge')}>打开知识库</button></div>}</section>}

          {section === 'review' && <section><div className="page-heading"><div><span className="eyebrow">期末复习</span><h1>先选你真正要复习的内容，再进入专注会话。</h1><p>你可以手动勾选资料或知识点；若不选，系统会按自评、资料来源和期末日期生成建议路线。会话内提供资料阅读、AI 问答与番茄钟。</p></div><div className="review-controls"><select value={activeReviewCourseId ?? ''} onChange={(event) => chooseCourseFilter(event.target.value, setReviewCourseFilter)}>{!activeReviewCourseId ? <option value="">请选择课程</option> : null}{study.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><label>期末日期<input type="date" value={reviewExamDate} onChange={(event) => setReviewExamDate(event.target.value)} /></label></div></div>{!activeReviewCourseId || !reviewWorkspaceDocuments.length ? <div className="panel empty-action-panel"><Network size={26} /><div><h2>{knowledgeIndex?.stats.parsed ? '当前课程还没有已解析资料' : '先构建本地知识库'}</h2><p>请先选择一门课程，并在知识库中构建解析结果。DOCX、旧版 PPT 与 LaTeX 也会在重新构建后纳入。</p></div><button className="primary-button" onClick={() => setSection('knowledge')}>打开知识库</button></div> : <><div className="growth-stats review-stats"><div><span>已自评</span><strong>{reviewRatedCount}/{reviewConcepts.length}</strong><small>用于系统规划，不会覆盖成绩</small></div><div><span>当前掌握度</span><strong>{reviewMastery}%</strong><small>来自你对知识点的真实判断</small></div><div><span>系统建议</span><strong>{reviewWeakCount}</strong><small>{reviewDailyTarget ? `距期末 ${reviewDaysLeft} 天，建议每天 ${reviewDailyTarget} 个` : '设置期末日期后拆分每日目标'}</small></div></div><ReviewWorkspace courseName={study.courses.find((course) => course.id === activeReviewCourseId)?.name ?? '当前课程'} documents={reviewWorkspaceDocuments} concepts={reviewConcepts} ratings={study.knowledgeRatings} selection={reviewSelection} session={reviewSession} onSelectionChange={saveReviewSelection} onSessionChange={saveReviewSession} onRate={setConceptRating} aiConfigured={aiConfig.configured} onOpenAiSettings={() => setShowAiSettings(true)} focusMinutes={appPreferences.focusMinutes} breakMinutes={appPreferences.breakMinutes} /></>}</section>}

          {section === 'schedule' && <section className="review-calendar-page">
            <div className="page-heading"><div><span className="eyebrow">复习日程</span><h1>把间隔建议整理成真正可执行的一周。</h1><p>拖动任务即可改期；多选后可以顺延、移到周末或平均分散。掌握确认和快速测试作为历史证据保留，不会被拖动。</p></div><div className="calendar-navigation"><button onClick={() => changeCalendarAnchor(shiftDate(calendarWeek[0], -7))}>上一周</button><button onClick={() => changeCalendarAnchor(reviewToday)}>今天</button><button onClick={() => changeCalendarAnchor(shiftDate(calendarWeek[0], 7))}>下一周</button></div></div>
            <div className="calendar-week-head"><div><CalendarDays size={18} /><span><strong>{calendarWeekLabel}</strong><small>{scheduledReviews.filter((entry) => calendarWeek.includes(entry.scheduledDate)).length} 项计划 · {calendarHistory.filter((entry) => calendarWeek.includes(entry.date)).length} 条历史证据</small></span></div><em>每日建议上限 {appPreferences.reviewQueueLimit} 项</em></div>
            {reviewInactiveDayCount !== null && reviewInactiveDayCount >= 14 && overdueSystemSuggestions.length ? <div className="calendar-stale-banner"><div><strong>这些计划可能已经过时</strong><span>学径已经 {reviewInactiveDayCount} 天没有记录到新的复习、掌握确认或快速测试，但你可能一直在线下正常学习。应用不会擅自把它们标为未掌握。</span></div><button onClick={redistributeOverdueSuggestions}>重新平均安排 {overdueSystemSuggestions.length} 项</button><button onClick={dismissOverdueSuggestions}>忽略当前旧建议</button></div> : null}
            {calendarSelection.length ? <div className="calendar-batch-toolbar"><strong>已选择 {calendarSelection.length} 项</strong><button onClick={() => shiftSelectedCalendarItems(1)}>顺延一天</button><button onClick={moveSelectedToWeekend}>移到周六</button><button onClick={distributeSelectedCalendarItems}>平均分散到本周</button><label><input type="date" value={calendarBatchDate} onChange={(event) => setCalendarBatchDate(event.target.value)} /><button disabled={!calendarBatchDate} onClick={moveSelectedToDate}>统一改期</button></label><button className="calendar-clear" onClick={() => setCalendarSelection([])}>取消选择</button></div> : null}
            <div className="review-calendar-grid">{calendarWeek.map((date, dayIndex) => {
              const planned = scheduledReviews.filter((entry) => entry.scheduledDate === date)
              const history = calendarHistory.filter((entry) => entry.date === date)
              const overloaded = planned.length > appPreferences.reviewQueueLimit
              const dateValue = new Date(`${date}T12:00:00`)
              const historyExpanded = expandedCalendarHistory.includes(date)
              return <div className={`calendar-day ${date === reviewToday ? 'today' : ''} ${overloaded ? 'overloaded' : ''}`} key={date} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const id = event.dataTransfer.getData('text/x-xuejing-review'); if (id) updateCalendarDates({ [id]: date }) }}><div className="calendar-day-head"><span>{['周一', '周二', '周三', '周四', '周五', '周六', '周日'][dayIndex]}</span><strong>{dateValue.getMonth() + 1}/{dateValue.getDate()}</strong><small>{planned.length} 项待办{overloaded ? ' · 负载偏高' : ''}</small></div><div className="calendar-day-items">{planned.length ? <div className="calendar-task-section"><span>待完成任务</span>{planned.map((entry) => { const progress = calendarTaskStatus(entry, study.reviewSessions, reviewToday); return <article className={`calendar-task ${entry.source} ${progress.stage}`} draggable key={entry.id} onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/x-xuejing-review', entry.id) }}><span className="calendar-drag" title="拖动改期">⋮⋮</span><label><input type="checkbox" checked={calendarSelection.includes(entry.id)} onChange={() => toggleCalendarSelection(entry.id)} /></label><button className="calendar-task-main" onClick={() => openCalendarItem(entry)}><strong>{entry.title}</strong><span>{entry.courseName}</span><small>{entry.source === 'manual' ? '手动安排' : '系统间隔建议'} · {progress.label}</small></button><div className="calendar-task-actions"><input aria-label={`${entry.title}改期`} type="date" value={entry.scheduledDate} onChange={(event) => updateCalendarDates({ [entry.id]: event.target.value })} /><button title={entry.source === 'interval' ? '忽略本次系统建议' : '删除手动安排'} onClick={() => entry.source === 'interval' ? dismissReviewSuggestion(entry) : setReviewScheduleDate(entry, '')}>{entry.source === 'interval' ? '忽略' : suggestedNextReviewDate(entry, study.reviewSessions) ? '恢复系统' : '删除'}</button></div></article> })}</div> : null}{history.length ? <div className={`calendar-history-group ${historyExpanded ? 'expanded' : ''}`}><button className="calendar-history-toggle" onClick={() => toggleCalendarHistory(date)}><span><strong>已完成记录</strong><small>{history.length} 条复习或测试证据</small></span>{historyExpanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>{historyExpanded ? <div className="calendar-history-list">{history.map((entry) => <article className={`calendar-history ${entry.kind}`} key={entry.id}><span>{entry.kind === 'tested' ? '测试记录' : '复习记录'}</span><button onClick={() => openCalendarItem(entry)}><strong>{entry.title}</strong><small>{entry.courseName} · {entry.label}</small></button></article>)}</div> : null}</div> : null}{!planned.length && !history.length ? <div className="calendar-day-empty">暂无待办或历史记录</div> : null}</div></div>
            })}</div>
            <div className="calendar-notes"><span><i className="manual" />手动安排</span><span><i className="interval" />系统间隔建议</span><span><i className="history" />已完成记录（默认折叠）</span><p>历史记录不属于待办任务；系统建议被改期后会转为手动安排。</p></div>
          </section>}

          {section === 'focus' && <section><div className="page-heading"><div><span className="eyebrow">专注计时</span><h1>给当前学习留出一段不被打断的时间。</h1><p>期末复习会话内也有同一套番茄钟；这里提供独立入口，适合整理资料、阅读或完成作业时使用。</p></div></div><div className="focus-panel"><span className="eyebrow">{focusPhase === 'focus' ? '专注阶段' : '休息阶段'} · {appPreferences.focusMinutes} 分钟专注 / {appPreferences.breakMinutes} 分钟休息</span><strong>{String(Math.floor(focusSeconds / 60)).padStart(2, '0')}:{String(focusSeconds % 60).padStart(2, '0')}</strong><div><button className="primary-button" onClick={() => setFocusRunning((value) => !value)}>{focusRunning ? '暂停' : focusPhase === 'focus' ? '开始专注' : '开始休息'}</button><button className="outline-button" onClick={() => { setFocusRunning(false); setFocusSeconds((focusPhase === 'focus' ? appPreferences.focusMinutes : appPreferences.breakMinutes) * 60) }}>重置</button><button className="outline-button" onClick={() => setSection('review')}>进入期末复习</button></div></div></section>}

          {section === 'growth' && <section className="growth-page">
            <div className="page-heading"><div><span className="eyebrow">成长面板 2.0</span><h1>用学习证据，看见自己真正完成了什么。</h1><p>接触、理解确认和测试验证分开统计；每日状态从启用后开始留存，没有记录的日期不会补造数据。</p></div><div className="growth-controls"><select value={growthCourseFilter} onChange={(event) => chooseCourseFilter(event.target.value, setGrowthCourseFilter)}><option value="all">全部课程趋势</option>{growthCourseMetrics.map((course) => <option key={course.courseId} value={course.courseId}>{course.courseName}</option>)}</select><div className="growth-range"><button className={growthRange === 7 ? 'active' : ''} onClick={() => setGrowthRange(7)}>最近 7 天</button><button className={growthRange === 30 ? 'active' : ''} onClick={() => setGrowthRange(30)}>最近 30 天</button></div></div></div>
            <div className="growth-stats growth-evidence-stats">
              <div><span>有记录的学习日</span><strong>{growthActiveDays}</strong><small>仅统计当前时间范围内真实留下的操作</small></div>
              <div><span>已完成快速测试</span><strong>{completedQuickTests.length}</strong><small>{quickTestAverage === null ? '完成第一次测试后显示正确率' : `平均正确率 ${quickTestAverage}%`}</small></div>
              <div><span>测试验证知识点</span><strong>{growthVerifiedConceptCount}</strong><small>最近相关测试达到 80% 以上</small></div>
              <div><span>证据矛盾</span><strong>{growthConflictConceptCount}</strong><small>自评与最近测试结果明显不一致</small></div>
            </div>

            <div className="growth-journey">
              <article><div><span>01 · 接触</span><strong>{growthContactedCount}/{growthTotalMaterialCount}</strong></div><p>进入过复习会话，或已经留下掌握与测试证据。</p><i><b style={{ width: `${growthTotalMaterialCount ? Math.round(growthContactedCount / growthTotalMaterialCount * 100) : 0}%` }} /></i></article>
              <article><div><span>02 · 理解</span><strong>{growthUnderstoodCount}/{growthConfirmedCount}</strong></div><p>{growthConfirmedCount ? `${growthConfirmedCount} 份已确认，其中 ${growthUnderstoodCount} 份达到基本理解或可以解释。` : '完成资料后的 10 秒确认会进入这里。'}</p><i><b style={{ width: `${growthConfirmedCount ? Math.round(growthUnderstoodCount / growthConfirmedCount * 100) : 0}%` }} /></i></article>
              <article><div><span>03 · 验证</span><strong>{growthVerifiedCount}</strong></div><p>至少被一次已完成快速测试覆盖的资料，不等同于永久掌握。</p><i><b style={{ width: `${growthContactedCount ? Math.round(growthVerifiedCount / growthContactedCount * 100) : 0}%` }} /></i></article>
            </div>

            <div className="panel growth-trend-panel">
              <div className="panel-title"><div><h2>学习证据趋势</h2><span>接触 · 掌握确认 · 快速测试</span></div></div>
              <div className={`growth-trend-chart range-${growthRange}`}>{growthActivity.map((day, index) => <div key={day.date} title={`${day.date}：接触 ${day.contacts}，确认 ${day.confirmations}，测试 ${day.tests}`}><div className="growth-trend-plot"><div className="growth-trend-bar" style={{ height: `${day.total ? Math.max(9, Math.round(day.total / growthActivityMax * 100)) : 2}%` }}>{day.total ? <><i className="contact" style={{ flex: day.contacts }} /><i className="confirm" style={{ flex: day.confirmations }} /><i className="test" style={{ flex: day.tests }} /></> : null}</div></div><span>{growthRange === 7 || index % 5 === 0 || index === growthActivity.length - 1 ? day.label : ''}</span></div>)}</div>
              <div className="growth-trend-legend"><span><i className="contact" />进入复习</span><span><i className="confirm" />掌握确认</span><span><i className="test" />快速测试</span></div>
            </div>

            <div className="panel growth-snapshot-panel">
              <div className="panel-title"><div><h2>掌握状态每日快照</h2><span>{growthSnapshotCourseName} · 只显示学径实际保存过的状态</span></div><small>{recordedGrowthSnapshots.length ? `已有 ${recordedGrowthSnapshots.length} 天记录` : '今天将建立第一份快照'}</small></div>
              {latestGrowthSnapshot ? <>
                <div className="growth-snapshot-summary"><article><span>薄弱资料</span><strong>{latestGrowthSnapshot.weakMaterials}</strong><small>{growthSnapshotDelta('weakMaterials') === null ? '等待下一天形成趋势' : `较上次 ${growthSnapshotDelta('weakMaterials')! > 0 ? '+' : ''}${growthSnapshotDelta('weakMaterials')}`}</small></article><article><span>待巩固知识点</span><strong>{latestGrowthSnapshot.weakConcepts}</strong><small>{growthSnapshotDelta('weakConcepts') === null ? '来自自评与测试证据' : `较上次 ${growthSnapshotDelta('weakConcepts')! > 0 ? '+' : ''}${growthSnapshotDelta('weakConcepts')}`}</small></article><article><span>测试验证较好</span><strong>{latestGrowthSnapshot.verifiedConcepts}</strong><small>{growthSnapshotDelta('verifiedConcepts') === null ? '最近测试达到 80% 以上' : `较上次 ${growthSnapshotDelta('verifiedConcepts')! > 0 ? '+' : ''}${growthSnapshotDelta('verifiedConcepts')}`}</small></article><article><span>证据矛盾</span><strong>{latestGrowthSnapshot.conflicts}</strong><small>{growthSnapshotDelta('conflicts') === null ? '自评和测试明显不一致' : `较上次 ${growthSnapshotDelta('conflicts')! > 0 ? '+' : ''}${growthSnapshotDelta('conflicts')}`}</small></article></div>
                <div className={`growth-snapshot-chart range-${growthRange}`}>{growthSnapshotSeries.map((point, index) => <div className={point.recorded ? 'recorded' : 'missing'} key={point.date} title={point.recorded ? `${point.date}：薄弱资料 ${point.weakMaterials}，待巩固知识点 ${point.weakConcepts}，验证较好 ${point.verifiedConcepts}，矛盾 ${point.conflicts}` : `${point.date}：尚未记录快照`}><div className="growth-snapshot-bars">{point.recorded ? <><i className="weak-material" style={{ height: `${point.weakMaterials ? Math.max(4, point.weakMaterials / growthSnapshotMax * 100) : 0}%` }} /><i className="weak-concept" style={{ height: `${point.weakConcepts ? Math.max(4, point.weakConcepts / growthSnapshotMax * 100) : 0}%` }} /><i className="verified" style={{ height: `${point.verifiedConcepts ? Math.max(4, point.verifiedConcepts / growthSnapshotMax * 100) : 0}%` }} /></> : <i className="no-record" />}</div>{point.recorded && point.conflicts > 0 ? <b>{point.conflicts}</b> : null}<span>{growthRange === 7 || index % 5 === 0 || index === growthSnapshotSeries.length - 1 ? point.label : ''}</span></div>)}</div>
                <div className="growth-snapshot-legend"><span><i className="weak-material" />薄弱资料</span><span><i className="weak-concept" />待巩固知识点</span><span><i className="verified" />测试验证较好</span><span><i className="conflict" />证据矛盾</span><small>虚线表示当天尚未保存快照，不代表数值为 0。</small></div>
              </> : <div className="growth-snapshot-empty"><strong>还没有可记录的课程状态</strong><span>完成知识库构建后，学径会从当天开始保存每日快照，不会反推过去的数据。</span></div>}
            </div>

            <div className="growth-course-section">
              <div className="growth-section-head"><div><h2>按课程查看证据</h2><p>每门课程分别显示资料接触、理解确认、测试覆盖和知识点验证。</p></div><span>{growthCourseMetrics.length} 门有可解析资料的课程</span></div>
              {growthCourseMetrics.length ? <>
                <div className="growth-course-grid">{visibleGrowthCourseMetrics.map((course) => {
                  const hasWeakEvidence = course.weakMaterialIds.length || course.weakConceptIds.length
                  return <article className="panel growth-course-card" key={course.courseId}><div className="growth-course-head"><div><strong>{course.courseName}</strong><span>{course.totalMaterials} 份资料 · {course.ratedConcepts} 个已自评 · {course.testedConcepts} 个已测试</span></div><b>{course.averageTestScore === null ? '未测试' : `${course.averageTestScore}%`}</b></div><div className="growth-course-bars"><label><span>接触资料</span><strong>{course.contactedMaterials}/{course.totalMaterials}</strong><i><b style={{ width: `${course.totalMaterials ? course.contactedMaterials / course.totalMaterials * 100 : 0}%` }} /></i></label><label><span>完成确认</span><strong>{course.confirmedMaterials}/{course.totalMaterials}</strong><i><b style={{ width: `${course.totalMaterials ? course.confirmedMaterials / course.totalMaterials * 100 : 0}%` }} /></i></label><label><span>测试覆盖</span><strong>{course.verifiedMaterials}/{course.totalMaterials}</strong><i><b style={{ width: `${course.totalMaterials ? course.verifiedMaterials / course.totalMaterials * 100 : 0}%` }} /></i></label></div><div className="growth-concept-evidence"><span><strong>{course.verifiedConcepts}</strong> 验证较好</span><span><strong>{course.testWeakConcepts}</strong> 测试薄弱</span><span><strong>{course.evidenceConflicts}</strong> 证据矛盾</span></div><div className="growth-course-footer"><span>{hasWeakEvidence ? `${course.weakMaterialIds.length} 份薄弱资料 · ${course.weakConceptIds.length} 个待巩固知识点` : '当前没有明确的薄弱资料或知识点证据'}</span><button onClick={() => hasWeakEvidence ? openGrowthEvidenceReview(course.courseId, course.weakMaterialIds, course.weakConceptIds) : openGrowthReview(course.courseId)}>{hasWeakEvidence ? '复习薄弱内容' : '打开课程复习'}</button></div></article>
                })}</div>
                {growthCourseMetrics.length > 4 ? <button className="growth-course-expand" onClick={() => setShowAllGrowthCourses((current) => !current)}>{showAllGrowthCourses ? '收起课程' : `展开全部 ${growthCourseMetrics.length} 门课程`}<ChevronDown size={14} className={showAllGrowthCourses ? 'expanded' : ''} /></button> : null}
              </> : <div className="panel growth-empty"><Database size={25} /><div><strong>还没有可以统计的课程证据</strong><span>先构建知识库，并在期末复习中打开资料、完成掌握确认或快速测试。</span></div><button className="outline-button" onClick={() => setSection('knowledge')}>打开知识库</button></div>}
            </div>

            <div className="panel achievement-gallery">
              <div className="achievement-gallery-head"><div><span className="eyebrow">成长图鉴</span><h2>每一步都有证据，不靠空泛打卡。</h2><p>共 {ACHIEVEMENTS.length} 项：60 项可收集成长与 12 项高价值里程碑。已解锁 {earnedAchievementCount} 项。</p></div><img className="achievement-journey-art" src={growthJourneyImage} alt="从资料、知识网络走向成长的学习路径" /><div className="achievement-total"><Trophy size={25} /><strong>{earnedAchievementCount}/{ACHIEVEMENTS.length}</strong><span>{Math.round(earnedAchievementCount / ACHIEVEMENTS.length * 100)}%</span></div></div>
              {achievementBackfillNotice ? <div className="achievement-backfill"><Star size={17} /><div><strong>已有成长回顾</strong><span>根据现有复习、测试、作业和日记记录补发了 {achievementBackfillNotice} 项成就；历史结果不会逐条弹窗。</span></div><button onClick={() => setAchievementBackfillNotice(0)}>知道了</button></div> : null}
              <div className="achievement-filters"><div><button className={achievementView === 'all' ? 'active' : ''} onClick={() => setAchievementView('all')}>全部</button><button className={achievementView === 'earned' ? 'active' : ''} onClick={() => setAchievementView('earned')}>已获得</button><button className={achievementView === 'progress' ? 'active' : ''} onClick={() => setAchievementView('progress')}>进行中</button></div><select value={achievementCategory} onChange={(event) => setAchievementCategory(event.target.value as typeof achievementCategory)}><option value="all">全部分类</option>{(['起步', '资料', '复习', '测试', '专注', '作业', '记录', '成长'] as const).map((category) => <option key={category} value={category}>{category}</option>)}</select></div>
              <div className="achievement-grid">{visibleAchievementItems.map((item) => <article className={`${item.definition.tier} ${item.awarded ? 'earned' : 'locked'}`} key={item.definition.id} title={item.awarded?.evidenceSummary ?? `${item.current}/${item.target}`}><div className="achievement-icon">{item.definition.tier === 'milestone' ? <Trophy size={20} /> : item.definition.tier === 'rare' ? <Star size={20} /> : <Award size={20} />}</div><div className="achievement-card-body"><span>{item.definition.category} · {item.definition.tier === 'milestone' ? '里程碑' : item.definition.tier === 'rare' ? '稀有' : '普通'}</span><strong>{item.definition.title}</strong><p>{item.definition.description}</p><i><b style={{ width: `${item.percent}%` }} /></i><small>{item.awarded ? `${item.awarded.backfilled ? '历史补发' : '获得于'} ${new Date(item.awarded.awardedAt).toLocaleDateString()}` : `${item.current}/${item.target}`}</small></div></article>)}</div>
              {achievementItems.filter((item) => (achievementCategory === 'all' || item.definition.category === achievementCategory) && (achievementView === 'all' || (achievementView === 'earned' ? item.awarded : !item.awarded))).length > 12 ? <button className="growth-course-expand" onClick={() => setShowAllAchievements((current) => !current)}>{showAllAchievements ? '收起图鉴' : '展开全部成就'}<ChevronDown size={14} className={showAllAchievements ? 'expanded' : ''} /></button> : null}
              <div className="milestone-timeline"><div className="panel-title"><div><Trophy size={17} /><h3>高价值里程碑</h3></div><span>长期积累，不因中断清零</span></div><div>{achievementItems.filter((item) => item.definition.tier === 'milestone').map((item) => <article className={item.awarded ? 'earned' : ''} key={item.definition.id}><i>{item.awarded ? '★' : '○'}</i><span><strong>{item.definition.title}</strong><small>{item.awarded ? item.awarded.evidenceSummary : `${item.current}/${item.target}`}</small></span></article>)}</div></div>
            </div>

            <div className="learning-calendar-layout">
              <section className="panel learning-calendar-panel">
                <div className="learning-calendar-head"><div><span className="eyebrow">月度学习日历</span><h2>{new Date(`${learningMonth}T12:00:00`).toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })}</h2></div><div><button onClick={() => setLearningMonth((current) => shiftMonth(current, -1))}><ChevronLeft size={16} /></button><button onClick={() => { const today = localDateKey(new Date()); setLearningMonth(today.slice(0, 7) + '-01'); setLearningDay(today); setJournalDate(today) }}>今天</button><button onClick={() => setLearningMonth((current) => shiftMonth(current, 1))}><ChevronRight size={16} /></button></div></div>
                <div className="learning-calendar-filters"><select value={learningCalendarCourse} onChange={(event) => setLearningCalendarCourse(event.target.value)}><option value="all">全部课程</option>{study.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><select value={learningCalendarKind} onChange={(event) => setLearningCalendarKind(event.target.value as LearningCalendarKind | 'all')}><option value="all">全部记录</option><option value="review">复习</option><option value="test">测试</option><option value="assignment">作业</option><option value="focus">专注</option><option value="journal">日记</option><option value="achievement">成就</option></select></div>
                <div className="learning-calendar-weekdays">{['一', '二', '三', '四', '五', '六', '日'].map((day) => <span key={day}>周{day}</span>)}</div>
                <div className="learning-calendar-grid">{learningMonthGrid.map((day) => <button key={day.date} className={`${day.inMonth ? '' : 'outside'} ${day.today ? 'today' : ''} ${learningDay === day.date ? 'selected' : ''}`} onClick={() => { setLearningDay(day.date); setJournalDate(day.date); setEditingJournalId(null); setJournalText('') }}><b>{day.day}</b>{day.hasHighlight ? <Star className="calendar-star" size={11} /> : null}<span className="calendar-dots">{day.counts.review ? <i className="review" /> : null}{day.counts.test ? <i className="test" /> : null}{day.counts.assignment ? <i className="assignment" /> : null}{day.counts.focus ? <i className="focus" /> : null}{day.counts.journal ? <i className="journal" /> : null}</span>{day.items.length ? <small>{day.items.length} 条</small> : null}</button>)}</div>
                <div className="learning-calendar-legend"><span><i className="review" />复习</span><span><i className="test" />测试</span><span><i className="assignment" />作业</span><span><i className="focus" />专注</span><span><i className="journal" />日记</span><span><Star size={11} />稀有/里程碑</span></div>
              </section>
              <aside className="panel learning-day-detail"><span className="eyebrow">{learningDay}</span><h2>这一天的学习证据</h2>{selectedLearningItems.length ? <div className="learning-day-events">{selectedLearningItems.map((item) => <article className={item.kind} key={item.id}><i /><div><strong>{item.title}</strong><span>{item.detail || ({ review: '复习记录', test: '快速测试', assignment: '作业记录', focus: '专注记录', journal: '学习日记', achievement: '成长成就' }[item.kind])}</span></div><small>{item.occurredAt.includes('T') ? new Date(item.occurredAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''}</small></article>)}</div> : <p className="muted">这一天还没有留下应用内学习证据；可以在下方补写真实学习记录。</p>}{selectedJournalEntries.length ? <div className="learning-day-journals">{selectedJournalEntries.map((entry) => <article key={entry.id}><div><strong>{entry.mood}</strong><p>{entry.content}</p></div><span><button onClick={() => editJournal(entry)}>编辑</button><button onClick={() => deleteJournal(entry)}>删除</button></span></article>)}</div> : null}</aside>
            </div>

            <div className="growth-layout growth-journal-layout">
              <div className="journal-composer"><span className="eyebrow">{editingJournalId ? '编辑学习记录' : '补写 / 新建学习记录'}</span><h2>{journalDate} 真正学到了什么？</h2><label className="journal-date-picker">记录日期<input type="date" value={journalDate} onChange={(event) => { setJournalDate(event.target.value); setLearningDay(event.target.value) }} /></label><textarea value={journalText} onChange={(event) => setJournalText(event.target.value)} placeholder="例如：重新看了卷积课件，测试后发现边界条件仍然模糊……" /><div className="composer-footer"><div className="mood-picker">{(['轻松', '平稳', '吃力'] as JournalEntry['mood'][]).map((mood) => <button key={mood} className={journalMood === mood ? 'chosen' : ''} onClick={() => setJournalMood(mood)}>{mood}</button>)}</div><div className="journal-actions">{editingJournalId ? <button className="outline-button" onClick={cancelJournalEdit}>取消编辑</button> : null}<button className="primary-button" onClick={saveJournal}>{editingJournalId ? '保存修改' : '保存记录'}</button></div></div></div>
              <div className="panel trend-panel"><div className="panel-title"><h2>证据说明</h2></div><p className="muted">成长面板不会把“打开过文件”当成掌握，也不会用快速测试覆盖你的知识点自评。三类证据并列展示，方便你判断下一步该继续阅读、重新确认还是再次测试。</p></div>
            </div>
            <div className="journal-list"><h2>最近的每日记录</h2>{study.journal.length ? study.journal.slice().sort((left, right) => right.date.localeCompare(left.date)).slice(0, 12).map((entry) => <article key={entry.id}><div className="journal-date"><strong>{entry.date}</strong><span>{entry.mood}</span></div><p>{entry.content}</p><div className="journal-list-actions"><button onClick={() => editJournal(entry)}>编辑</button><button onClick={() => deleteJournal(entry)}>删除</button></div></article>) : <p className="muted">还没有记录。写下第一条真实学习体验吧。</p>}</div>
          </section>}

          {section === 'settings' && <section className="settings-page">
            <div className="page-heading"><div><span className="eyebrow">设置中心</span><h1>把低频配置收在一个地方。</h1><p>外观、后台行为、提醒、账号、AI 和资料库设置都集中在这里，主界面只保留高频学习操作。</p></div></div>
            <div className="settings-grid">
              <div className="panel settings-card settings-appearance"><div className="settings-card-head"><Palette size={18} /><div><h2>外观主题</h2><p>主题立即生效，并在下次启动时保留。</p></div></div><div className="theme-options">{([
                ['light', '学术浅色', '温暖、清晰，适合白天阅读'], ['dark', '专注深色', '降低夜间长时间学习的亮度'], ['glass', '现代毛玻璃', '半透明层次与柔和渐变'], ['system', '跟随系统', '自动匹配 Windows 深浅色'],
              ] as [ThemePreference, string, string][]).map(([value, label, description]) => <button key={value} className={appPreferences.theme === value ? 'selected' : ''} onClick={() => updateAppPreference('theme', value)}><i className={`theme-swatch ${value}`} /><span><strong>{label}</strong><small>{description}</small></span>{appPreferences.theme === value ? <b>已选择</b> : null}</button>)}</div></div>
              <div className="panel settings-card"><div className="settings-card-head"><MonitorCog size={18} /><div><h2>界面缩放与字体</h2><p>整体放大字体、按钮和信息密度，适合高分辨率屏幕。</p></div></div><div className="ui-scale-options">{([.9, 1, 1.1, 1.2, 1.3, 1.4] as const).map((scale) => <button key={scale} className={appPreferences.uiScale === scale ? 'selected' : ''} onClick={() => updateAppPreference('uiScale', scale)}><strong>{Math.round(scale * 100)}%</strong><span>{scale === 1 ? '标准' : scale < 1 ? '紧凑' : scale >= 1.3 ? '特大' : '放大'}</span></button>)}</div><p className="settings-scale-note">缩放立即生效。较大缩放会减少同屏显示内容，但能显著改善小字号阅读。</p></div>
              <div className="panel settings-card"><div className="settings-card-head"><MonitorCog size={18} /><div><h2>应用行为</h2><p>所有行为均可关闭，不会强制后台运行。</p></div></div><div className="setting-rows"><label><span><strong>界面动效</strong><small>页面切换、按钮和卡片使用轻量过渡</small></span><input type="checkbox" checked={appPreferences.motionEnabled} onChange={(event) => updateAppPreference('motionEnabled', event.target.checked)} /></label><label><span><strong>启动动画</strong><small>启动时显示约一秒的品牌过渡，可随时跳过</small></span><input type="checkbox" checked={appPreferences.launchAnimationEnabled} onChange={(event) => updateAppPreference('launchAnimationEnabled', event.target.checked)} /></label><label className="celebration-setting"><span><strong>成就庆祝反馈</strong><small>完整模式显示稀有粒子和里程碑烟花；轻量模式仅显示卡片</small></span><select value={appPreferences.celebrationMode} onChange={(event) => updateAppPreference('celebrationMode', event.target.value as AppPreferences['celebrationMode'])}><option value="full">完整</option><option value="light">轻量</option><option value="off">关闭</option></select></label><label><span><strong>关闭后驻留托盘</strong><small>开启后关闭窗口不会退出，可从系统托盘重新打开</small></span><input type="checkbox" disabled={appBehaviorBusy} checked={keepRunningInTray} onChange={(event) => void updateBackgroundBehavior(event.target.checked)} /></label><label><span><strong>DDL 桌面提醒</strong><small>应用运行期间提醒临近截止的作业</small></span><input type="checkbox" checked={deadlineRemindersEnabled} onChange={(event) => setDeadlineRemindersEnabled(event.target.checked)} /></label><label><span><strong>Blackboard 自动缓存</strong><small>同步后自动缓存新发现的课程文件</small></span><input type="checkbox" checked={autoCacheEnabled} onChange={(event) => setAutoCacheEnabled(event.target.checked)} /></label></div></div>
              <div className="panel settings-card settings-auto-sync"><div className="settings-card-head"><RefreshCw size={18} /><div><h2>后台自动同步与 DDL 邮件</h2><p>应用运行或驻留托盘时，定时检查课程、作业与截止时间变化。</p></div></div><div className="auto-sync-master"><label><span><strong>启用后台自动同步</strong><small>默认关闭；开启后按设定间隔依次同步所选平台</small></span><input type="checkbox" checked={appPreferences.autoSync.enabled} onChange={(event) => updateAutoSyncPreference('enabled', event.target.checked)} /></label><label><span>同步间隔</span><select value={appPreferences.autoSync.intervalMinutes} onChange={(event) => updateAutoSyncPreference('intervalMinutes', Number(event.target.value) as AutoSyncPreferences['intervalMinutes'])}>{AUTO_SYNC_INTERVALS.map((minutes) => <option key={minutes} value={minutes}>{minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`}</option>)}</select></label></div><div className="auto-sync-options"><label><input type="checkbox" checked={appPreferences.autoSync.syncOnLaunch} onChange={(event) => updateAutoSyncPreference('syncOnLaunch', event.target.checked)} /><span><strong>启动时同步</strong><small>启动约 8 秒后执行，给登录会话留出恢复时间</small></span></label><label><input type="checkbox" checked={appPreferences.autoSync.blackboard} onChange={(event) => updateAutoSyncPreference('blackboard', event.target.checked)} /><span><strong>同步 Blackboard</strong><small>课程、目录、资料和 Blackboard 作业</small></span></label><label><input type="checkbox" checked={appPreferences.autoSync.gradescope} onChange={(event) => updateAutoSyncPreference('gradescope', event.target.checked)} /><span><strong>同步 Gradescope</strong><small>课程、作业、提交状态和成绩</small></span></label><label><input type="checkbox" checked={appPreferences.autoSync.quietHoursEnabled} onChange={(event) => updateAutoSyncPreference('quietHoursEnabled', event.target.checked)} /><span><strong>免打扰时段</strong><small>暂停自动同步和 DDL 邮件，桌面手动操作不受影响</small></span></label></div>{appPreferences.autoSync.quietHoursEnabled ? <div className="auto-sync-quiet"><label>开始<input type="number" min="0" max="23" value={appPreferences.autoSync.quietStartHour} onChange={(event) => updateAutoSyncPreference('quietStartHour', Math.min(23, Math.max(0, Number(event.target.value) || 0)))} /></label><span>时 至</span><label>结束<input type="number" min="0" max="23" value={appPreferences.autoSync.quietEndHour} onChange={(event) => updateAutoSyncPreference('quietEndHour', Math.min(23, Math.max(0, Number(event.target.value) || 0)))} /></label><span>时</span></div> : null}<div className="deadline-threshold-settings"><div><strong>DDL 邮件阈值</strong><small>每个“作业 + 当前 DDL + 阈值”只发送一次；多个作业合并成一封邮件</small></div><div>{DEADLINE_EMAIL_THRESHOLDS.map((days) => <button key={days} className={appPreferences.autoSync.deadlineEmailThresholdDays.includes(days) ? 'selected' : ''} onClick={() => toggleDeadlineEmailThreshold(days)}>{days} 天前</button>)}</div></div><div className={`auto-sync-status ${autoSyncStatus.state}`}><i /><div><strong>{autoSyncStatus.message || '尚未运行自动同步'}</strong><small>{autoSyncStatus.lastSuccess ? `上次成功：${new Date(autoSyncStatus.lastSuccess).toLocaleString('zh-CN', { hour12: false })}` : '还没有成功记录'}{autoSyncStatus.nextAt ? ` · 下次：${new Date(autoSyncStatus.nextAt).toLocaleString('zh-CN', { hour12: false })}` : ''}</small></div></div>{appPreferences.autoSync.enabled && !keepRunningInTray ? <p className="auto-sync-note">当前没有开启托盘常驻。关闭主窗口后应用会退出，自动同步和邮件提醒也会停止。</p> : null}</div>
              <div className="panel settings-card settings-shortcuts">
                <div className="settings-card-head shortcut-settings-head"><CommandIcon size={18} /><div><h2>快捷键</h2><p>每项都可以修改或关闭；快捷键仅在学径窗口内生效。</p></div><button className="outline-button" onClick={resetAllShortcutBindings}>恢复全部默认</button></div>
                {shortcutError ? <div className="shortcut-error">{shortcutError}</div> : null}
                <div className="shortcut-list">{SHORTCUT_DEFINITIONS.map((definition) => {
                  const binding = appPreferences.shortcuts[definition.id]
                  const recording = recordingShortcutId === definition.id
                  const customized = !binding?.enabled || binding?.accelerator !== definition.defaultAccelerator
                  return <article className={!binding?.enabled ? 'disabled' : ''} key={definition.id}><label className="shortcut-switch"><input type="checkbox" checked={binding?.enabled ?? true} onChange={(event) => toggleShortcutBinding(definition.id, event.target.checked)} /><span /></label><span><strong>{definition.label}</strong><small>{definition.description}{customized ? ' · 已自定义' : ''}</small></span><button className={`shortcut-recorder ${recording ? 'recording' : ''}`} onClick={() => { setRecordingShortcutId(recording ? null : definition.id); setShortcutError('') }}><kbd>{recording ? '请按新的组合键…' : displayAccelerator(binding?.accelerator ?? definition.defaultAccelerator)}</kbd></button><button className="shortcut-reset" disabled={!customized} onClick={() => resetShortcutBinding(definition.id)}>恢复默认</button></article>
                })}</div>
                <p className="shortcut-settings-note">录制时按 Esc 取消。组合键必须包含 Ctrl、Alt 或 Meta；重复组合不会保存。即使关闭命令中心快捷键，侧栏搜索按钮仍可使用。</p>
              </div>
              <div className="panel settings-card"><div className="settings-card-head"><Timer size={18} /><div><h2>番茄钟时长</h2><p>同时应用到独立专注页与期末复习会话。</p></div></div><div className="pomodoro-settings"><label><span>专注时长</span><div><input type="number" min="5" max="120" value={appPreferences.focusMinutes} onChange={(event) => updateAppPreference('focusMinutes', Math.min(120, Math.max(5, Number(event.target.value) || 5)))} /><small>分钟</small></div></label><label><span>休息时长</span><div><input type="number" min="1" max="30" value={appPreferences.breakMinutes} onChange={(event) => updateAppPreference('breakMinutes', Math.min(30, Math.max(1, Number(event.target.value) || 1)))} /><small>分钟</small></div></label></div></div>
              <div className="panel settings-card settings-course-management"><div className="settings-card-head"><GraduationCap size={18} /><div><h2>课程管理</h2><p>结课课程保留全部资料与学习证据，但不再进入自动复习安排。</p></div></div>{study.courses.length ? <div className="course-lifecycle-list">{[...study.courses].sort((left, right) => Number(left.studyStatus === 'completed') - Number(right.studyStatus === 'completed') || left.name.localeCompare(right.name, 'zh-CN')).map((course) => { const completed = course.studyStatus === 'completed'; const materialCount = study.materials.filter((material) => material.courseId === course.id && material.kind !== 'folder').length; return <article key={course.id} className={completed ? 'completed' : ''}><i style={{ background: course.color }} /><div><strong>{course.name}</strong><small>{course.sources.join(' · ')} · {materialCount} 项资料{completed && course.completedAt ? ` · ${new Date(course.completedAt).toLocaleDateString()} 结课` : ''}</small></div><span className={`course-status ${completed ? 'completed' : 'active'}`}>{completed ? '已结课' : '进行中'}</span>{completed ? <button className="outline-button" onClick={() => restoreCourse(course)}>重新开课</button> : <button className="outline-button" onClick={() => { setCourseCompletionId(course.id); setRemoveCourseManualSchedule(false) }}>标记结课</button>}</article> })}</div> : <p className="muted">连接学习平台或手动添加课程后，可在这里管理课程状态。</p>}</div>
              <div className="panel settings-card"><div className="settings-card-head"><Database size={18} /><div><h2>复习队列与提醒</h2><p>控制首页每天展示的任务量和到期提醒。</p></div></div><div className="review-queue-settings"><label><span><strong>每日任务上限</strong><small>限制为 3～12 项，优先保留到期和测试错误内容</small></span><div><input type="number" min="3" max="12" value={appPreferences.reviewQueueLimit} onChange={(event) => updateAppPreference('reviewQueueLimit', Math.min(12, Math.max(3, Number(event.target.value) || 3)))} /><small>项</small></div></label><label><span><strong>间隔复习桌面提醒</strong><small>应用运行时，每天提醒一次当日到期队列</small></span><input type="checkbox" checked={appPreferences.reviewRemindersEnabled} onChange={(event) => updateAppPreference('reviewRemindersEnabled', event.target.checked)} /></label></div></div>
              <div className="panel settings-card"><div className="settings-card-head"><Database size={18} /><div><h2>资料库与解析</h2><p>当前资料库位置和本地解析入口。</p></div></div><div className="settings-detail"><span>资料库位置</span><strong title={vaultRoot}>{vaultRoot}</strong><div><button className="outline-button" onClick={chooseVault}>更改或迁移位置</button><button className="outline-button" onClick={() => setSection('knowledge')}>打开知识库</button></div></div></div>
              <div className="panel settings-card"><div className="settings-card-head"><Settings2 size={18} /><div><h2>连接与智能服务</h2><p>账号、会话、邮箱与云端 AI 配置集中管理。</p></div></div><div className="settings-action-list"><button onClick={openBlackboardCredentials}><span><strong>Blackboard 登录辅助</strong><small>{blackboardCredential.configured ? `已保存账号 ${blackboardCredential.username}` : '尚未保存账号信息'}</small></span><ChevronRight size={16} /></button><button onClick={() => setShowAiSettings(true)}><span><strong>云端 AI 配置</strong><small>{aiConfig.configured ? `已配置 ${aiConfig.model}` : '尚未配置兼容 API'}</small></span><ChevronRight size={16} /></button><button onClick={() => { setEmailPassword(''); setEmailTestState(null); setShowEmailSettings(true) }}><span><strong>邮箱通知</strong><small>{emailConfig.configured ? `${emailConfig.enabled ? '已启用' : '已关闭'} · 发送至 ${emailConfig.recipient}` : '尚未配置 SMTP 邮箱'}</small></span><ChevronRight size={16} /></button><button onClick={connected ? disconnectBlackboard : connectBlackboard}><span><strong>Blackboard 会话</strong><small>{connected ? '当前已连接，点击退出登录' : '当前未连接，点击登录'}</small></span><ChevronRight size={16} /></button><button onClick={gradescopeConnected ? disconnectGradescope : connectGradescope}><span><strong>Gradescope 会话</strong><small>{gradescopeConnected ? '当前已连接，点击退出登录' : '当前未连接，点击登录'}</small></span><ChevronRight size={16} /></button></div></div>
            </div>
          </section>}
        </div>
      </main>
      {latestRefinementJob ? <button className={`refinement-task-chip ${latestRefinementJob.status}`} onClick={() => setShowRefinementTaskPanel(true)}><span><Network size={15} /></span><span><strong>{refinementJobStatusLabel(latestRefinementJob.status)}</strong><small>{latestRefinementJob.progress.completed}/{latestRefinementJob.progress.total} · {latestRefinementJob.mode === 'original' ? '自适应 AI 精炼' : '旧版兼容任务'}</small></span>{['running', 'pausing', 'cancelling'].includes(latestRefinementJob.status) ? <RefreshCw className="spin" size={14} /> : <ChevronRight size={14} />}</button> : null}
      {showRefinementTaskPanel && latestRefinementJob ? <aside className="refinement-task-panel">
        <div className="refinement-task-head"><div><span className="eyebrow">自适应 AI 精炼任务</span><h2>{refinementJobStatusLabel(latestRefinementJob.status)}</h2></div><button onClick={() => setShowRefinementTaskPanel(false)}><X size={16} /></button></div>
        <div className="refinement-task-summary"><div><strong>{latestRefinementJob.progress.completed}/{latestRefinementJob.progress.total}</strong><span>已完成资料</span></div><div><strong>{latestRefinementJob.failed.length}</strong><span>失败项目</span></div><div><strong>{latestRefinementJob.mode === 'original' ? latestRefinementJob.materialIds.length : latestRefinementJob.checkpointedIds.length}</strong><span>{latestRefinementJob.mode === 'original' ? '自适应任务' : '旧版断点'}</span></div></div>
        <div className="refinement-task-current"><span>{latestRefinementJob.currentMaterialId ? '当前资料' : '任务状态'}</span><strong>{latestRefinementJob.progress.title || refinementJobStatusLabel(latestRefinementJob.status)}</strong>{latestRefinementJob.currentMaterialId && latestRefinementJob.progress.itemTotal ? <small>当前阶段 {Math.floor(latestRefinementJob.progress.itemCompleted ?? 0)}/{latestRefinementJob.progress.itemTotal}</small> : null}</div>
        {latestRefinementJob.finalizationError ? <div className="refinement-finalization-error"><strong>课程知识点归并未完成</strong><span>{latestRefinementJob.finalizationError}</span></div> : null}
        <div className="refinement-task-items">{latestRefinementJob.items.map((item) => <article className={item.completed ? 'completed' : item.failed ? 'failed' : item.materialId === latestRefinementJob.currentMaterialId ? 'running' : ''} key={item.materialId}><span>{item.completed ? '✓' : item.failed ? '!' : item.materialId === latestRefinementJob.currentMaterialId ? '…' : '·'}</span><div><strong title={item.title}>{item.title}</strong><small>{item.completed ? '已保存 AI 精炼结果' : item.failed ? item.failed : item.checkpointed ? '已有可恢复的分页断点' : '等待自动选择精炼方式'}</small></div></article>)}</div>
        <div className="refinement-task-actions">{latestRefinementJob.status === 'running' ? <><button className="outline-button" disabled={busyKey === 'refinement-control'} onClick={() => void controlRefinementJob('pause', latestRefinementJob.id)}>安全暂停</button><button className="danger-button" disabled={busyKey === 'refinement-control'} onClick={() => { if (window.confirm('立即停止会中断当前上传或分析请求；已经完成的文件和分页断点会保留。是否继续？')) void controlRefinementJob('cancel', latestRefinementJob.id) }}>立即停止</button></> : null}{['pausing', 'cancelling'].includes(latestRefinementJob.status) ? <span>正在等待任务到达安全状态…</span> : null}{['paused', 'interrupted', 'completed_with_errors', 'failed'].includes(latestRefinementJob.status) ? <><button className="primary-button" disabled={busyKey === 'refinement-control'} onClick={() => void controlRefinementJob('resume', latestRefinementJob.id)}>继续未完成文件</button><button className="outline-button" disabled={busyKey === 'refinement-control'} onClick={() => { if (window.confirm('重新开始会重新处理本任务选择的全部课件，并替换已有精炼结果。是否继续？')) void controlRefinementJob('restart', latestRefinementJob.id) }}>全部重新开始</button></> : null}{!['running', 'pausing', 'cancelling'].includes(latestRefinementJob.status) ? <button className="text-button" disabled={busyKey === 'refinement-control'} onClick={() => void controlRefinementJob('dismiss', latestRefinementJob.id)}>移除任务记录</button> : null}</div>
      </aside> : null}
      {showCommandCenter && <div className="command-center-backdrop" onMouseDown={closeCommandCenter}><div className="command-center" onMouseDown={(event) => event.stopPropagation()}><div className="command-center-search"><Search size={19} /><input ref={commandInputRef} value={commandQuery} onChange={(event) => { setCommandQuery(event.target.value); setCommandSelectionIndex(0) }} placeholder="搜索课程、资料正文、知识点、作业或输入 > 查找命令" /><kbd>Esc</kbd></div><div className="command-center-meta"><span>{commandQuery.trim() ? `${commandCenterResults.length} 个结果` : '常用命令与页面快捷键'}</span>{bodySearchBusy ? <em><RefreshCw className="spin" size={11} />正在搜索本地资料正文</em> : commandQuery.trim().length >= 2 && !commandQuery.trim().startsWith('>') ? <em>已同时检索本地知识库正文</em> : <em>输入 &gt; 只搜索命令</em>}</div><div className="command-center-results">{commandCenterResults.length ? commandCenterResults.map((entry, index) => { const Icon = entry.kind === 'command' ? CommandIcon : entry.kind === 'course' ? GraduationCap : entry.kind === 'material' ? (study.materials.find((material) => material.id === entry.materialId)?.kind === 'folder' ? Folder : FileText) : entry.kind === 'concept' ? Network : entry.kind === 'assignment' ? Send : CalendarDays; const kindLabel = { command: '操作', course: '课程', material: '资料', concept: '知识点', assignment: '作业', review: '复习记录' }[entry.kind]; return <button className={commandSelectionIndex === index ? 'selected' : ''} key={entry.id} onMouseEnter={() => setCommandSelectionIndex(index)} onClick={() => executeSearchEntry(entry)}><span className={`command-result-icon ${entry.kind}`}><Icon size={15} /></span><span className="command-result-content"><strong>{entry.title}{entry.completedCourse ? <i>已结课</i> : null}</strong><small>{entry.bodySnippet ? `正文：${entry.bodySnippet}` : entry.subtitle}</small></span><span className="command-result-kind">{kindLabel}</span>{entry.shortcut ? <kbd>{entry.shortcut}</kbd> : <ChevronRight size={14} />}</button> }) : <div className="command-center-empty"><Search size={24} /><strong>没有找到相关内容</strong><span>可以尝试课程代码、原文件名、知识点名称，或输入 &gt; 查看命令。</span></div>}</div><div className="command-center-footer"><span><kbd>↑</kbd><kbd>↓</kbd>选择</span><span><kbd>Enter</kbd>打开</span>{commandCenterShortcut ? <span><kbd>{commandCenterShortcut}</kbd>唤起</span> : <span>快捷键入口已关闭</span>}<button onClick={() => { closeCommandCenter(); setSection('settings') }}>管理快捷键</button></div></div></div>}
      {analyzedAssignment && <div className="modal-backdrop" onMouseDown={() => !['assignment-details:' + analyzedAssignment.id, 'assignment-files:' + analyzedAssignment.id, 'assignment-ai-match:' + analyzedAssignment.id, 'assignment-file-remove:' + analyzedAssignment.id].includes(busyKey ?? '') && setAssignmentAnalysisId(null)}><div className="modal assignment-analysis-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" disabled={['assignment-details:' + analyzedAssignment.id, 'assignment-files:' + analyzedAssignment.id, 'assignment-ai-match:' + analyzedAssignment.id, 'assignment-file-remove:' + analyzedAssignment.id].includes(busyKey ?? '')} onClick={() => setAssignmentAnalysisId(null)}><X size={16} /></button><span className="eyebrow">作业分析 · {courseNames.get(analyzedAssignment.courseId) ?? analyzedAssignment.sourceCourseName}</span><h2>{analyzedAssignment.title}</h2><p className="modal-note">Gradescope 作业请先在网页中自行下载 Original / Graded Copy，再添加作业文件。点击“AI 匹配知识点”时，应用会本地解析该附件，并仅把题目文本和候选知识点发送给 AI；建议必须由你确认。</p><div className="assignment-analysis-actions">{analyzedAssignment.source === 'Blackboard' ? <button className="outline-button" disabled={busyKey === 'assignment-details:' + analyzedAssignment.id} onClick={() => void readAssignmentDetails()}>{busyKey === 'assignment-details:' + analyzedAssignment.id ? '读取中…' : analyzedAssignment.detailsText ? '重新读取题目说明' : '从平台读取题目说明'}</button> : null}<button className="primary-button" disabled={(!analyzedAssignment.detailsText?.trim() && !analyzedAssignment.files?.length) || busyKey === 'assignment-ai-match:' + analyzedAssignment.id} onClick={() => void requestAssignmentAiMatch()}>{busyKey === 'assignment-ai-match:' + analyzedAssignment.id ? 'AI 匹配中…' : assignmentAiMatch ? '重新 AI 匹配' : 'AI 匹配知识点'}</button><button className="outline-button" onClick={() => openSubmission(analyzedAssignment.url)}>打开作业页面</button></div><div className="assignment-file-section"><div><strong>作业文件</strong><span>可在 Gradescope 下载 Original / Graded Copy 后添加；文件只复制到本地资料库。</span></div><button className="outline-button" disabled={busyKey === 'assignment-files:' + analyzedAssignment.id} onClick={() => void addAssignmentFiles()}>{busyKey === 'assignment-files:' + analyzedAssignment.id ? '添加中…' : '添加作业文件'}</button>{analyzedAssignment.files?.length ? <div className="assignment-file-list">{analyzedAssignment.files.map((file) => <article key={file.id}><FileText size={14} /><span><strong>{file.title}</strong><small>{file.type} · {new Date(file.addedAt).toLocaleDateString()}</small></span><button onClick={() => void openAssignmentFile(file.localPath)}>打开</button><button disabled={busyKey === 'assignment-file-remove:' + analyzedAssignment.id} onClick={() => void removeAssignmentFile(file)}>移除关联</button></article>)}</div> : <small className="assignment-file-empty">尚未添加文件。</small>}</div>{analyzedAssignment.detailsText ? <details className="assignment-details-text"><summary>已读取题目说明 · {analyzedAssignment.detailsFetchedAt ? new Date(analyzedAssignment.detailsFetchedAt).toLocaleString() : '本机缓存'}</summary><p>{analyzedAssignment.detailsText}</p></details> : <p className="assignment-analysis-hint">尚未提供网页题目说明。对于 Gradescope，请下载作业 PDF 后点击“添加作业文件”；系统会在你点击 AI 按钮时从附件本地提取文字，不会自行推荐知识点。</p>}{!knowledgeIndex ? <div className="assignment-analysis-empty"><strong>尚未构建本课程知识库</strong><span>请先缓存或导入课程资料，并在“知识库”中完成构建，再回来分析作业。</span><button className="primary-button" onClick={() => { setAssignmentAnalysisId(null); setKnowledgeCourseFilter(analyzedAssignment.courseId); setSection('knowledge') }}>打开知识库</button></div> : !assignmentCourseConcepts.length ? <div className="assignment-analysis-empty"><strong>当前课程没有可用知识点</strong><span>请在知识库中解析课件或检查资料是否被设为“教材/参考资料”。</span></div> : <><div className={'assignment-ai-result ' + (assignmentAiMatch ? 'ready' : assignmentAiMatchStale ? 'stale' : '')}><strong>{assignmentAiMatch ? 'AI 已给出待确认的知识点建议' : assignmentAiMatchStale ? '题目说明已更新，请重新让 AI 匹配' : '尚未请求 AI 匹配'}</strong><span>{assignmentAiMatch ? `模型：${assignmentAiMatch.model} · ${new Date(assignmentAiMatch.generatedAt).toLocaleString()}。请在下方核对后保存。` : assignmentAiMatchStale ? '旧的 AI 建议不会继续使用。' : '系统不会根据关键词、自评或课程薄弱项自行选择前置知识。'}</span>{assignmentAiMatch?.explanation ? <p>{assignmentAiMatch.explanation}</p> : null}</div><div className="assignment-concept-picker"><div><strong>确认作业相关知识点</strong><span>只有你勾选并保存的内容会成为该作业的人工映射。</span></div>{assignmentCourseConcepts.map((concept) => <label key={concept.id}><input type="checkbox" checked={assignmentKnowledgeDraft.includes(concept.id)} onChange={() => setAssignmentKnowledgeDraft((current) => current.includes(concept.id) ? current.filter((id) => id !== concept.id) : [...current, concept.id])} /><span>{concept.title}<small>{assignmentAiMatch?.conceptIds.includes(concept.id) ? 'AI 建议：请结合题目说明确认。' : `${concept.sourceIds.length} 份来源课件`}</small></span></label>)}</div><div className="assignment-analysis-footer"><button className="outline-button" onClick={() => saveAssignmentKnowledge([])}>清除人工映射</button><button className="outline-button" onClick={() => saveAssignmentKnowledge()}>确认并保存</button><button className="primary-button" disabled={!assignmentKnowledgeDraft.length} onClick={bringAssignmentKnowledgeToReview}>带入复习选择</button></div></>}</div></div>}
      {deadlineEditorId && <div className="modal-backdrop" onMouseDown={() => setDeadlineEditorId(null)}><div className="modal deadline-editor-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" onClick={() => setDeadlineEditorId(null)}><X size={16} /></button><span className="eyebrow">人工 DDL 修正</span><h2>设置截止时间</h2><p className="modal-note">人工设置会优先于平台同步值，适合 Blackboard 未提供 DDL 或你需要修正平台信息的情况。清空后将恢复使用平台值。</p><label>截止日期与时间<input type="datetime-local" value={deadlineDraft} onChange={(event) => setDeadlineDraft(event.target.value)} /></label><div className="deadline-editor-actions"><button className="outline-button" onClick={() => { setDeadlineDraft(''); saveManualDeadline('') }}>清除人工设置</button><button className="primary-button" onClick={() => saveManualDeadline()}>保存 DDL</button></div></div></div>}
      {courseCompletionId && <div className="modal-backdrop" onMouseDown={() => setCourseCompletionId(null)}><div className="modal course-completion-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" onClick={() => setCourseCompletionId(null)}><X size={16} /></button><span className="eyebrow">课程生命周期</span><h2>将“{study.courses.find((course) => course.id === courseCompletionId)?.name}”标记为已结课？</h2><p className="modal-note">结课后，这门课会停止进入今日复习队列、系统间隔日程和桌面提醒。课程资料、知识库、知识点自评、快速测试、成长统计及历史记录都不会删除，并且可以随时重新开课。</p><label className="course-completion-option"><input type="checkbox" checked={removeCourseManualSchedule} onChange={(event) => setRemoveCourseManualSchedule(event.target.checked)} /><span><strong>同时移除今天及未来的手动日程</strong><small>过去的完成记录仍然保留；重新开课后不会自动恢复已移除的手动日程。</small></span></label><div className="course-completion-actions"><button className="outline-button" onClick={() => setCourseCompletionId(null)}>取消</button><button className="primary-button" onClick={confirmCourseCompletion}>确认结课</button></div></div></div>}
      {showBatchRefinement && <div className="modal-backdrop" onMouseDown={() => busyKey !== 'refine-job-start' && setShowBatchRefinement(false)}>
        <div className="modal batch-refinement-modal" onMouseDown={(event) => event.stopPropagation()}>
          <button className="close" disabled={busyKey === 'refine-job-start'} onClick={() => setShowBatchRefinement(false)}><X size={16} /></button>
          <span className="eyebrow">批量 AI 精炼</span><h2>选择需要分析的课件</h2>
          <p className="modal-note">应用会按当前 API 能力自动选择原件直传或本地分页兼容精炼。DeepSeek、Gemini 等对话接口不会请求不存在的文件上传端点。教材和参考书不会出现在这里，任务开始后可继续使用其他页面。</p>
          <div className="refinement-cost-estimate"><strong>将分析 {batchRefinementSelection.length} 份课程资料</strong><span>{batchRefinementBytes ? `当前选择约 ${(batchRefinementBytes / 1024 / 1024).toFixed(1)} MB。` : '文件大小将在处理前检查。'} 当前配置：{aiConfig.capabilities?.refinementMode === 'original-file' ? '优先原件直传，接口拒绝时自动回退' : aiConfig.capabilities?.refinementMode === 'structured-pages' || ['deepseek', 'gemini'].includes(aiConfig.provider) ? '本地分页后发送必要文本' : '任务开始时自动检测接口能力'}。</span></div>
          <div className="batch-refinement-toolbar"><div><strong>已选择 {batchRefinementSelection.length}/{batchRefinementCandidates.length} 份</strong><span>{batchRefinementCurrentCount ? `其中 ${batchRefinementCurrentCount} 份将重新上传并替换精炼结果` : '不会处理未选择的资料'}</span></div><button className="outline-button" disabled={busyKey === 'refine-job-start'} onClick={() => setBatchRefinementSelection(defaultRefinementSelection(batchRefinementCandidates))}>仅选待更新</button><button className="outline-button" disabled={busyKey === 'refine-job-start'} onClick={() => setBatchRefinementSelection((current) => toggleAllRefinementSelection(batchRefinementCandidates, current))}>{batchRefinementCandidates.length > 0 && batchRefinementCandidates.every((document) => batchRefinementSelected.has(document.materialId)) ? '取消全选' : '一键全选'}</button></div>
          <div className="batch-refinement-list">{batchRefinementCandidates.map((document) => { const state = refinementState(document); const group = versionGroupsByMaterialId.get(document.materialId); return <label className={batchRefinementSelected.has(document.materialId) ? 'selected' : ''} key={document.materialId}><input type="checkbox" disabled={busyKey === 'refine-job-start'} checked={batchRefinementSelected.has(document.materialId)} onChange={() => setBatchRefinementSelection((current) => current.includes(document.materialId) ? current.filter((id) => id !== document.materialId) : [...current, document.materialId])} /><span><strong title={document.title}>{group?.displayTitle ?? document.title}</strong><small>{state === 'current' ? `AI 精炼已完成${document.ai?.model ? ` · ${document.ai.model}` : ''}` : state === 'stale' ? '当前文件版本与 AI 结果不一致' : '尚未进行 AI 精炼'}</small></span><em className={state}>{state === 'current' ? '重新精炼' : state === 'stale' ? '待更新' : '新资料'}</em></label> })}</div>
          <div className="batch-refinement-actions"><button className="outline-button" disabled={busyKey === 'refine-job-start'} onClick={() => setShowBatchRefinement(false)}>取消</button><button className="primary-button" disabled={busyKey === 'refine-job-start' || !batchRefinementSelection.length} onClick={runBatchCloudRefinement}>{busyKey === 'refine-job-start' ? '正在创建任务…' : `后台精炼 ${batchRefinementSelection.length} 份资料`}</button></div>
        </div>
      </div>}
      {pageLocationEditor && <div className="modal-backdrop" onMouseDown={() => busyKey !== 'page-location' && setPageLocationEditor(null)}>
        <div className="modal page-location-modal" onMouseDown={(event) => event.stopPropagation()}>
          <button className="close" disabled={busyKey === 'page-location'} onClick={() => setPageLocationEditor(null)}><X size={16} /></button>
          <span className="eyebrow">人工校正页级索引</span>
          <h2>{pageLocationEditor.conceptTitle}</h2>
          <p className="modal-note" title={pageLocationEditor.documentTitle}>{pageLocationEditor.documentTitle}<br />自动定位只提供辅助，你确认和删除的范围会在重新补索引及资料库迁移后保留。</p>
          <section className="page-location-section">
            <div className="page-location-section-head"><strong>已确认范围</strong><span>{pageLocationEditor.locations.length} 处</span></div>
            {pageLocationEditor.locations.length ? <div className="page-location-ranges">{pageLocationEditor.locations.map((location) => <article key={`${location.kind}:${location.start}:${location.end}`}><div><strong>{knowledgeLocationLabel(location)}</strong><small>{location.manual ? '人工确认' : location.method === 'ai-page-map' ? '页面语义映射' : '本地标题 / 公式匹配'}{location.confidence ? ` · 置信度 ${Math.round(location.confidence * 100)}%` : ''}</small></div><button className="danger-button" disabled={busyKey === 'page-location'} onClick={() => void updatePageLocation('remove', location)}>删除</button></article>)}</div> : <p className="muted">还没有已确认的页码范围。</p>}
          </section>
          <section className="page-location-section candidate-section">
            <div className="page-location-section-head"><strong>待确认候选</strong><span>{pageLocationEditor.candidates.length} 项</span></div>
            {pageLocationEditor.candidates.length ? <div className="page-location-ranges">{pageLocationEditor.candidates.map((location) => <article key={`${location.kind}:${location.start}:${location.end}`}><div><strong>{knowledgeLocationLabel(location)}</strong><small>{location.evidence || '相似标题、关键词或跨语言语义匹配'}{location.confidence ? ` · 置信度 ${Math.round(location.confidence * 100)}%` : ''}</small></div><div><button className="primary-button" disabled={busyKey === 'page-location'} onClick={() => void updatePageLocation('confirm', location)}>确认</button><button className="outline-button" disabled={busyKey === 'page-location'} onClick={() => void updatePageLocation('reject', location)}>忽略</button></div></article>)}</div> : <p className="muted">没有待确认候选。</p>}
          </section>
          <section className="page-location-section manual-location-section">
            <div className="page-location-section-head"><strong>手动添加范围</strong><span>{pageLocationEditor.pageCount ? `资料共 ${pageLocationEditor.pageCount} 个可索引页面` : '由应用检查范围'}</span></div>
            <div className="page-location-form"><label>类型<select value={pageLocationEditor.kind} onChange={(event) => setPageLocationEditor((current) => current ? { ...current, kind: event.target.value as KnowledgeLocation['kind'] } : current)}><option value="pdf-page">PDF 页码</option><option value="pptx-slide">PPT 幻灯片</option><option value="docx-section">文档章节</option></select></label><label>开始<input type="number" min="1" max={pageLocationEditor.pageCount || undefined} value={pageLocationDraftStart} onChange={(event) => setPageLocationDraftStart(event.target.value)} placeholder="例如 14" /></label><label>结束<input type="number" min="1" max={pageLocationEditor.pageCount || undefined} value={pageLocationDraftEnd} onChange={(event) => setPageLocationDraftEnd(event.target.value)} placeholder="留空表示单页" /></label><button className="primary-button" disabled={busyKey === 'page-location' || !pageLocationDraftStart} onClick={() => void updatePageLocation('add')}>{busyKey === 'page-location' ? '保存中…' : '添加范围'}</button></div>
          </section>
        </div>
      </div>}
      {showAiSettings && <div className="modal-backdrop" onMouseDown={() => !['ai-settings', 'ai-test', 'ai-models'].includes(busyKey ?? '') && setShowAiSettings(false)}><div className="modal ai-settings-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" disabled={['ai-settings', 'ai-test', 'ai-models'].includes(busyKey ?? '')} onClick={() => setShowAiSettings(false)}><X size={16} /></button><span className="eyebrow">可选云端 AI</span><h2>配置知识精炼模型</h2><p className="modal-note">选择常用官方服务后会自动填写 API 地址。能力检测会区分对话、模型列表和原件接口：支持 Files + Responses 时优先直传原件，否则自动使用本地分页兼容精炼，不再逐份请求不存在的上传接口。教材和参考书不会进入 AI 精炼。</p><label>AI 服务<select value={aiConfig.provider} onChange={(event) => { const provider = event.target.value as AiProvider; const preset = aiProviderPresets.find((item) => item.id === provider); setAiConfig((current) => ({ ...current, provider, baseUrl: preset?.baseUrl ?? '', model: '', capabilities: undefined, configured: provider === current.provider ? current.configured : false })); setAiModels([]); setAiConnectionState(null) }}>{aiProviderPresets.map((provider) => <option value={provider.id} key={provider.id}>{provider.label}</option>)}</select><small>{aiProviderPresets.find((provider) => provider.id === aiConfig.provider)?.description}</small></label><label>兼容 API 地址<input value={aiConfig.baseUrl} onChange={(event) => { setAiConfig((current) => ({ ...current, baseUrl: event.target.value, provider: current.provider === 'custom' ? 'custom' : current.provider, capabilities: undefined })); setAiModels([]); setAiConnectionState(null) }} placeholder="例如：https://api.openai.com/v1" /></label><label>API 密钥<input type="password" value={aiApiKey} onChange={(event) => { setAiApiKey(event.target.value); setAiConnectionState(null) }} placeholder={aiConfig.configured ? '留空则使用已加密保存的密钥' : '仅保存在系统安全存储中'} /></label><label>模型名称<div className="ai-model-picker"><input list="xuejing-ai-models" value={aiConfig.model} onChange={(event) => { setAiConfig((current) => ({ ...current, model: event.target.value, capabilities: undefined })); setAiConnectionState(null) }} placeholder="可手动填写，或先获取模型列表" /><button type="button" className="outline-button" disabled={busyKey === 'ai-models' || !aiConfig.baseUrl} onClick={loadAiModels}>{busyKey === 'ai-models' ? '读取中…' : '获取模型'}</button></div><datalist id="xuejing-ai-models">{aiModels.map((model) => <option value={model} key={model} />)}</datalist>{aiModels.length ? <small>接口返回 {aiModels.length} 个模型；列表来自服务端，不在应用内硬编码。</small> : null}</label>{aiConfig.capabilities ? <div className="ai-capability-summary"><span className={aiConfig.capabilities.chat ? 'available' : 'missing'}>对话 {aiConfig.capabilities.chat ? '可用' : '不可用'}</span><span className={aiConfig.capabilities.files && aiConfig.capabilities.responses ? 'available' : 'fallback'}>{aiConfig.capabilities.refinementMode === 'original-file' ? '原件直传' : '本地分页兼容'}</span><span>{aiConfig.capabilities.provider === 'openai' ? 'OpenAI' : aiConfig.capabilities.provider === 'deepseek' ? 'DeepSeek' : aiConfig.capabilities.provider === 'gemini' ? 'Gemini' : '自定义接口'}</span></div> : null}{aiConnectionState ? <div className={'ai-connection-state ' + aiConnectionState.kind}><span>{aiConnectionState.kind === 'testing' ? '正在检测' : aiConnectionState.kind === 'success' ? '检测完成' : '检测失败'}</span><strong>{aiConnectionState.message}</strong></div> : null}<div className="ai-settings-actions"><button className="outline-button" disabled={['ai-settings', 'ai-test', 'ai-models'].includes(busyKey ?? '') || !aiConfig.model} onClick={testAiConnection}>{busyKey === 'ai-test' ? '检测中…' : '检测连接与能力'}</button><button className="primary-button" disabled={['ai-settings', 'ai-test', 'ai-models'].includes(busyKey ?? '')} onClick={saveAiConfiguration}>{busyKey === 'ai-settings' ? '保存中…' : '加密保存配置'}</button></div></div></div>}
      {showBlackboardCredentials && <div className="modal-backdrop" onMouseDown={() => busyKey !== 'blackboard-credentials' && setShowBlackboardCredentials(false)}><div className="modal credential-settings-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" disabled={busyKey === 'blackboard-credentials'} onClick={() => setShowBlackboardCredentials(false)}><X size={16} /></button><span className="eyebrow">Blackboard 登录辅助</span><h2>保存学校账号</h2><p className="modal-note">账号和密码只会加密保存在当前 Windows 用户的系统安全存储中。点击“连接 Blackboard”时，应用只会自动填入统一认证页面；验证码、二次认证和最终登录仍由你本人完成。</p><label>账号<input autoComplete="username" value={blackboardCredential.username} onChange={(event) => setBlackboardCredential((current) => ({ ...current, username: event.target.value }))} placeholder="学校统一身份认证账号" /></label><label>密码<input autoComplete="current-password" type="password" value={blackboardPassword} onChange={(event) => setBlackboardPassword(event.target.value)} placeholder={blackboardCredential.configured ? '留空则保留已保存的密码' : '首次保存需要填写密码'} /></label><div className="credential-settings-actions"><button className="outline-button" disabled={busyKey === 'blackboard-credentials' || !blackboardCredential.configured} onClick={clearBlackboardCredentials}>删除已保存信息</button><button className="primary-button" disabled={busyKey === 'blackboard-credentials'} onClick={saveBlackboardCredentials}>{busyKey === 'blackboard-credentials' ? '保存中…' : '加密保存'}</button></div></div></div>}
      {showImport && <div className="modal-backdrop" onMouseDown={() => setShowImport(false)}><div className="modal material-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" onClick={() => setShowImport(false)}><X size={16} /></button><span className="eyebrow">手动导入</span><h2>把已有课程资料收纳进来</h2><p className="modal-note">会复制文件到资料库，保留原文件和你的修改；相同内容会自动去重。</p><label>已有课程<select value={importCourseId} onChange={(event) => setImportCourseId(event.target.value)}><option value="">新建课程…</option>{study.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>{!importCourseId && <label>新课程名称<input value={newCourseName} onChange={(event) => setNewCourseName(event.target.value)} placeholder="例如：机器学习导论" /></label>}<label>资料存放路径<input value={importPath} onChange={(event) => setImportPath(event.target.value)} placeholder="例如：微信资料/第3周" /></label><label>知识库用途<select value={importKnowledgeRole} onChange={(event) => setImportKnowledgeRole(event.target.value as 'courseware' | 'reference')}><option value="courseware">课件 / 讲义：生成课程知识点</option><option value="reference">教材 / 参考书：只作参考，不自动扩充词条</option></select></label><button className="primary-button wide" disabled={busyKey === 'import'} onClick={importLocalFiles}>{busyKey === 'import' ? '导入中…' : '选择文件并导入'}</button></div></div>}
      {showMigration && <div className="modal-backdrop" onMouseDown={() => busyKey !== 'migrate' && setShowMigration(false)}><div className="modal migration-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" disabled={busyKey === 'migrate'} onClick={() => setShowMigration(false)}><X size={16} /></button><span className="eyebrow">资料库迁移</span><h2>如何处理已有课程资料？</h2><p className="modal-note">旧位置：{vaultRoot}<br />新位置：{migrationTarget}</p>{migrationProgress && <div className="migration-progress"><span>正在处理 {migrationProgress.completed}/{migrationProgress.total}</span><strong>{migrationProgress.title || '正在完成…'}</strong></div>}<button className="primary-button wide" disabled={busyKey === 'migrate'} onClick={() => migrateVault('copy')}>复制到新位置（推荐）</button><button className="outline-button wide" disabled={busyKey === 'migrate'} onClick={() => migrateVault('move')}>迁移并删除已验证的旧副本</button><button className="text-button switch-vault-button" disabled={busyKey === 'migrate'} onClick={() => migrateVault('switch')}>仅切换位置，保留旧资料</button><p className="modal-note">复制或迁移都会逐个校验内容；同一文件不会重复复制。若有文件已被移动，资料页会显示“文件缺失”，可重新缓存。</p></div></div>}
      {showManualAssignment && <div className="modal-backdrop" onMouseDown={() => setShowManualAssignment(false)}><div className="modal manual-assignment-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" onClick={() => setShowManualAssignment(false)}><X size={16} /></button><span className="eyebrow">手动添加作业</span><h2>收纳其他来源的作业</h2><p className="modal-note">适用于课程群、微信、邮箱、线下布置或其他学习平台的作业。保存后会直接进入分析页面，可继续添加题目文件并让 AI 匹配课程知识点。</p><label>归属课程<select value={manualAssignmentCourseId} onChange={(event) => setManualAssignmentCourseId(event.target.value)}><option value="">新建课程…</option>{study.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>{!manualAssignmentCourseId && <label>新课程名称<input value={manualAssignmentCourseName} onChange={(event) => setManualAssignmentCourseName(event.target.value)} placeholder="例如：数据结构" /></label>}<label>作业名称<input autoFocus value={manualAssignmentTitle} onChange={(event) => setManualAssignmentTitle(event.target.value)} placeholder="例如：Homework 3 / 课程项目" /></label><label>截止日期与时间（可选）<input type="datetime-local" value={manualAssignmentDueAt} onChange={(event) => setManualAssignmentDueAt(event.target.value)} /></label><label>题目说明（可选）<textarea value={manualAssignmentDetails} onChange={(event) => setManualAssignmentDetails(event.target.value)} placeholder="粘贴老师发布的要求、题目或评分说明；保存后可直接用于 AI 匹配。" /></label><label>作业网页链接（可选）<input value={manualAssignmentUrl} onChange={(event) => setManualAssignmentUrl(event.target.value)} placeholder="https://…，可用于打开提交或查看页面" /></label><button className="primary-button wide" disabled={!manualAssignmentTitle.trim() || (!manualAssignmentCourseId && !manualAssignmentCourseName.trim())} onClick={saveManualAssignment}>保存并开始分析</button></div></div>}
      {showEmailSettings && <div className="modal-backdrop" onMouseDown={() => !['email-settings', 'email-test'].includes(busyKey ?? '') && setShowEmailSettings(false)}><div className="modal email-settings-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" disabled={['email-settings', 'email-test'].includes(busyKey ?? '')} onClick={() => setShowEmailSettings(false)}><X size={16} /></button><span className="eyebrow">可选邮件通知</span><h2>配置 SMTP 邮箱</h2><p className="modal-note">首次同步只发送一条导入摘要；后续资料更新按课程聚合，不会为数百份文件逐封发送邮件。</p><div className="email-settings-grid"><label>SMTP 服务器<input value={emailConfig.host} onChange={(event) => { setEmailConfig((current) => ({ ...current, host: event.target.value })); setEmailTestState(null) }} placeholder="例如：smtp.qq.com" /></label><label>端口<input type="number" min="1" max="65535" value={emailConfig.port} onChange={(event) => { setEmailConfig((current) => ({ ...current, port: Number(event.target.value) || 465 })); setEmailTestState(null) }} /></label><label>邮箱账号<input type="email" value={emailConfig.username} onChange={(event) => { setEmailConfig((current) => ({ ...current, username: event.target.value })); setEmailTestState(null) }} placeholder="name@example.com" /></label><label>邮箱密码 / 授权码<input type="password" value={emailPassword} onChange={(event) => { setEmailPassword(event.target.value); setEmailTestState(null) }} placeholder={emailConfig.configured ? '留空则继续使用已加密密码' : '建议使用邮箱应用专用密码'} /></label><label>发件地址（可选）<input type="email" value={emailConfig.from} onChange={(event) => setEmailConfig((current) => ({ ...current, from: event.target.value }))} placeholder="默认使用邮箱账号" /></label><label>接收通知的邮箱<input type="email" value={emailConfig.recipient} onChange={(event) => { setEmailConfig((current) => ({ ...current, recipient: event.target.value })); setEmailTestState(null) }} placeholder="可以与邮箱账号不同" /></label><label>平台变化邮件<select value={emailConfig.syncEmailMode} onChange={(event) => setEmailConfig((current) => ({ ...current, syncEmailMode: event.target.value as SyncEmailMode, notifyCourseUpdates: event.target.value !== 'off' }))}><option value="important">仅重要变化（推荐）</option><option value="daily">每日聚合摘要</option><option value="every_sync">每次同步摘要</option><option value="off">关闭平台变化邮件</option></select></label>{emailConfig.syncEmailMode === 'daily' ? <label>每日摘要发送时间<select value={emailConfig.syncDigestHour} onChange={(event) => setEmailConfig((current) => ({ ...current, syncDigestHour: Number(event.target.value) }))}>{Array.from({ length: 24 }, (_, hour) => <option value={hour} key={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></label> : null}</div><div className="email-setting-switches"><label><input type="checkbox" checked={emailConfig.secure} onChange={(event) => setEmailConfig((current) => ({ ...current, secure: event.target.checked }))} /><span><strong>使用 SSL/TLS</strong><small>465 端口通常开启；587 端口通常关闭并使用 STARTTLS</small></span></label><label><input type="checkbox" checked={emailConfig.notifyDeadlines} onChange={(event) => setEmailConfig((current) => ({ ...current, notifyDeadlines: event.target.checked }))} /><span><strong>DDL 临近提醒</strong><small>独立于普通同步摘要，继续按设置的 1/3/5/7 天阈值提醒</small></span></label><label><input type="checkbox" checked={emailConfig.enabled} onChange={(event) => setEmailConfig((current) => ({ ...current, enabled: event.target.checked }))} /><span><strong>启用自动邮件通知</strong><small>关闭后仍保留配置，也可以继续发送测试邮件</small></span></label></div>{emailConfig.syncEmailMode === 'daily' && emailDigestQueue.length ? <div className="email-digest-pending">已有 {emailDigestQueue.length} 组变化等待每日摘要发送</div> : null}{emailTestState ? <div className={'ai-connection-state ' + emailTestState.kind}><span>{emailTestState.kind === 'testing' ? '正在测试' : emailTestState.kind === 'success' ? '发送成功' : '测试失败'}</span><strong>{emailTestState.message}</strong></div> : null}<div className="ai-settings-actions"><button className="outline-button" disabled={['email-settings', 'email-test'].includes(busyKey ?? '')} onClick={testEmailConfiguration}>{busyKey === 'email-test' ? '发送中…' : '发送测试邮件'}</button><button className="primary-button" disabled={['email-settings', 'email-test'].includes(busyKey ?? '')} onClick={saveEmailConfiguration}>{busyKey === 'email-settings' ? '保存中…' : '加密保存配置'}</button></div></div></div>}
      {activeCelebration ? <div className={`achievement-celebration ${activeCelebration.tier} effects-${activeCelebration.effects}`} aria-live="polite">{activeCelebration.effects !== 'none' ? <div className="celebration-particles">{Array.from({ length: activeCelebration.effects === 'fireworks' ? 28 : 14 }, (_, index) => <i key={index} style={{ '--particle': index } as CSSProperties} />)}</div> : null}<div className="celebration-card"><span>{activeCelebration.tier === 'milestone' ? <Trophy size={24} /> : activeCelebration.tier === 'rare' ? <Star size={22} /> : <Award size={21} />}</span><div><small>{activeCelebration.tier === 'milestone' ? '高价值里程碑' : activeCelebration.tier === 'rare' ? '稀有成就' : '成长解锁'}</small><strong>{activeCelebration.title}</strong><p>{activeCelebration.description}</p></div><button onClick={() => setActiveCelebration(null)} aria-label="关闭成就提示"><X size={14} /></button></div></div> : null}
      {toast && <div className="toast">{toast}</div>}
      {showLaunchAnimation && <div className="launch-splash" onClick={() => setShowLaunchAnimation(false)} role="presentation"><img className="launch-brand-image" src={growthJourneyImage} alt="" /><strong>学径</strong><span>把分散的学习信息连成路径</span></div>}
    </div>
  )
}
