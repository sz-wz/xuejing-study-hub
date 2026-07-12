import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  BookOpen, ChevronDown, ChevronRight, CloudDownload, Database, FileText,
  Folder, FolderOpen, GraduationCap, Link2, LogIn, Network, Plus, RefreshCw, Send, Settings2, Timer, Upload, X,
} from 'lucide-react'
import { mergeBlackboardCourses } from './blackboard-import'
import { mergeBlackboardMaterials } from './blackboard-material-import'
import { mergeBlackboardAssignments } from './blackboard-assignment-import'
import { mergeGradescopeAssignments, mergeGradescopeCourses } from './gradescope-import'
import { applyCachedItems } from './cache-state'
import { assignmentAiSourceKey, parseAssignmentAiMatch } from './assignment-ai-match'
import { normalizeAssignmentReflection, reflectionScorePercent, type AssignmentReflectionDraft } from './assignment-reflection'
import { createManualAssignment } from './manual-assignment'
import { assignmentDueAt, deadlineLabel, deadlineReminderBucket, deadlineState, toDateTimeLocalValue } from './deadline-utils'
import { KnowledgeMap } from './knowledge-map'
import { ReviewWorkspace, type ReviewSession } from './review-workspace'
import { isFolderExpanded, toggledFolders } from './library-tree'
import type { Assignment, AssignmentFile, AssignmentReflection, AssignmentStatus, Course, JournalEntry, Material } from './types'

type Section = 'overview' | 'library' | 'assignments' | 'knowledge' | 'map' | 'review' | 'focus' | 'growth'
type ConceptRating = 0 | 1 | 2 | 3 | 4
type KnowledgeDocumentFilter = 'ready' | 'ocr' | 'unsupported' | 'failed' | 'all'
type StudyState = { courses: Course[]; materials: Material[]; assignments: Assignment[]; journal: JournalEntry[]; knowledgeRatings: Record<string, ConceptRating>; reviewSelections: Record<string, { materialIds: string[]; conceptIds: string[]; focus: string }>; reviewSessions: Record<string, ReviewSession> }
type TreeNode = { folders: Map<string, TreeNode>; entries: Material[] }
type FileState = 'available' | 'missing'
type KnowledgeIndex = { documents: { materialId: string; courseId: string; courseName: string; title: string; localPath: string; status: string; hash?: string; error?: string; outline?: string[]; textLength?: number; knowledgeRole?: 'courseware' | 'reference'; ocr?: { pages: number; totalPages: number; language: string; truncated: boolean }; ai?: { summary: string; concepts: { title: string; evidence: string }[]; model: string; generatedAt: string; sourceHash?: string } }[]; concepts: { id: string; title: string; sourceIds: string[]; courseIds: string[] }[]; stats: { total: number; parsed: number; ocr: number; image: number; failed: number; unsupported: number; reference: number; concepts: number } }

const STORAGE_KEY = 'xuejing-study-hub-v3'
const emptyStudy: StudyState = { courses: [], materials: [], assignments: [], journal: [], knowledgeRatings: {}, reviewSelections: {}, reviewSessions: {} }
const courseColors = ['#336a58', '#bf6a48', '#6a5f9e', '#3d7890', '#8a6a3d', '#a35e79']
const emptyAssignmentReflectionDraft: AssignmentReflectionDraft = { score: '', maxScore: '', feedback: '', selfAssessment: '', note: '' }

function reflectionDraftFrom(reflection?: AssignmentReflection): AssignmentReflectionDraft {
  return {
    score: reflection?.score?.toString() ?? '',
    maxScore: reflection?.maxScore?.toString() ?? '',
    feedback: reflection?.feedback ?? '',
    selfAssessment: reflection?.selfAssessment ?? '',
    note: reflection?.note ?? '',
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
  onRefine: (materialId: string, force: boolean) => void
  aiConfigured: boolean
  busyKey: string | null
}

function KnowledgeDocumentList({ documents, expanded, onToggle, onRoleChange, onOcr, onRefine, aiConfigured, busyKey }: KnowledgeDocumentListProps) {
  return <div className="knowledge-document-list">{documents.map((document) => {
    const isParsed = document.status === 'parsed' || document.status === 'ocr'
    const isExpanded = expanded.has(document.materialId)
    const isReference = document.knowledgeRole === 'reference'
    const aiCurrent = Boolean(document.ai && document.ai.sourceHash && document.ai.sourceHash === document.hash)
    return <article className={isExpanded ? 'expanded-document' : ''} key={document.materialId}>
      <FileText size={15} />
      <div className="knowledge-document-main">
        <strong>{document.title}</strong>
        <span>{document.courseName} · {isParsed ? (document.outline?.length ?? 0) + ' 个本资料知识点' : document.error ?? '等待解析'}{isReference ? ' · 教材/参考资料' : ''}</span>
      </div>
      {isParsed && <button className="knowledge-document-toggle" onClick={() => onToggle(document.materialId)} aria-expanded={isExpanded}>{isExpanded ? '收起知识点' : '查看知识点'}</button>}
      {document.status === 'image' && <button className="knowledge-document-toggle" disabled={busyKey === 'ocr:' + document.materialId} onClick={() => onOcr(document.materialId)}>{busyKey === 'ocr:' + document.materialId ? 'OCR 中…' : '本地 OCR'}</button>}
      {isParsed && <button className="knowledge-document-toggle" disabled={!aiConfigured || busyKey === 'refine:' + document.materialId} onClick={() => onRefine(document.materialId, aiCurrent)}>{busyKey === 'refine:' + document.materialId ? '精炼中…' : aiCurrent ? '重新 AI 精炼' : 'AI 精炼'}</button>}
      <button className="knowledge-document-toggle" onClick={() => onRoleChange(document.materialId, isReference ? 'courseware' : 'reference')}>{isReference ? '改为课件' : '设为教材'}</button>
      <em className={'knowledge-status ' + document.status}>{isParsed ? (document.status === 'ocr' ? '已 OCR' : isReference ? '参考资料' : '已解析') : document.status === 'failed' ? '失败' : document.status === 'image' ? '等待 OCR' : document.status === 'empty' ? '无文本' : '暂不支持'}</em>
      {document.ai ? <em className={'knowledge-status ai-refined ' + (aiCurrent ? '' : 'stale')} title={`模型：${document.ai.model}；${new Date(document.ai.generatedAt).toLocaleString()}`}>{aiCurrent ? 'AI 已精炼' : 'AI 待更新'}</em> : null}
      {isParsed && isExpanded && <div className="document-concepts"><span>{document.ai?.summary || (isReference ? '该教材提取的参考主题（不会进入课程知识点）' : '本资料提取的候选知识点')}</span><div>{document.ai?.concepts?.length ? document.ai.concepts.map((concept) => <i key={concept.title} title={concept.evidence}>{concept.title}</i>) : document.outline?.length ? document.outline.map((title) => <i key={title}>{title}</i>) : <small>未提取到足够可靠的知识点。</small>}</div></div>}
    </article>
  })}</div>
}

export default function App() {
  const [study, setStudy] = useState<StudyState>(loadStudy)
  const [section, setSection] = useState<Section>('overview')
  const [vaultRoot, setVaultRoot] = useState('正在读取资料库位置…')
  const [fileStates, setFileStates] = useState<Map<string, FileState>>(() => new Map())
  const [autoCacheEnabled, setAutoCacheEnabled] = useState(() => localStorage.getItem('xuejing-auto-cache-v1') !== 'false')
  const [connected, setConnected] = useState(false)
  const [gradescopeConnected, setGradescopeConnected] = useState(false)
  const [busyKey, setBusyKey] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [selectedCourseId, setSelectedCourseId] = useState<string | null>(null)
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(() => new Set())
  const [showImport, setShowImport] = useState(false)
  const [showMigration, setShowMigration] = useState(false)
  const [migrationTarget, setMigrationTarget] = useState('')
  const [migrationProgress, setMigrationProgress] = useState<{ completed: number; total: number; title: string } | null>(null)
  const [knowledgeIndex, setKnowledgeIndex] = useState<KnowledgeIndex | null>(null)
  const [knowledgeProgress, setKnowledgeProgress] = useState<{ completed: number; total: number; title: string } | null>(null)
  const [expandedKnowledgeDocuments, setExpandedKnowledgeDocuments] = useState<Set<string>>(() => new Set())
  const [knowledgeCourseFilter, setKnowledgeCourseFilter] = useState<'current' | 'all' | string>('current')
  const [knowledgeDocumentFilter, setKnowledgeDocumentFilter] = useState<KnowledgeDocumentFilter>('ready')
  const [mapCourseFilter, setMapCourseFilter] = useState('all')
  const [reviewCourseFilter, setReviewCourseFilter] = useState<'current' | string>('current')
  const [reviewExamDate, setReviewExamDate] = useState(() => localStorage.getItem('xuejing-review-exam-date-v1') ?? '')
  const [focusSeconds, setFocusSeconds] = useState(25 * 60)
  const [focusRunning, setFocusRunning] = useState(false)
  const [showAiSettings, setShowAiSettings] = useState(false)
  const [aiConfig, setAiConfig] = useState({ configured: false, baseUrl: '', model: '' })
  const [aiApiKey, setAiApiKey] = useState('')
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
  const [assignmentReflectionId, setAssignmentReflectionId] = useState('')
  const [assignmentReflectionDraft, setAssignmentReflectionDraft] = useState<AssignmentReflectionDraft>(emptyAssignmentReflectionDraft)
  const [assignmentKnowledgeDraft, setAssignmentKnowledgeDraft] = useState<string[]>([])
  const [deadlineEditorId, setDeadlineEditorId] = useState<string | null>(null)
  const [deadlineDraft, setDeadlineDraft] = useState('')
  const [deadlineRemindersEnabled, setDeadlineRemindersEnabled] = useState(() => localStorage.getItem('xuejing-deadline-reminders-v1') === 'true')
  const [deadlineNow, setDeadlineNow] = useState(() => new Date())
  const autoSyncAfterLogin = useRef(false)
  const autoSyncGradescopeAfterLogin = useRef(false)
  const knowledgeDocuments = useMemo(() => {
    const coursesById = new Map(study.courses.map((course) => [course.id, course]))
    return study.materials.filter((material) => material.localPath).map((material) => ({
      materialId: material.id,
      courseId: material.courseId,
      courseName: coursesById.get(material.courseId)?.name ?? '未分类课程',
      title: material.title,
      localPath: material.localPath!,
      type: material.type,
      knowledgeRole: materialKnowledgeRole(material),
    }))
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
      const result = await window.xuejing.knowledge.status({ documents: knowledgeDocuments })
      setKnowledgeIndex(result)
    } catch {
      // 知识库尚未建立或本地索引暂不可读时，保持空状态。
    }
  }, [knowledgeDocuments])

  const buildKnowledgeBase = async () => {
    if (!window.xuejing?.knowledge.build) return showToast('请在 Windows 桌面应用中构建知识库。')
    if (!knowledgeDocuments.length) return showToast('请先缓存或导入 PDF、PPTX 等课程资料。')
    setBusyKey('knowledge-build')
    setKnowledgeProgress({ completed: 0, total: knowledgeDocuments.length, title: '' })
    try {
      const result = await window.xuejing.knowledge.build({ documents: knowledgeDocuments })
      setKnowledgeIndex(result)
      showToast(`知识库已更新：解析 ${result.stats.parsed} 份资料，生成 ${result.stats.concepts} 个知识条目。`)
    } catch (error) {
      showToast(messageOf(error))
    } finally { setBusyKey(null) }
  }

  const runKnowledgeOcr = async (materialId: string) => {
    const api = window.xuejing?.knowledge
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
      showToast('AI 精炼完成：课程知识点已根据该资料更新。')
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }

  const runBatchCloudRefinement = async () => {
    const api = window.xuejing?.knowledge
    if (!activeKnowledgeCourseId) return showToast('请先在知识库顶部选择一门具体课程，再批量 AI 精炼。')
    if (!aiConfig.configured) {
      setShowAiSettings(true)
      return showToast('请先保存云端 API 配置。')
    }
    const materialIds = visibleKnowledgeDocuments
      .filter((document) => (document.status === 'parsed' || document.status === 'ocr') && document.knowledgeRole !== 'reference' && document.ai?.sourceHash !== document.hash)
      .map((document) => document.materialId)
    if (!materialIds.length) return showToast('当前课程没有需要 AI 精炼的已解析课件。')
    if (!window.confirm('将向云端发送当前课程的 ' + materialIds.length + ' 份已提取资料文本，用于生成知识点。是否继续？')) return
    if (!api?.refineBatch) return showToast('请在 Windows 桌面应用中使用 AI 精炼。')
    setBusyKey('refine-batch')
    setKnowledgeProgress({ completed: 0, total: materialIds.length, title: '正在批量请求云端 AI 精炼…' })
    try {
      const result = await api.refineBatch({ documents: knowledgeDocuments, materialIds })
      setKnowledgeIndex(result)
      showToast(result.batch.failed.length ? '批量 AI 精炼完成：成功 ' + result.batch.completed + ' 份，失败 ' + result.batch.failed.length + ' 份。' : '批量 AI 精炼完成：已精炼 ' + result.batch.completed + ' 份课件。')
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
      const result = await api.saveSettings({ baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiApiKey || undefined })
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
      const result = await api.testConnection({ baseUrl: aiConfig.baseUrl, model: aiConfig.model, apiKey: aiApiKey || undefined })
      setAiConnectionState({ kind: 'success', message: `连接正常：${result.model}，${result.latencyMs} ms` })
    } catch (error) {
      setAiConnectionState({ kind: 'error', message: messageOf(error) })
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
    if (!focusRunning) return
    const timer = window.setInterval(() => setFocusSeconds((current) => {
      if (current <= 1) {
        setFocusRunning(false)
        void window.xuejing?.deadlines.notify({ title: '番茄钟完成', body: '休息 5 分钟，再开始下一轮专注。' })
        return 25 * 60
      }
      return current - 1
    }), 1000)
    return () => window.clearInterval(timer)
  }, [focusRunning])

  useEffect(() => { void verifyCachedFiles() }, [verifyCachedFiles])
  useEffect(() => { void reconcileBlackboardCache() }, [reconcileBlackboardCache])
  useEffect(() => { void refreshKnowledgeStatus() }, [refreshKnowledgeStatus])
  useEffect(() => {
    let cancelled = false
    void window.xuejing?.ai?.settings().then((settings) => { if (!cancelled) setAiConfig(settings) })
    void window.xuejing?.credentials?.blackboard().then((settings) => { if (!cancelled) setBlackboardCredential(settings) })
    return () => { cancelled = true }
  }, [])

  useEffect(() => {
    if (selectedCourseId && study.courses.some((course) => course.id === selectedCourseId)) return
    setSelectedCourseId(study.courses[0]?.id ?? null)
  }, [selectedCourseId, study.courses])

  const syncBlackboard = useCallback(async () => {
    const api = window.xuejing?.blackboard
    if (!api) return showToast('请在 Windows 桌面应用中使用 Blackboard 同步。')
    setBusyKey('sync')
    try {
      const courseResult = await api.sync()
      setConnected(courseResult.connected)
      if (!courseResult.connected) return showToast(courseResult.message)
      if (!courseResult.courses.length) return showToast(courseResult.message)
      setBusyKey('scan')
      const materialResult = await api.syncMaterials(courseResult.courses)
      const courseMerge = mergeBlackboardCourses(study.courses, courseResult.courses)
      const materialMerge = mergeBlackboardMaterials(study.materials, courseMerge.courses, materialResult.materials.filter((material) => material.kind !== 'assignment'))
      const assignmentMerge = mergeBlackboardAssignments(study.assignments, courseMerge.courses, materialResult.materials
        .filter((material): material is typeof material & { url: string } => material.kind === 'assignment' && Boolean(material.url))
        .map((material) => ({ courseName: material.courseName, title: material.title, url: material.url, meta: material.meta, dueAt: material.dueAt, status: material.status, score: material.score, maxScore: material.maxScore })))
      setStudy((current) => ({ ...current, courses: courseMerge.courses, materials: materialMerge.materials, assignments: assignmentMerge.assignments }))
      const cachedUrls = new Set(study.materials.filter((material) => material.localPath && material.url).map((material) => material.url))
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
        setStudy((current) => ({ ...current, materials: applyCachedItems(current.materials, cacheResult.completed) }))
        if (cacheResult.completed[0]) setVaultRoot(cacheResult.completed[0].vaultRoot)
        showToast(`${materialResult.message}；自动缓存 ${cacheResult.completed.length} 份${cacheResult.failed.length ? `，${cacheResult.failed.length} 份失败` : ''}。`)
      } else {
        showToast(`${courseResult.message}；${materialResult.message}`)
      }
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }, [autoCacheEnabled, showToast, study.assignments, study.courses, study.materials])

  const syncGradescope = useCallback(async () => {
    const api = window.xuejing?.gradescope
    if (!api) return showToast('请在 Windows 桌面应用中使用 Gradescope 同步。')
    setBusyKey('gradescope-sync')
    try {
      const result = await api.sync()
      setGradescopeConnected(result.connected)
      if (!result.connected) return showToast(result.message)
      setStudy((current) => {
        const courseMerge = mergeGradescopeCourses(current.courses, result.courses)
        const assignmentMerge = mergeGradescopeAssignments(current.assignments, courseMerge.courses, result.assignments)
        return { ...current, courses: courseMerge.courses, assignments: assignmentMerge.assignments }
      })
      showToast(result.message)
    } catch (error) {
      showToast(messageOf(error))
    } finally {
      setBusyKey(null)
    }
  }, [showToast])

  useEffect(() => {
    const bridge = window.xuejing
    if (!bridge) {
      setVaultRoot('网页预览模式：资料库仅可在桌面应用中设置')
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
    void bridge.blackboard.status().then((result) => { if (!cancelled) setConnected(result.connected) })
    void bridge.gradescope.status().then((result) => { if (!cancelled) setGradescopeConnected(result.connected) })
    const dispose = bridge.blackboard.onConnectionChanged((status) => {
      if (cancelled) return
      setConnected(status.connected)
      if (status.connected && autoSyncAfterLogin.current) {
        autoSyncAfterLogin.current = false
        void syncBlackboard()
      }
    })
    const disposeGradescope = bridge.gradescope.onConnectionChanged((status) => {
      if (cancelled) return
      setGradescopeConnected(status.connected)
      if (status.connected && autoSyncGradescopeAfterLogin.current) {
        autoSyncGradescopeAfterLogin.current = false
        void syncGradescope()
      }
    })
    const disposeMigration = bridge.vault.onMigrationProgress((progress) => { if (!cancelled) setMigrationProgress(progress) })
    const disposeKnowledge = bridge.knowledge.onProgress((progress) => { if (!cancelled) setKnowledgeProgress(progress) })
    return () => { cancelled = true; dispose(); disposeGradescope(); disposeMigration(); disposeKnowledge() }
  }, [syncBlackboard, syncGradescope])

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
        const materials: Material[] = result.items.map((item) => ({
          id: item.id, courseId: course.id, title: item.title, type: item.type, source: '手动添加', meta: item.meta,
          concepts: [], localPath: item.localPath, path: item.path, folder: item.path.at(-1), kind: 'file', knowledgeRole: importKnowledgeRole,
        }))
        const incomingIds = new Set(materials.map((item) => item.id))
        return {
          ...current,
          courses: existing ? current.courses : [...current.courses, course],
          materials: [...current.materials.filter((item) => !incomingIds.has(item.id)), ...materials],
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
    if (!content) return showToast('先写下一点今天的收获或困难。')
    const today = new Date().toISOString().slice(0, 10)
    setStudy((current) => ({ ...current, journal: [{ id: `journal-${Date.now()}`, date: today, content, mood: journalMood }, ...current.journal] }))
    setJournalText('')
    showToast('今天的学习记录已保存。')
  }

  const selectedCourse = study.courses.find((course) => course.id === selectedCourseId) ?? null
  const libraryMaterials = useMemo(() => study.materials.filter((material) => material.kind !== 'assignment'), [study.materials])
  const selectedMaterials = useMemo(() => selectedCourse ? libraryMaterials.filter((material) => material.courseId === selectedCourse.id) : [], [libraryMaterials, selectedCourse])
  const selectedTree = useMemo(() => buildTree(selectedMaterials), [selectedMaterials])
  const pendingAssignments = useMemo(() => study.assignments.filter((assignment) => !assignmentCompleted(assignment)), [study.assignments])
  const assignmentCourses = useMemo(() => study.courses.filter((course) => study.assignments.some((assignment) => assignment.courseId === course.id)), [study.assignments, study.courses])
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
  const reflectionAssignment = useMemo(() => study.assignments.find((assignment) => assignment.id === assignmentReflectionId) ?? study.assignments[0] ?? null, [assignmentReflectionId, study.assignments])
  const reviewedAssignments = useMemo(() => study.assignments.filter((assignment) => assignment.reflection), [study.assignments])
  const reviewedScorePercents = useMemo(() => reviewedAssignments.map((assignment) => reflectionScorePercent(assignment.reflection)).filter((value): value is number => value !== undefined), [reviewedAssignments])
  const averageReviewedScore = reviewedScorePercents.length ? Math.round(reviewedScorePercents.reduce((sum, value) => sum + value, 0) / reviewedScorePercents.length) : null
  const courseNames = useMemo(() => new Map(study.courses.map((course) => [course.id, course.name])), [study.courses])
  const upcomingDeadlines = useMemo(() => pendingAssignments
    .filter((assignment) => deadlineState(assignment, deadlineNow) !== 'unknown')
    .sort((a, b) => new Date(assignmentDueAt(a)!).getTime() - new Date(assignmentDueAt(b)!).getTime())
    .slice(0, 6), [deadlineNow, pendingAssignments])
  const activeKnowledgeCourseId = knowledgeCourseFilter === 'all' ? null : knowledgeCourseFilter === 'current' ? selectedCourseId : knowledgeCourseFilter
  const visibleKnowledgeDocuments = useMemo(() => knowledgeIndex?.documents.filter((document) => !activeKnowledgeCourseId || document.courseId === activeKnowledgeCourseId) ?? [], [activeKnowledgeCourseId, knowledgeIndex])
  const visibleKnowledgeConcepts = useMemo(() => knowledgeIndex?.concepts.filter((concept) => !activeKnowledgeCourseId || concept.courseIds.includes(activeKnowledgeCourseId)) ?? [], [activeKnowledgeCourseId, knowledgeIndex])
  const knowledgeDocumentCounts = useMemo(() => visibleKnowledgeDocuments.reduce<Record<Exclude<KnowledgeDocumentFilter, 'all'>, number>>((counts, document) => {
    counts[knowledgeDocumentBucket(document)] += 1
    return counts
  }, { ready: 0, ocr: 0, unsupported: 0, failed: 0 }), [visibleKnowledgeDocuments])
  const displayedKnowledgeDocuments = useMemo(() => visibleKnowledgeDocuments
    .filter((document) => knowledgeDocumentFilter === 'all' || knowledgeDocumentBucket(document) === knowledgeDocumentFilter)
    .sort((left, right) => left.title.localeCompare(right.title, 'zh-CN', { numeric: true })), [knowledgeDocumentFilter, visibleKnowledgeDocuments])
  const activeReviewCourseId = reviewCourseFilter === 'current' ? selectedCourseId : reviewCourseFilter
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
  const reviewWeakCount = reviewConcepts.filter((concept) => (study.knowledgeRatings[concept.id] ?? 0) <= 2).length
  const reviewDaysLeft = reviewExamDate ? Math.max(1, Math.ceil((new Date(reviewExamDate + 'T23:59:59').getTime() - deadlineNow.getTime()) / 86_400_000)) : null
  const reviewDailyTarget = reviewDaysLeft ? Math.max(1, Math.ceil(reviewWeakCount / reviewDaysLeft)) : null
  const reviewWorkspaceDocuments = useMemo(() => {
    const sourceById = new Map(knowledgeDocuments.map((document) => [document.materialId, document]))
    const materialById = new Map(study.materials.map((material) => [material.id, material]))
    return reviewDocuments.filter((document) => document.status === 'parsed' || document.status === 'ocr').map((document) => ({ ...document, type: sourceById.get(document.materialId)?.type ?? '文件', path: materialById.get(document.materialId)?.path }))
  }, [knowledgeDocuments, reviewDocuments, study.materials])
  const reviewSelection = activeReviewCourseId ? study.reviewSelections[activeReviewCourseId] ?? { materialIds: [], conceptIds: [], focus: '' } : { materialIds: [], conceptIds: [], focus: '' }
  const reviewSession = activeReviewCourseId ? study.reviewSessions[activeReviewCourseId] ?? null : null

  useEffect(() => {
    if (!analyzedAssignment) {
      setAssignmentKnowledgeDraft([])
      return
    }
    const manual = analyzedAssignment.manualKnowledgeIds?.filter((id) => assignmentCourseConcepts.some((concept) => concept.id === id)) ?? []
    setAssignmentKnowledgeDraft(manual.length ? manual : assignmentAiMatch?.conceptIds ?? [])
  }, [analyzedAssignment?.id, assignmentCourseConcepts])

  useEffect(() => {
    setAssignmentReflectionDraft(reflectionDraftFrom(reflectionAssignment?.reflection))
  }, [reflectionAssignment?.id, reflectionAssignment?.reflection?.updatedAt])
  const saveReviewSelection = (next: typeof reviewSelection) => {
    if (!activeReviewCourseId) return showToast('请先选择一门具体课程，再保存复习内容。')
    setStudy((current) => ({ ...current, reviewSelections: { ...current.reviewSelections, [activeReviewCourseId]: next } }))
  }
  const saveReviewSession = (next: ReviewSession | null) => {
    if (!activeReviewCourseId) return
    setStudy((current) => {
      const reviewSessions = { ...current.reviewSessions }
      if (next) reviewSessions[activeReviewCourseId] = next
      else delete reviewSessions[activeReviewCourseId]
      return { ...current, reviewSessions }
    })
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

  const openMapDocumentInReview = (materialId: string, courseId: string) => {
    const conceptIds = (knowledgeIndex?.concepts ?? []).filter((concept) => concept.courseIds.includes(courseId) && concept.sourceIds.includes(materialId)).map((concept) => concept.id).slice(0, 8)
    setStudy((current) => ({
      ...current,
      reviewSelections: { ...current.reviewSelections, [courseId]: { materialIds: [materialId], conceptIds, focus: current.reviewSelections[courseId]?.focus ?? '' } },
      reviewSessions: { ...current.reviewSessions, [courseId]: { active: true, materialIds: [materialId], conceptIds, activeDocumentId: materialId, completedMaterialIds: current.reviewSessions[courseId]?.completedMaterialIds ?? [], startedAt: new Date().toISOString() } },
    }))
    setSelectedCourseId(courseId)
    setReviewCourseFilter(courseId)
    setSection('review')
  }

  const openAssignmentAnalysis = (assignment: Assignment) => {
    setAssignmentAnalysisId(assignment.id)
  }

  const saveAssignmentReflection = () => {
    if (!reflectionAssignment) return
    try {
      const reflection = normalizeAssignmentReflection(assignmentReflectionDraft, new Date().toISOString())
      setStudy((current) => ({
        ...current,
        assignments: current.assignments.map((assignment) => assignment.id === reflectionAssignment.id ? { ...assignment, reflection } : assignment),
      }))
      showToast(reflection ? '作业复盘已保存。成绩、反馈和自评会与平台信息分开保留。' : '已清除这份作业的手动复盘记录。')
    } catch (error) {
      showToast(messageOf(error))
    }
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
    setStudy((current) => ({
      ...current,
      assignments: current.assignments.map((assignment) => assignment.id === analyzedAssignment.id ? { ...assignment, manualKnowledgeIds: validIds.length ? validIds : undefined } : assignment),
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
    setStudy((current) => ({
      ...current,
      assignments: current.assignments.map((item) => item.id !== assignment.id ? item : {
        ...item,
        manualStatus: item.manualStatus === 'completed' ? undefined : 'completed',
      }),
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

  const navItems: { id: Section; label: string; icon: typeof BookOpen }[] = [
    { id: 'overview', label: '学习总览', icon: GraduationCap }, { id: 'library', label: '课程资料', icon: BookOpen },
    { id: 'assignments', label: '作业中心', icon: Send }, { id: 'knowledge', label: '知识库', icon: Network }, { id: 'map', label: '知识图谱', icon: Network }, { id: 'review', label: '期末复习', icon: Database }, { id: 'focus', label: '专注计时', icon: Timer }, { id: 'growth', label: '成长日记', icon: FileText },
  ]

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">径</span>学径</div>
        <div className="semester"><span className="eyebrow">学习聚合平台</span><strong>本学期</strong><span>从真实课程资料开始建立你的学习地图</span></div>
        <nav className="nav-list">
          {navItems.map(({ id, label, icon: Icon }) => <button key={id} className={`nav-item ${section === id ? 'active' : ''}`} onClick={() => setSection(id)}><Icon size={17} />{label}{id === 'library' && libraryMaterials.length ? <b>{libraryMaterials.length}</b> : id === 'assignments' && pendingAssignments.length ? <b>{pendingAssignments.length}</b> : null}</button>)}
        </nav>
        <div className="sidebar-bottom">
           <div className="source-control"><button className="source-state" onClick={connected ? syncBlackboard : connectBlackboard}>
            <i className={connected ? '' : 'offline'} /><span><strong>Blackboard</strong><small>{connected ? '已连接，点击同步' : '未连接，点击登录'}</small></span><RefreshCw size={14} />
           </button><button className="source-logout" onClick={disconnectBlackboard}>退出</button></div>
          <div className="source-control"><button className="source-state" onClick={gradescopeConnected ? syncGradescope : connectGradescope}>
            <i className={gradescopeConnected ? '' : 'offline'} /><span><strong>Gradescope</strong><small>{gradescopeConnected ? '已连接，点击同步作业' : '未连接，点击登录'}</small></span><RefreshCw size={14} />
           </button><button className="source-logout" onClick={disconnectGradescope}>退出</button></div>
          <button className="quiet-button" onClick={openBlackboardCredentials}><Settings2 size={16} />Blackboard 登录信息{blackboardCredential.configured ? '：已保存' : ''}</button>
          <button className={`quiet-button deadline-sidebar-toggle ${deadlineRemindersEnabled ? 'enabled-toggle' : ''}`} onClick={() => setDeadlineRemindersEnabled((enabled) => !enabled)}><Send size={16} />DDL 桌面提醒：{deadlineRemindersEnabled ? '开' : '关'}</button>
          <button className="quiet-button" onClick={chooseVault}><Settings2 size={16} />资料库位置</button>
        </div>
      </aside>
      <main className="main-content">
        <header className="topbar"><div className="topbar-title">{connected || gradescopeConnected ? `已连接：${[connected ? 'Blackboard' : '', gradescopeConnected ? 'Gradescope' : ''].filter(Boolean).join(' · ')}` : '等待连接 Blackboard 或 Gradescope'}</div><div className="top-actions"><button className="sync-button" disabled={busyKey === 'gradescope-sync'} onClick={gradescopeConnected ? syncGradescope : connectGradescope}><RefreshCw size={15} className={busyKey === 'gradescope-sync' ? 'spin' : ''} />{busyKey === 'gradescope-sync' ? '同步作业中…' : gradescopeConnected ? '同步 Gradescope' : '连接 Gradescope'}</button><button className="sync-button" disabled={busyKey === 'sync' || busyKey === 'scan'} onClick={syncBlackboard}><RefreshCw size={15} className={busyKey === 'sync' || busyKey === 'scan' ? 'spin' : ''} />{busyKey === 'sync' || busyKey === 'scan' ? '同步中…' : '同步 Blackboard'}</button><button className="primary-button" onClick={() => setShowImport(true)}><Upload size={15} />导入本地资料</button></div></header>
        <div className="content-scroll">
          {section === 'overview' && <section>
            <div className="page-heading"><div><span className="eyebrow">学习总览</span><h1>{study.courses.length ? '你的资料已经开始汇聚。' : '先把本学期的真实信息放进来。'}</h1><p>连接 Blackboard 后会自动读取课程与目录；也可以先手动导入电脑、微信或 QQ 中的资料。</p></div><button className="primary-button" onClick={connected ? syncBlackboard : connectBlackboard}>{connected ? <RefreshCw size={15} /> : <LogIn size={15} />}{connected ? '同步课程资料' : '连接 Blackboard'}</button></div>
            <div className="growth-stats"><div><span>课程</span><strong>{study.courses.length}</strong><small>来自同步或手动添加</small></div><div><span>已发现资料</span><strong>{study.materials.length}</strong><small>按 Blackboard 原目录收纳</small></div><div><span>本地缓存</span><strong>{cachedCount}</strong><small>{missingCount ? `${missingCount} 份文件缺失` : '已验证文件存在'}</small></div></div>
            <div className="panel deadline-overview"><div className="panel-title"><div><Send size={16} /><h2>近期 DDL</h2></div><div className="deadline-overview-actions"><span>{pendingAssignments.length} 个待处理</span><button className={deadlineRemindersEnabled ? 'reminders-on' : ''} onClick={() => setDeadlineRemindersEnabled((enabled) => !enabled)}>桌面提醒：{deadlineRemindersEnabled ? '开' : '关'}</button><button onClick={() => setSection('assignments')}>全部作业</button></div></div>{upcomingDeadlines.length ? <div className="deadline-overview-list">{upcomingDeadlines.map((assignment) => <article key={assignment.id}><span className={'deadline-dot ' + deadlineState(assignment, deadlineNow)} /><div><strong>{assignment.title}</strong><small>{courseNames.get(assignment.courseId) ?? assignment.sourceCourseName}</small></div><em className={deadlineState(assignment, deadlineNow)}>{deadlineLabel(assignment, deadlineNow)}</em><button onClick={() => openDeadlineEditor(assignment)}>设置</button></article>)}</div> : <p className="muted">暂未发现带有效截止时间的待处理作业。可在“作业中心”为 Blackboard 作业手动补充 DDL。</p>}</div>
            <div className="panel empty-action-panel"><Database size={26} /><div><h2>资料库：{vaultRoot}</h2><p>缓存和手动导入只复制文件到资料库，不会改动你电脑中已有的课程文件。</p></div><button className="outline-button" onClick={chooseVault}>选择位置</button></div>
          </section>}

          {section === 'library' && <section>
            <div className="page-heading"><div><span className="eyebrow">课程资料</span><h1>保持 Blackboard 的原始目录结构。</h1><p>这里仅收纳 Blackboard 与手动导入的课程资料；Gradescope 作业会在独立的“作业中心”按学期展示。自动缓存开启时，每次同步都会将新发现的 Blackboard 文件下载到本地资料库。</p></div><div className="library-actions"><button className={`outline-button ${autoCacheEnabled ? 'enabled-toggle' : ''}`} onClick={() => setAutoCacheEnabled((enabled) => !enabled)}><CloudDownload size={14} />自动缓存：{autoCacheEnabled ? '开' : '关'}</button><button className="outline-button" disabled={!selectedCourse || busyKey === 'cache-course'} onClick={cacheCurrentCourse}><CloudDownload size={14} />{busyKey === 'cache-course' ? '缓存中…' : '一键缓存本课程'}</button><button className="outline-button" onClick={syncBlackboard}><RefreshCw size={14} />同步</button><button className="primary-button" onClick={() => setShowImport(true)}><Plus size={15} />手动添加</button></div></div>
            <div className="vault-path" title={vaultRoot}>资料库：{vaultRoot}<button className="vault-repair" onClick={() => repairCachedExtensions()}>修复已缓存文件</button></div>
            {!study.courses.length ? <div className="empty-library"><BookOpen size={31} /><strong>还没有真实课程</strong><span>连接 Blackboard 同步，或手动导入一门课程的资料。</span><div><button className="primary-button" onClick={connectBlackboard}>连接 Blackboard</button><button className="outline-button inline-gap" onClick={() => setShowImport(true)}>导入本地资料</button></div></div> : <div className="library-explorer">
              <aside className="course-browser"><div className="browser-heading"><span>课程</span><small>{study.courses.length} 门</small></div>{study.courses.map((course) => <button className={selectedCourse?.id === course.id ? 'selected' : ''} onClick={() => setSelectedCourseId(course.id)} key={course.id}><i style={{ background: course.color }} /><span>{course.name}</span><small>{libraryMaterials.filter((material) => material.courseId === course.id).length}</small></button>)}</aside>
              <div className="tree-pane">{selectedCourse ? <><div className="tree-heading"><div><span className="eyebrow">课程资料</span><h2>{selectedCourse.name}</h2></div><span>{selectedMaterials.length} 个条目</span></div><div className="folder-tree">{selectedMaterials.length ? <MaterialTree node={selectedTree} course={selectedCourse} path={[]} expanded={expandedFolders} busyKey={busyKey} fileStates={fileStates} onToggle={toggleFolder} onCache={cacheMaterial} onOpenSubmission={openSubmission} onOpenLink={openLink} /> : <div className="empty-library compact"><Folder size={27} /><strong>该课程暂未发现资料</strong><span>可以再次同步 Blackboard，或手动导入这门课的文件。</span></div>}</div></> : null}</div>
            </div>}
          </section>}

          {section === 'assignments' && <section>
            {reflectionAssignment ? <div className="assignment-reflection-panel"><div className="assignment-reflection-head"><div><span className="eyebrow">作业复盘与学习诊断</span><h2>把成绩、反馈和自我感受留作复习证据</h2><p>平台成绩不会被覆盖；手动录入的分数、教师反馈和自评独立保存。知识点仍需你在“分析复习”中确认后才能带入复习。</p></div><label>选择作业<select value={assignmentReflectionId || reflectionAssignment.id} onChange={(event) => setAssignmentReflectionId(event.target.value)}>{study.assignments.map((assignment) => <option key={assignment.id} value={assignment.id}>{courseNames.get(assignment.courseId) ?? assignment.sourceCourseName} · {assignment.title}</option>)}</select></label></div><div className="assignment-reflection-stats"><div><span>平台成绩</span><strong>{reflectionAssignment.score !== undefined && reflectionAssignment.maxScore !== undefined ? `${reflectionAssignment.score}/${reflectionAssignment.maxScore}` : '未同步'}</strong><small>{reflectionAssignment.status === 'graded' ? '来自 Blackboard 或 Gradescope' : '可在下方补充成绩'}</small></div><div><span>已复盘作业</span><strong>{reviewedAssignments.length}</strong><small>{averageReviewedScore === null ? '尚无手动成绩记录' : `手动记录平均 ${averageReviewedScore}%`}</small></div><div><span>当前手动成绩</span><strong>{reflectionScorePercent(reflectionAssignment.reflection) === undefined ? '未记录' : `${reflectionScorePercent(reflectionAssignment.reflection)}%`}</strong><small>{reflectionAssignment.reflection?.updatedAt ? `更新于 ${new Date(reflectionAssignment.reflection.updatedAt).toLocaleDateString()}` : '可填写后保存'}</small></div></div><div className="assignment-reflection-form"><label>本次得分（可选）<input inputMode="decimal" value={assignmentReflectionDraft.score} onChange={(event) => setAssignmentReflectionDraft((current) => ({ ...current, score: event.target.value }))} placeholder="例如：86" /></label><label>本次满分（可选）<input inputMode="decimal" value={assignmentReflectionDraft.maxScore} onChange={(event) => setAssignmentReflectionDraft((current) => ({ ...current, maxScore: event.target.value }))} placeholder="例如：100" /></label><label className="reflection-wide">教师反馈 / 扣分原因（可选）<textarea value={assignmentReflectionDraft.feedback} onChange={(event) => setAssignmentReflectionDraft((current) => ({ ...current, feedback: event.target.value }))} placeholder="粘贴批注、评分意见或自己观察到的错误；它只保存在本机。" /></label><div className="reflection-wide self-assessment"><span>完成后的自我评估（可选）</span><div>{([{ value: 'confident', label: '掌握良好' }, { value: 'uncertain', label: '理解不稳' }, { value: 'needs_review', label: '需要复习' }] as const).map((item) => <button key={item.value} className={assignmentReflectionDraft.selfAssessment === item.value ? 'chosen' : ''} onClick={() => setAssignmentReflectionDraft((current) => ({ ...current, selfAssessment: current.selfAssessment === item.value ? '' : item.value }))}>{item.label}</button>)}</div></div><label className="reflection-wide">我的复盘笔记（可选）<textarea value={assignmentReflectionDraft.note} onChange={(event) => setAssignmentReflectionDraft((current) => ({ ...current, note: event.target.value }))} placeholder="例如：第三问卡在卷积性质，下一次先写出变换域关系。" /></label></div><div className="assignment-reflection-actions"><button className="outline-button" onClick={() => openAssignmentAnalysis(reflectionAssignment)}>确认关联知识点</button><button className="primary-button" onClick={saveAssignmentReflection}>保存复盘</button></div></div> : null}
            <div className="assignment-manual-entry"><div><strong>其他平台或线下作业</strong><span>手动填写题目说明、DDL 与链接后，可直接使用现有分析流程。</span></div><button className="primary-button" onClick={openManualAssignment}><Plus size={15} />手动添加作业</button></div>
            <div className="page-heading"><div><span className="eyebrow">统一作业中心</span><h1>按学期和课程集中管理待办与提交入口。</h1><p>Gradescope 会同步提交状态和成绩；Blackboard 作业也会汇入此处。默认仅显示待处理作业，已完成内容可随时展开查看。</p></div><div className="assignment-actions"><select value={assignmentCourseFilter} onChange={(event) => setAssignmentCourseFilter(event.target.value)}><option value="all">全部课程</option>{assignmentCourses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><button className={`outline-button ${showCompletedAssignments ? 'enabled-toggle' : ''}`} onClick={() => setShowCompletedAssignments((current) => !current)}>{showCompletedAssignments ? '隐藏已完成' : '查看已完成'}</button><button className="outline-button" disabled={busyKey === 'gradescope-sync'} onClick={gradescopeConnected ? syncGradescope : connectGradescope}><RefreshCw size={14} className={busyKey === 'gradescope-sync' ? 'spin' : ''} />{busyKey === 'gradescope-sync' ? '同步中…' : gradescopeConnected ? '同步 Gradescope' : '连接 Gradescope'}</button><button className="outline-button" disabled={busyKey === 'sync' || busyKey === 'scan'} onClick={connected ? syncBlackboard : connectBlackboard}><RefreshCw size={14} className={busyKey === 'sync' || busyKey === 'scan' ? 'spin' : ''} />{connected ? '同步 Blackboard' : '连接 Blackboard'}</button></div></div>
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
            <div className="page-heading"><div><span className="eyebrow">本地知识库</span><h1>先看每份资料的知识点，再汇总为课程知识。</h1><p>解析在本机完成。课件会生成可追溯的资料级知识点；教材和参考书只保留为参考来源，默认不扩充课程知识条目。</p></div><div className="knowledge-actions"><select className="knowledge-course-filter" value={knowledgeCourseFilter} onChange={(event) => setKnowledgeCourseFilter(event.target.value)}><option value="current">{selectedCourse ? "当前课程：" + selectedCourse.name : "当前课程（未选择）"}</option><option value="all">全部课程</option>{study.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><button className="outline-button" disabled={busyKey === "refine-batch" || !aiConfig.configured || !activeKnowledgeCourseId} onClick={runBatchCloudRefinement}>{busyKey === "refine-batch" ? "AI 精炼中…" : "批量 AI 精炼"}</button><button className="outline-button" disabled={busyKey === "ocr-batch" || !visibleKnowledgeDocuments.some((document) => document.status === "image")} onClick={runBatchOcr}>{busyKey === "ocr-batch" ? "批量 OCR 中…" : "批量 OCR"}</button><button className="primary-button" disabled={busyKey === "knowledge-build"} onClick={buildKnowledgeBase}><Network size={15} />{busyKey === "knowledge-build" ? "构建中…" : "构建 / 更新知识库"}</button><button className="outline-button" onClick={() => setShowAiSettings(true)}>AI 设置</button></div></div>
            <div className="growth-stats"><div><span>本地资料</span><strong>{knowledgeDocuments.length}</strong><small>已缓存或手动导入</small></div><div><span>已解析</span><strong>{knowledgeIndex?.stats.parsed ?? 0}</strong><small>{knowledgeIndex?.stats.unsupported ? (knowledgeIndex.stats.unsupported + " 份暂不支持") : "PDF、PPT/PPTX、DOCX、LaTeX 本地提取"}</small></div><div><span>课程知识点</span><strong>{knowledgeIndex?.stats.concepts ?? 0}</strong><small>{knowledgeIndex?.stats.reference ? (knowledgeIndex.stats.reference + " 份教材/参考资料未计入") : "仅由课件生成"}</small></div></div>
            {knowledgeProgress && ['knowledge-build', 'ocr-batch', 'refine-batch'].includes(busyKey ?? '') || knowledgeProgress && Boolean(busyKey?.startsWith('ocr:') || busyKey?.startsWith('refine:')) ? <div className="knowledge-progress"><span>{busyKey === 'refine-batch' || busyKey?.startsWith('refine:') ? `AI 精炼进度 ${knowledgeProgress.completed}/${knowledgeProgress.total}` : `正在处理 ${knowledgeProgress.completed}/${knowledgeProgress.total}`}</span><strong>{knowledgeProgress.title || "正在整理知识索引…"}</strong></div> : null}
            {visibleKnowledgeConcepts.length ? <div className="panel knowledge-graph-panel"><div className="panel-title"><div><h2>全景知识图谱</h2><p>资料级知识点、资料节点和课程知识点会在独立的可缩放地图中完整呈现，不再截断为少量条目。</p></div><button className="outline-button" onClick={() => { setMapCourseFilter(activeKnowledgeCourseId ?? 'all'); setSection('map') }}>打开知识图谱</button></div></div> : null}
            {!knowledgeDocuments.length ? <div className="empty-library"><Database size={31} /><strong>还没有可建立知识库的本地资料</strong><span>先在“课程资料”中缓存 Blackboard 文件或导入本地资料。</span><button className="primary-button" onClick={() => setSection("library")}>打开课程资料</button></div> : <div className="knowledge-layout"><div className="panel knowledge-panel"><div className="panel-title"><h2>资料级知识点</h2><span>{visibleKnowledgeDocuments.length} 份当前课程资料</span></div><div className="knowledge-document-filters"><button className={knowledgeDocumentFilter === 'ready' ? 'active' : ''} onClick={() => setKnowledgeDocumentFilter('ready')}>可用 {knowledgeDocumentCounts.ready}</button><button className={knowledgeDocumentFilter === 'ocr' ? 'active' : ''} onClick={() => setKnowledgeDocumentFilter('ocr')}>待 OCR {knowledgeDocumentCounts.ocr}</button><button className={knowledgeDocumentFilter === 'unsupported' ? 'active' : ''} onClick={() => setKnowledgeDocumentFilter('unsupported')}>暂不支持 {knowledgeDocumentCounts.unsupported}</button><button className={knowledgeDocumentFilter === 'failed' ? 'active' : ''} onClick={() => setKnowledgeDocumentFilter('failed')}>解析失败/无文本 {knowledgeDocumentCounts.failed}</button><button className={knowledgeDocumentFilter === 'all' ? 'active' : ''} onClick={() => setKnowledgeDocumentFilter('all')}>全部</button></div>{displayedKnowledgeDocuments.length ? <KnowledgeDocumentList documents={displayedKnowledgeDocuments} expanded={expandedKnowledgeDocuments} onToggle={toggleKnowledgeDocument} onRoleChange={changeKnowledgeRole} onOcr={runKnowledgeOcr} onRefine={runCloudRefinement} aiConfigured={aiConfig.configured} busyKey={busyKey} /> : <p className="muted">当前分类没有资料。可切换上方筛选查看待 OCR、暂不支持或解析失败的文件。</p>}</div><div className="panel knowledge-panel"><div className="panel-title"><h2>课程知识点</h2><span>{visibleKnowledgeConcepts.length} 个</span></div>{visibleKnowledgeConcepts.length ? <div className="knowledge-concept-list">{visibleKnowledgeConcepts.slice(0, 48).map((concept) => <article key={concept.id}><strong>{concept.title}</strong><span>{concept.sourceIds.length} 份课件来源 · {concept.courseIds.length} 门课程</span></article>)}</div> : <p className="muted">课程知识点由课件的资料级知识点汇总而来。教材不会自动扩大这个列表。</p>}</div></div>}
          </section>}

          {section === 'map' && <section><div className="page-heading"><div><span className="eyebrow">知识图谱</span><h1>在一张可自由移动的学习地图中浏览知识。</h1><p>课程概览默认不堆叠全部关系线；点击一个课程主题后，才展开它对应的资料和资料级主题。这样可以像 GraphRAG 一样从全局逐层进入局部证据。</p></div></div>{knowledgeIndex?.documents.length ? <KnowledgeMap documents={knowledgeIndex.documents} concepts={knowledgeIndex.concepts} ratings={study.knowledgeRatings} courseFilter={mapCourseFilter} onCourseFilterChange={setMapCourseFilter} onOpenDocument={openMapDocumentInReview} /> : <div className="panel empty-action-panel"><Network size={26} /><div><h2>还没有可绘制的知识图谱</h2><p>先在知识库中构建或更新课程资料。只有已解析或已 OCR 的资料会进入图谱。</p></div><button className="primary-button" onClick={() => setSection('knowledge')}>打开知识库</button></div>}</section>}

          {section === 'review' && <section><div className="page-heading"><div><span className="eyebrow">期末复习</span><h1>先选你真正要复习的内容，再进入专注会话。</h1><p>你可以手动勾选资料或知识点；若不选，系统会按自评、资料来源和期末日期生成建议路线。会话内提供资料阅读、AI 问答与番茄钟。</p></div><div className="review-controls"><select value={reviewCourseFilter} onChange={(event) => setReviewCourseFilter(event.target.value)}><option value="current">{selectedCourse ? '当前课程：' + selectedCourse.name : '当前课程（未选择）'}</option>{study.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select><label>期末日期<input type="date" value={reviewExamDate} onChange={(event) => setReviewExamDate(event.target.value)} /></label></div></div>{!activeReviewCourseId || !reviewWorkspaceDocuments.length ? <div className="panel empty-action-panel"><Network size={26} /><div><h2>{knowledgeIndex?.stats.parsed ? '当前课程还没有已解析资料' : '先构建本地知识库'}</h2><p>请先选择一门课程，并在知识库中构建解析结果。DOCX、旧版 PPT 与 LaTeX 也会在重新构建后纳入。</p></div><button className="primary-button" onClick={() => setSection('knowledge')}>打开知识库</button></div> : <><div className="growth-stats review-stats"><div><span>已自评</span><strong>{reviewRatedCount}/{reviewConcepts.length}</strong><small>用于系统规划，不会覆盖成绩</small></div><div><span>当前掌握度</span><strong>{reviewMastery}%</strong><small>来自你对知识点的真实判断</small></div><div><span>系统建议</span><strong>{reviewWeakCount}</strong><small>{reviewDailyTarget ? `距期末 ${reviewDaysLeft} 天，建议每天 ${reviewDailyTarget} 个` : '设置期末日期后拆分每日目标'}</small></div></div><ReviewWorkspace courseName={study.courses.find((course) => course.id === activeReviewCourseId)?.name ?? '当前课程'} documents={reviewWorkspaceDocuments} concepts={reviewConcepts} ratings={study.knowledgeRatings} selection={reviewSelection} session={reviewSession} onSelectionChange={saveReviewSelection} onSessionChange={saveReviewSession} onRate={setConceptRating} aiConfigured={aiConfig.configured} onOpenAiSettings={() => setShowAiSettings(true)} /></>}</section>}

          {section === 'focus' && <section><div className="page-heading"><div><span className="eyebrow">专注计时</span><h1>给当前学习留出一段不被打断的时间。</h1><p>期末复习会话内也有同一套番茄钟；这里提供独立入口，适合整理资料、阅读或完成作业时使用。</p></div></div><div className="focus-panel"><span className="eyebrow">番茄钟 · 25 分钟专注 / 5 分钟休息</span><strong>{String(Math.floor(focusSeconds / 60)).padStart(2, '0')}:{String(focusSeconds % 60).padStart(2, '0')}</strong><div><button className="primary-button" onClick={() => setFocusRunning((value) => !value)}>{focusRunning ? '暂停' : '开始专注'}</button><button className="outline-button" onClick={() => { setFocusRunning(false); setFocusSeconds(25 * 60) }}>重置</button><button className="outline-button" onClick={() => setSection('review')}>进入期末复习</button></div></div></section>}

          {section === 'growth' && <section><div className="page-heading"><div><span className="eyebrow">每日进步日记</span><h1>把今天实际学到的东西留下来。</h1><p>成长面板只使用你自己同步、导入和记录的数据，不再展示预填内容。</p></div></div><div className="growth-layout"><div className="journal-composer"><span className="eyebrow">今天的学习记录</span><h2>今天学到了什么？</h2><textarea value={journalText} onChange={(event) => setJournalText(event.target.value)} placeholder="例如：整理了第三周的课件，发现自己还需要复习……" /><div className="composer-footer"><div className="mood-picker">{(['轻松', '平稳', '吃力'] as JournalEntry['mood'][]).map((mood) => <button key={mood} className={journalMood === mood ? 'chosen' : ''} onClick={() => setJournalMood(mood)}>{mood}</button>)}</div><button className="primary-button" onClick={saveJournal}>保存记录</button></div></div><div className="panel trend-panel"><div className="panel-title"><h2>当前数据</h2></div><p className="muted">已记录 {study.journal.length} 天学习日记，已收纳 {study.materials.length} 个课程条目。随着资料解析和自评功能加入，这里会形成你的成长趋势。</p></div></div><div className="journal-list"><h2>记录</h2>{study.journal.length ? study.journal.map((entry) => <article key={entry.id}><div className="journal-date"><strong>{entry.date}</strong><span>{entry.mood}</span></div><p>{entry.content}</p></article>) : <p className="muted">还没有记录。写下第一条真实学习体验吧。</p>}</div></section>}
        </div>
      </main>
      {analyzedAssignment && <div className="modal-backdrop" onMouseDown={() => !['assignment-details:' + analyzedAssignment.id, 'assignment-files:' + analyzedAssignment.id, 'assignment-ai-match:' + analyzedAssignment.id, 'assignment-file-remove:' + analyzedAssignment.id].includes(busyKey ?? '') && setAssignmentAnalysisId(null)}><div className="modal assignment-analysis-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" disabled={['assignment-details:' + analyzedAssignment.id, 'assignment-files:' + analyzedAssignment.id, 'assignment-ai-match:' + analyzedAssignment.id, 'assignment-file-remove:' + analyzedAssignment.id].includes(busyKey ?? '')} onClick={() => setAssignmentAnalysisId(null)}><X size={16} /></button><span className="eyebrow">作业分析 · {courseNames.get(analyzedAssignment.courseId) ?? analyzedAssignment.sourceCourseName}</span><h2>{analyzedAssignment.title}</h2><p className="modal-note">Gradescope 作业请先在网页中自行下载 Original / Graded Copy，再添加作业文件。点击“AI 匹配知识点”时，应用会本地解析该附件，并仅把题目文本和候选知识点发送给 AI；建议必须由你确认。</p><div className="assignment-analysis-actions">{analyzedAssignment.source === 'Blackboard' ? <button className="outline-button" disabled={busyKey === 'assignment-details:' + analyzedAssignment.id} onClick={() => void readAssignmentDetails()}>{busyKey === 'assignment-details:' + analyzedAssignment.id ? '读取中…' : analyzedAssignment.detailsText ? '重新读取题目说明' : '从平台读取题目说明'}</button> : null}<button className="primary-button" disabled={(!analyzedAssignment.detailsText?.trim() && !analyzedAssignment.files?.length) || busyKey === 'assignment-ai-match:' + analyzedAssignment.id} onClick={() => void requestAssignmentAiMatch()}>{busyKey === 'assignment-ai-match:' + analyzedAssignment.id ? 'AI 匹配中…' : assignmentAiMatch ? '重新 AI 匹配' : 'AI 匹配知识点'}</button><button className="outline-button" onClick={() => openSubmission(analyzedAssignment.url)}>打开作业页面</button></div><div className="assignment-file-section"><div><strong>作业文件</strong><span>可在 Gradescope 下载 Original / Graded Copy 后添加；文件只复制到本地资料库。</span></div><button className="outline-button" disabled={busyKey === 'assignment-files:' + analyzedAssignment.id} onClick={() => void addAssignmentFiles()}>{busyKey === 'assignment-files:' + analyzedAssignment.id ? '添加中…' : '添加作业文件'}</button>{analyzedAssignment.files?.length ? <div className="assignment-file-list">{analyzedAssignment.files.map((file) => <article key={file.id}><FileText size={14} /><span><strong>{file.title}</strong><small>{file.type} · {new Date(file.addedAt).toLocaleDateString()}</small></span><button onClick={() => void openAssignmentFile(file.localPath)}>打开</button><button disabled={busyKey === 'assignment-file-remove:' + analyzedAssignment.id} onClick={() => void removeAssignmentFile(file)}>移除关联</button></article>)}</div> : <small className="assignment-file-empty">尚未添加文件。</small>}</div>{analyzedAssignment.detailsText ? <details className="assignment-details-text"><summary>已读取题目说明 · {analyzedAssignment.detailsFetchedAt ? new Date(analyzedAssignment.detailsFetchedAt).toLocaleString() : '本机缓存'}</summary><p>{analyzedAssignment.detailsText}</p></details> : <p className="assignment-analysis-hint">尚未提供网页题目说明。对于 Gradescope，请下载作业 PDF 后点击“添加作业文件”；系统会在你点击 AI 按钮时从附件本地提取文字，不会自行推荐知识点。</p>}{!knowledgeIndex ? <div className="assignment-analysis-empty"><strong>尚未构建本课程知识库</strong><span>请先缓存或导入课程资料，并在“知识库”中完成构建，再回来分析作业。</span><button className="primary-button" onClick={() => { setAssignmentAnalysisId(null); setKnowledgeCourseFilter(analyzedAssignment.courseId); setSection('knowledge') }}>打开知识库</button></div> : !assignmentCourseConcepts.length ? <div className="assignment-analysis-empty"><strong>当前课程没有可用知识点</strong><span>请在知识库中解析课件或检查资料是否被设为“教材/参考资料”。</span></div> : <><div className={'assignment-ai-result ' + (assignmentAiMatch ? 'ready' : assignmentAiMatchStale ? 'stale' : '')}><strong>{assignmentAiMatch ? 'AI 已给出待确认的知识点建议' : assignmentAiMatchStale ? '题目说明已更新，请重新让 AI 匹配' : '尚未请求 AI 匹配'}</strong><span>{assignmentAiMatch ? `模型：${assignmentAiMatch.model} · ${new Date(assignmentAiMatch.generatedAt).toLocaleString()}。请在下方核对后保存。` : assignmentAiMatchStale ? '旧的 AI 建议不会继续使用。' : '系统不会根据关键词、自评或课程薄弱项自行选择前置知识。'}</span>{assignmentAiMatch?.explanation ? <p>{assignmentAiMatch.explanation}</p> : null}</div><div className="assignment-concept-picker"><div><strong>确认作业相关知识点</strong><span>只有你勾选并保存的内容会成为该作业的人工映射。</span></div>{assignmentCourseConcepts.map((concept) => <label key={concept.id}><input type="checkbox" checked={assignmentKnowledgeDraft.includes(concept.id)} onChange={() => setAssignmentKnowledgeDraft((current) => current.includes(concept.id) ? current.filter((id) => id !== concept.id) : [...current, concept.id])} /><span>{concept.title}<small>{assignmentAiMatch?.conceptIds.includes(concept.id) ? 'AI 建议：请结合题目说明确认。' : `${concept.sourceIds.length} 份来源课件`}</small></span></label>)}</div><div className="assignment-analysis-footer"><button className="outline-button" onClick={() => saveAssignmentKnowledge([])}>清除人工映射</button><button className="outline-button" onClick={() => saveAssignmentKnowledge()}>确认并保存</button><button className="primary-button" disabled={!assignmentKnowledgeDraft.length} onClick={bringAssignmentKnowledgeToReview}>带入复习选择</button></div></>}</div></div>}
      {deadlineEditorId && <div className="modal-backdrop" onMouseDown={() => setDeadlineEditorId(null)}><div className="modal deadline-editor-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" onClick={() => setDeadlineEditorId(null)}><X size={16} /></button><span className="eyebrow">人工 DDL 修正</span><h2>设置截止时间</h2><p className="modal-note">人工设置会优先于平台同步值，适合 Blackboard 未提供 DDL 或你需要修正平台信息的情况。清空后将恢复使用平台值。</p><label>截止日期与时间<input type="datetime-local" value={deadlineDraft} onChange={(event) => setDeadlineDraft(event.target.value)} /></label><div className="deadline-editor-actions"><button className="outline-button" onClick={() => { setDeadlineDraft(''); saveManualDeadline('') }}>清除人工设置</button><button className="primary-button" onClick={() => saveManualDeadline()}>保存 DDL</button></div></div></div>}
      {showAiSettings && <div className="modal-backdrop" onMouseDown={() => !['ai-settings', 'ai-test'].includes(busyKey ?? '') && setShowAiSettings(false)}><div className="modal ai-settings-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" disabled={['ai-settings', 'ai-test'].includes(busyKey ?? '')} onClick={() => setShowAiSettings(false)}><X size={16} /></button><span className="eyebrow">可选云端 AI</span><h2>配置知识点精炼模型</h2><p className="modal-note">仅在你点击某一份资料的“AI 精炼”后，应用才会发送该资料的已提取文本；不会自动上传课程文件。连通性测试只发送一条最小文本请求，不会发送课程资料。</p><label>兼容 API 地址<input value={aiConfig.baseUrl} onChange={(event) => { setAiConfig((current) => ({ ...current, baseUrl: event.target.value })); setAiConnectionState(null) }} placeholder="例如：https://api.openai.com/v1" /></label><label>模型名称<input value={aiConfig.model} onChange={(event) => { setAiConfig((current) => ({ ...current, model: event.target.value })); setAiConnectionState(null) }} placeholder="例如：gpt-4.1-mini" /></label><label>API 密钥<input type="password" value={aiApiKey} onChange={(event) => { setAiApiKey(event.target.value); setAiConnectionState(null) }} placeholder={aiConfig.configured ? '留空则使用已加密保存的密钥' : '仅保存在系统安全存储中'} /></label>{aiConnectionState ? <div className={'ai-connection-state ' + aiConnectionState.kind}><span>{aiConnectionState.kind === 'testing' ? '正在测试' : aiConnectionState.kind === 'success' ? '连接成功' : '测试失败'}</span><strong>{aiConnectionState.message}</strong></div> : null}<div className="ai-settings-actions"><button className="outline-button" disabled={['ai-settings', 'ai-test'].includes(busyKey ?? '')} onClick={testAiConnection}>{busyKey === 'ai-test' ? '测试中…' : '测试连接'}</button><button className="primary-button" disabled={['ai-settings', 'ai-test'].includes(busyKey ?? '')} onClick={saveAiConfiguration}>{busyKey === 'ai-settings' ? '保存中…' : '加密保存配置'}</button></div></div></div>}
      {showBlackboardCredentials && <div className="modal-backdrop" onMouseDown={() => busyKey !== 'blackboard-credentials' && setShowBlackboardCredentials(false)}><div className="modal credential-settings-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" disabled={busyKey === 'blackboard-credentials'} onClick={() => setShowBlackboardCredentials(false)}><X size={16} /></button><span className="eyebrow">Blackboard 登录辅助</span><h2>保存学校账号</h2><p className="modal-note">账号和密码只会加密保存在当前 Windows 用户的系统安全存储中。点击“连接 Blackboard”时，应用只会自动填入统一认证页面；验证码、二次认证和最终登录仍由你本人完成。</p><label>账号<input autoComplete="username" value={blackboardCredential.username} onChange={(event) => setBlackboardCredential((current) => ({ ...current, username: event.target.value }))} placeholder="学校统一身份认证账号" /></label><label>密码<input autoComplete="current-password" type="password" value={blackboardPassword} onChange={(event) => setBlackboardPassword(event.target.value)} placeholder={blackboardCredential.configured ? '留空则保留已保存的密码' : '首次保存需要填写密码'} /></label><div className="credential-settings-actions"><button className="outline-button" disabled={busyKey === 'blackboard-credentials' || !blackboardCredential.configured} onClick={clearBlackboardCredentials}>删除已保存信息</button><button className="primary-button" disabled={busyKey === 'blackboard-credentials'} onClick={saveBlackboardCredentials}>{busyKey === 'blackboard-credentials' ? '保存中…' : '加密保存'}</button></div></div></div>}
      {showImport && <div className="modal-backdrop" onMouseDown={() => setShowImport(false)}><div className="modal material-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" onClick={() => setShowImport(false)}><X size={16} /></button><span className="eyebrow">手动导入</span><h2>把已有课程资料收纳进来</h2><p className="modal-note">会复制文件到资料库，保留原文件和你的修改；相同内容会自动去重。</p><label>已有课程<select value={importCourseId} onChange={(event) => setImportCourseId(event.target.value)}><option value="">新建课程…</option>{study.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>{!importCourseId && <label>新课程名称<input value={newCourseName} onChange={(event) => setNewCourseName(event.target.value)} placeholder="例如：机器学习导论" /></label>}<label>资料存放路径<input value={importPath} onChange={(event) => setImportPath(event.target.value)} placeholder="例如：微信资料/第3周" /></label><label>知识库用途<select value={importKnowledgeRole} onChange={(event) => setImportKnowledgeRole(event.target.value as 'courseware' | 'reference')}><option value="courseware">课件 / 讲义：生成课程知识点</option><option value="reference">教材 / 参考书：只作参考，不自动扩充词条</option></select></label><button className="primary-button wide" disabled={busyKey === 'import'} onClick={importLocalFiles}>{busyKey === 'import' ? '导入中…' : '选择文件并导入'}</button></div></div>}
      {showMigration && <div className="modal-backdrop" onMouseDown={() => busyKey !== 'migrate' && setShowMigration(false)}><div className="modal migration-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" disabled={busyKey === 'migrate'} onClick={() => setShowMigration(false)}><X size={16} /></button><span className="eyebrow">资料库迁移</span><h2>如何处理已有课程资料？</h2><p className="modal-note">旧位置：{vaultRoot}<br />新位置：{migrationTarget}</p>{migrationProgress && <div className="migration-progress"><span>正在处理 {migrationProgress.completed}/{migrationProgress.total}</span><strong>{migrationProgress.title || '正在完成…'}</strong></div>}<button className="primary-button wide" disabled={busyKey === 'migrate'} onClick={() => migrateVault('copy')}>复制到新位置（推荐）</button><button className="outline-button wide" disabled={busyKey === 'migrate'} onClick={() => migrateVault('move')}>迁移并删除已验证的旧副本</button><button className="text-button switch-vault-button" disabled={busyKey === 'migrate'} onClick={() => migrateVault('switch')}>仅切换位置，保留旧资料</button><p className="modal-note">复制或迁移都会逐个校验内容；同一文件不会重复复制。若有文件已被移动，资料页会显示“文件缺失”，可重新缓存。</p></div></div>}
      {showManualAssignment && <div className="modal-backdrop" onMouseDown={() => setShowManualAssignment(false)}><div className="modal manual-assignment-modal" onMouseDown={(event) => event.stopPropagation()}><button className="close" onClick={() => setShowManualAssignment(false)}><X size={16} /></button><span className="eyebrow">手动添加作业</span><h2>收纳其他来源的作业</h2><p className="modal-note">适用于课程群、微信、邮箱、线下布置或其他学习平台的作业。保存后会直接进入分析页面，可继续添加题目文件并让 AI 匹配课程知识点。</p><label>归属课程<select value={manualAssignmentCourseId} onChange={(event) => setManualAssignmentCourseId(event.target.value)}><option value="">新建课程…</option>{study.courses.map((course) => <option key={course.id} value={course.id}>{course.name}</option>)}</select></label>{!manualAssignmentCourseId && <label>新课程名称<input value={manualAssignmentCourseName} onChange={(event) => setManualAssignmentCourseName(event.target.value)} placeholder="例如：数据结构" /></label>}<label>作业名称<input autoFocus value={manualAssignmentTitle} onChange={(event) => setManualAssignmentTitle(event.target.value)} placeholder="例如：Homework 3 / 课程项目" /></label><label>截止日期与时间（可选）<input type="datetime-local" value={manualAssignmentDueAt} onChange={(event) => setManualAssignmentDueAt(event.target.value)} /></label><label>题目说明（可选）<textarea value={manualAssignmentDetails} onChange={(event) => setManualAssignmentDetails(event.target.value)} placeholder="粘贴老师发布的要求、题目或评分说明；保存后可直接用于 AI 匹配。" /></label><label>作业网页链接（可选）<input value={manualAssignmentUrl} onChange={(event) => setManualAssignmentUrl(event.target.value)} placeholder="https://…，可用于打开提交或查看页面" /></label><button className="primary-button wide" disabled={!manualAssignmentTitle.trim() || (!manualAssignmentCourseId && !manualAssignmentCourseName.trim())} onClick={saveManualAssignment}>保存并开始分析</button></div></div>}
      {toast && <div className="toast">{toast}</div>}
    </div>
  )
}
