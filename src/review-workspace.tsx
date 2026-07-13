import { Bot, Check, Clock3, ExternalLink, FileText, Maximize2, Minimize2, Pause, Play, RefreshCw, RotateCcw, Send, Sparkles, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DocumentViewer } from './document-viewer'
import { adaptiveQuestionCount, gradeQuickTest, parseQuickTest, type QuickTestRecord } from './quick-test'

export type ReviewDocument = {
  materialId: string
  title: string
  courseId: string
  courseName: string
  localPath: string
  type: string
  status: string
  path?: string[]
  outline?: string[]
  ai?: { concepts: { title: string; evidence: string }[] }
}

export type ReviewConcept = { id: string; title: string; sourceIds: string[]; courseIds: string[] }
export type ReviewSelection = { materialIds: string[]; conceptIds: string[]; focus: string; mode?: 'smart' | 'manual' }
export type MaterialAssessment = 1 | 2 | 3 | 4
export type ReviewSession = { active: boolean; materialIds: string[]; conceptIds: string[]; activeDocumentId?: string; completedMaterialIds: string[]; materialAssessments?: Record<string, MaterialAssessment>; materialAssessmentAt?: Record<string, string>; quickTests?: QuickTestRecord[]; startedAt: string }

type Rating = 0 | 1 | 2 | 3 | 4
type ChatMessage = { role: 'user' | 'assistant'; content: string }

const ratingText = ['未评估', '陌生', '模糊', '理解', '掌握']
const ratingPriority: Record<Rating, number> = { 0: 2, 1: 0, 2: 1, 3: 3, 4: 4 }

function normalized(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function toggle(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

export function selectedFirst<T>(items: T[], selectedIds: string[], idOf: (item: T) => string) {
  const order = new Map(selectedIds.map((id, index) => [id, index]))
  return [...items].sort((left, right) => {
    const leftOrder = order.get(idOf(left))
    const rightOrder = order.get(idOf(right))
    if (leftOrder === undefined && rightOrder === undefined) return 0
    if (leftOrder === undefined) return 1
    if (rightOrder === undefined) return -1
    return leftOrder - rightOrder
  })
}

export function originalFilename(document?: ReviewDocument) {
  return document?.title || document?.localPath.split(/[\\/]/).at(-1) || '未选择资料'
}

export function recordMaterialAssessment(session: ReviewSession, materialId: string, assessment: MaterialAssessment, assessedAt = new Date().toISOString()): ReviewSession {
  return { ...session, materialAssessments: { ...session.materialAssessments, [materialId]: assessment }, materialAssessmentAt: { ...session.materialAssessmentAt, [materialId]: assessedAt } }
}

export function finishReviewSession(session: ReviewSession, materialId?: string, assessment?: MaterialAssessment, assessedAt = new Date().toISOString()): ReviewSession {
  let next = { ...session, active: false }
  if (!materialId || assessment === undefined) return next
  if (!next.completedMaterialIds.includes(materialId)) next = { ...next, completedMaterialIds: [...next.completedMaterialIds, materialId] }
  return recordMaterialAssessment(next, materialId, assessment, assessedAt)
}

export function createReviewSession(materialIds: string[], conceptIds: string[], previous?: ReviewSession | null): ReviewSession {
  return {
    active: true,
    materialIds,
    conceptIds,
    activeDocumentId: materialIds[0],
    completedMaterialIds: [],
    materialAssessments: { ...(previous?.materialAssessments ?? {}) },
    materialAssessmentAt: { ...(previous?.materialAssessmentAt ?? {}) },
    quickTests: [...(previous?.quickTests ?? [])],
    startedAt: new Date().toISOString(),
  }
}

export function buildRoute(documents: ReviewDocument[], concepts: ReviewConcept[], ratings: Record<string, Rating>, selection: ReviewSelection, manual: boolean) {
  const conceptById = new Map(concepts.map((concept) => [concept.id, concept]))
  if (manual) {
    const selectedConcepts = selection.conceptIds
      .map((id) => conceptById.get(id))
      .filter((concept): concept is ReviewConcept => Boolean(concept))
    const sourceIds = new Set(selectedConcepts.flatMap((concept) => concept.sourceIds))
    selection.materialIds.forEach((id) => sourceIds.add(id))
    return { concepts: selectedConcepts, documents: documents.filter((document) => sourceIds.has(document.materialId)) }
  }

  const selectedConcepts = [...concepts]
    .sort((left, right) => ratingPriority[ratings[left.id] ?? 0] - ratingPriority[ratings[right.id] ?? 0] || right.sourceIds.length - left.sourceIds.length || left.title.localeCompare(right.title, 'zh-CN'))
    .slice(0, 10)
  const sourceIds = new Set(selectedConcepts.flatMap((concept) => concept.sourceIds))
  const selectedDocuments = documents.filter((document) => sourceIds.has(document.materialId))
  return { concepts: selectedConcepts, documents: selectedDocuments.length ? selectedDocuments : documents.slice(0, 1) }
}

function uniqueResolvedIds(value: unknown, candidateIds: string[], limit: number) {
  if (!Array.isArray(value)) return []
  const candidates = new Set(candidateIds)
  const result: string[] = []
  for (const raw of value) {
    if (typeof raw !== 'string') continue
    const id = raw.trim()
    if (!id) continue
    const direct = candidates.has(id) ? id : undefined
    const suffixMatches = direct ? [] : candidateIds.filter((candidate) => candidate.endsWith(`-${id}`))
    const resolved = direct ?? (suffixMatches.length === 1 ? suffixMatches[0] : undefined)
    if (resolved && !result.includes(resolved)) result.push(resolved)
    if (result.length >= limit) break
  }
  return result
}

export function extractPlan(value: string, documents: ReviewDocument[], concepts: ReviewConcept[]) {
  const raw = value.trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .match(/\{[\s\S]*\}/)?.[0]
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    const conceptIds = uniqueResolvedIds(parsed.conceptIds, concepts.map((concept) => concept.id), 12)
    const materialIds = uniqueResolvedIds(parsed.materialIds, documents.map((document) => document.materialId), 24)
    return conceptIds.length || materialIds.length
      ? { conceptIds, materialIds, explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '' }
      : null
  } catch {
    return null
  }
}

function Pomodoro({ focusMinutes, breakMinutes, onFocusComplete }: { focusMinutes: number; breakMinutes: number; onFocusComplete: () => void }) {
  const [phase, setPhase] = useState<'focus' | 'break'>('focus')
  const [seconds, setSeconds] = useState(focusMinutes * 60)
  const [running, setRunning] = useState(false)

  useEffect(() => {
    if (!running) setSeconds((phase === 'focus' ? focusMinutes : breakMinutes) * 60)
  }, [breakMinutes, focusMinutes, phase, running])

  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setSeconds((current) => {
      if (current <= 1) {
        const nextPhase = phase === 'focus' ? 'break' : 'focus'
        if (phase === 'focus') window.setTimeout(onFocusComplete, 0)
        setPhase(nextPhase)
        setRunning(false)
        return (nextPhase === 'focus' ? focusMinutes : breakMinutes) * 60
      }
      return current - 1
    }), 1000)
    return () => window.clearInterval(timer)
  }, [breakMinutes, focusMinutes, onFocusComplete, phase, running])

  const minutes = String(Math.floor(seconds / 60)).padStart(2, '0')
  const remainder = String(seconds % 60).padStart(2, '0')
  return <div className="pomodoro"><Clock3 size={15} /><span>{phase === 'focus' ? '专注' : '休息'}</span><strong>{minutes}:{remainder}</strong><button onClick={() => setRunning((value) => !value)}>{running ? <Pause size={14} /> : <Play size={14} />}{running ? '暂停' : '开始'}</button><button title="重置当前阶段" onClick={() => { setRunning(false); setSeconds((phase === 'focus' ? focusMinutes : breakMinutes) * 60) }}><RotateCcw size={13} /></button></div>
}

type WorkspaceProps = {
  courseName: string
  documents: ReviewDocument[]
  concepts: ReviewConcept[]
  ratings: Record<string, Rating>
  selection: ReviewSelection
  session: ReviewSession | null
  onSelectionChange: (next: ReviewSelection) => void
  onSessionChange: (next: ReviewSession | null) => void
  onRate: (conceptId: string, rating: Rating) => void
  aiConfigured: boolean
  onOpenAiSettings: () => void
  focusMinutes: number
  breakMinutes: number
}

export function ReviewWorkspace({ courseName, documents, concepts, ratings, selection, session, onSelectionChange, onSessionChange, onRate, aiConfigured, onOpenAiSettings, focusMinutes, breakMinutes }: WorkspaceProps) {
  const sessionRef = useRef<ReviewSession | null>(session)
  const [mode, setMode] = useState<'smart' | 'manual'>(selection.mode ?? 'smart')
  const [ratingFilter, setRatingFilter] = useState<'all' | Rating>('all')
  const [showAllRouteConcepts, setShowAllRouteConcepts] = useState(false)
  const [immersive, setImmersive] = useState(false)
  const [search, setSearch] = useState('')
  const [content, setContent] = useState<{ materialId: string; title: string; text: string; format: string } | null>(null)
  const [readerError, setReaderError] = useState('')
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messageDraft, setMessageDraft] = useState('')
  const [chatBusy, setChatBusy] = useState(false)
  const [planBusy, setPlanBusy] = useState(false)
  const [aiPlanText, setAiPlanText] = useState('')
  const [aiProposal, setAiProposal] = useState<{ conceptIds: string[]; materialIds: string[]; explanation: string } | null>(null)
  const [showExitAssessment, setShowExitAssessment] = useState(false)
  const [quizView, setQuizView] = useState<'closed' | 'scope' | 'test'>('closed')
  const [quizBusy, setQuizBusy] = useState(false)
  const [quizError, setQuizError] = useState('')
  const [activeQuickTestId, setActiveQuickTestId] = useState('')
  const [quizExitAfter, setQuizExitAfter] = useState(false)

  useEffect(() => { sessionRef.current = session }, [session])
  useEffect(() => { setMode(selection.mode ?? 'smart') }, [selection.mode])

  const conceptsByRating = useMemo(() => ratingFilter === 'all' ? concepts : concepts.filter((concept) => (ratings[concept.id] ?? 0) === ratingFilter), [concepts, ratingFilter, ratings])
  const ratingCounts = useMemo(() => ratingText.map((_label, rating) => concepts.filter((concept) => (ratings[concept.id] ?? 0) === rating).length), [concepts, ratings])
  const plannedRoute = useMemo(() => buildRoute(documents, conceptsByRating, ratings, selection, mode === 'manual'), [conceptsByRating, documents, mode, ratings, selection])
  const sessionSelection = useMemo<ReviewSelection>(() => session ? { materialIds: session.materialIds, conceptIds: session.conceptIds, focus: selection.focus } : selection, [selection, session])
  const sessionRoute = useMemo(() => buildRoute(documents, concepts, ratings, sessionSelection, true), [concepts, documents, ratings, sessionSelection])
  const active = Boolean(session?.active)
  const route = active ? sessionRoute : plannedRoute
  const activeDocument = route.documents.find((document) => document.materialId === session?.activeDocumentId) ?? route.documents[0]
  const activeQuickTest = session?.quickTests?.find((test) => test.id === activeQuickTestId) ?? session?.quickTests?.at(-1)
  const completed = new Set(session?.completedMaterialIds ?? [])
  const visibleDocuments = useMemo(() => selectedFirst(documents.filter((document) => selection.materialIds.includes(document.materialId) || normalized(`${document.title} ${originalFilename(document)}`).includes(normalized(search))), selection.materialIds, (document) => document.materialId), [documents, search, selection.materialIds])
  const visibleConcepts = useMemo(() => selectedFirst(conceptsByRating.filter((concept) => selection.conceptIds.includes(concept.id) || normalized(concept.title).includes(normalized(search))), selection.conceptIds, (concept) => concept.id), [conceptsByRating, search, selection.conceptIds])
  const routeConceptsToShow = showAllRouteConcepts ? conceptsByRating : plannedRoute.concepts.slice(0, 8)
  const proposalDocumentIds = useMemo(() => {
    if (!aiProposal) return []
    const selectedConcepts = new Map(concepts.map((concept) => [concept.id, concept]))
    const ids = new Set(aiProposal.materialIds)
    aiProposal.conceptIds.forEach((id) => selectedConcepts.get(id)?.sourceIds.forEach((sourceId) => ids.add(sourceId)))
    return documents.filter((document) => ids.has(document.materialId)).map((document) => document.materialId)
  }, [aiProposal, concepts, documents])

  const updateSelection = (patch: Partial<ReviewSelection>) => onSelectionChange({ ...selection, ...patch })
  const changeMode = (next: 'smart' | 'manual') => {
    setMode(next)
    updateSelection({ mode: next })
  }

  useEffect(() => {
    setShowAllRouteConcepts(false)
  }, [ratingFilter])

  useEffect(() => {
    if (!immersive) return
    const exitImmersive = (event: KeyboardEvent) => { if (event.key === 'Escape') setImmersive(false) }
    window.addEventListener('keydown', exitImmersive)
    return () => window.removeEventListener('keydown', exitImmersive)
  }, [immersive])

  useEffect(() => {
    if (!active) setImmersive(false)
  }, [active])

  useEffect(() => {
    if (!active || !activeDocument) return
    let cancelled = false
    setContent(null)
    setReaderError('')
    void window.xuejing?.knowledge.documentContent({ documents, materialId: activeDocument.materialId })
      .then((result) => { if (!cancelled) setContent(result) })
      .catch((error: unknown) => { if (!cancelled) setReaderError(error instanceof Error ? error.message : '无法读取资料内容') })
    return () => { cancelled = true }
  }, [active, activeDocument, documents])

  const begin = () => {
    if (mode === 'manual' && !selection.materialIds.length && !selection.conceptIds.length) return
    if (!plannedRoute.documents.length) return
    const next = createReviewSession(plannedRoute.documents.map((document) => document.materialId), plannedRoute.concepts.map((concept) => concept.id), session)
    sessionRef.current = next
    onSessionChange(next)
  }

  const resumePreviousSession = () => {
    if (!session || session.active) return
    const resumed = { ...session, active: true }
    sessionRef.current = resumed
    onSessionChange(resumed)
  }

  const setCurrentDocument = (materialId: string) => {
    if (session) onSessionChange({ ...session, activeDocumentId: materialId })
  }

  const toggleCompleted = () => {
    if (!session || !activeDocument) return
    const completedMaterialIds = completed.has(activeDocument.materialId)
      ? session.completedMaterialIds.filter((id) => id !== activeDocument.materialId)
      : [...session.completedMaterialIds, activeDocument.materialId]
    const updated = { ...session, completedMaterialIds }
    sessionRef.current = updated
    onSessionChange(updated)
  }

  const assessCurrentMaterial = (assessment: MaterialAssessment) => {
    if (!session || !activeDocument) return
    const updated = recordMaterialAssessment(session, activeDocument.materialId, assessment)
    sessionRef.current = updated
    onSessionChange(updated)
  }

  const finishSession = (assessment?: MaterialAssessment) => {
    const current = sessionRef.current
    if (!current) return
    setShowExitAssessment(false)
    const updated = finishReviewSession(current, activeDocument?.materialId, assessment)
    sessionRef.current = updated
    onSessionChange(updated)
  }

  const prepareExitQuickTest = (assessment: MaterialAssessment) => {
    if (!session || !activeDocument) return
    const updated = { ...finishReviewSession(session, activeDocument.materialId, assessment), active: true }
    sessionRef.current = updated
    onSessionChange(updated)
    setShowExitAssessment(false)
    setQuizExitAfter(true)
    setQuizView('scope')
  }

  const saveQuickTest = (record: QuickTestRecord) => {
    const current = sessionRef.current
    if (!current) return
    const quickTests = [...(current.quickTests ?? []).filter((test) => test.id !== record.id), record]
    const updated = { ...current, quickTests }
    sessionRef.current = updated
    onSessionChange(updated)
  }

  const startQuickTest = async (scope: 'session' | 'current' | 'weak') => {
    const currentSession = sessionRef.current
    if (!currentSession || !activeDocument) return
    if (!aiConfigured) { onOpenAiSettings(); return }
    const completedIds = currentSession.completedMaterialIds.length ? currentSession.completedMaterialIds : [activeDocument.materialId]
    const previousRemaining = currentSession.quickTests?.at(-1)?.remainingMaterialIds ?? []
    const orderedSessionIds = [...previousRemaining.filter((id) => completedIds.includes(id)), ...completedIds.filter((id) => !previousRemaining.includes(id))]
    const latestCompleted = [...(currentSession.quickTests ?? [])].reverse().find((test) => test.status === 'completed')
    const incorrectIds = latestCompleted?.questions.filter((question) => latestCompleted.answers[question.id] !== question.correctIndex).flatMap((question) => question.materialIds) ?? []
    const weakIds = [...new Set([...incorrectIds, ...(latestCompleted?.remainingMaterialIds ?? [])])].filter((id) => completedIds.includes(id))
    const targetIds = scope === 'current' ? [activeDocument.materialId] : scope === 'weak' && weakIds.length ? weakIds : orderedSessionIds
    const targetDocuments = documents.filter((document) => targetIds.includes(document.materialId))
    const unclearFiles = targetIds.filter((id) => (currentSession.materialAssessments?.[id] ?? 3) <= 2).length
    const weakConcepts = concepts.filter((concept) => currentSession.conceptIds.includes(concept.id) && (ratings[concept.id] ?? 0) > 0 && (ratings[concept.id] ?? 0) <= 2 && concept.sourceIds.some((id) => targetIds.includes(id)))
    const questionCount = adaptiveQuestionCount(targetDocuments.length, unclearFiles, weakConcepts.length)
    setQuizBusy(true)
    setQuizError('')
    setQuizView('test')
    try {
      const contents = await Promise.all(targetDocuments.map((document) => window.xuejing?.knowledge.documentContent({ documents, materialId: document.materialId })))
      const context = contents.filter(Boolean).map((content) => `[资料ID:${content!.materialId}] ${content!.title}\n${content!.text.slice(0, Math.max(3500, Math.floor(50000 / Math.max(1, targetDocuments.length))))}`).join('\n\n').slice(0, 60_000)
      const conceptLines = concepts.filter((concept) => concept.sourceIds.some((id) => targetIds.includes(id))).map((concept) => `[知识点ID:${concept.id}] ${concept.title}`).slice(0, 80).join('\n')
      const result = await window.xuejing?.ai.chat({ context, messages: [{ role: 'user', content: `请根据以上已复习资料生成 ${questionCount} 道快速检测题。题量已经根据资料数量、模糊资料和薄弱知识点计算，不要减少。只生成单选题或判断题，每题提供 2-4 个选项。优先覆盖这些薄弱知识点：${weakConcepts.map((concept) => concept.title).join('、') || '暂无明确薄弱项，请均衡覆盖主要主题'}。必须返回严格 JSON：{"questions":[{"prompt":"题目","options":["选项A","选项B"],"correctIndex":0,"explanation":"答案解释与来源说明","materialIds":["真实资料ID"],"conceptIds":["最直接相关的真实知识点ID"]}]}。materialIds 只能使用：${targetIds.join(', ')}。每道题只要能对应候选知识点，就必须填写至少一个 conceptIds；确实没有对应候选时才允许为空，不得编造 ID。知识点候选：\n${conceptLines}` }] })
      if (!result) throw new Error('当前环境不支持快速测试生成')
      const questions = parseQuickTest(result.content, targetIds, concepts.map((concept) => concept.id), questionCount)
      if (questions.length < Math.min(3, questionCount)) throw new Error('AI 返回的有效题目不足，请重试；无来源或格式错误的题目已被拦截')
      const coveredMaterialIds = new Set(questions.flatMap((question) => question.materialIds))
      const record: QuickTestRecord = { id: `quick-${Date.now()}`, scope, questionCount, questions, answers: {}, status: 'ready', remainingMaterialIds: targetIds.filter((id) => !coveredMaterialIds.has(id)), generatedAt: new Date().toISOString() }
      setActiveQuickTestId(record.id)
      saveQuickTest(record)
    } catch (error) {
      setQuizError(error instanceof Error ? error.message : String(error))
    } finally {
      setQuizBusy(false)
    }
  }

  const answerQuickTest = (questionId: string, answer: number) => {
    if (!activeQuickTest) return
    saveQuickTest({ ...activeQuickTest, answers: { ...activeQuickTest.answers, [questionId]: answer } })
  }

  const submitQuickTest = () => {
    if (!activeQuickTest) return
    saveQuickTest(gradeQuickTest(activeQuickTest, activeQuickTest.answers))
  }

  const closeQuickTest = () => {
    setQuizView('closed')
    setQuizError('')
    const current = sessionRef.current
    if (quizExitAfter && current) { const updated = { ...current, active: false }; sessionRef.current = updated; onSessionChange(updated) }
    setQuizExitAfter(false)
  }

  const retestWeakContent = () => {
    const current = sessionRef.current
    if (!current) return
    const resumed = { ...current, active: true }
    sessionRef.current = resumed
    onSessionChange(resumed)
    setQuizExitAfter(false)
    void startQuickTest('weak')
  }

  const sendChat = async () => {
    const question = messageDraft.trim()
    if (!question || chatBusy) return
    if (!aiConfigured) return onOpenAiSettings()
    const source = content?.text ?? ''
    if (!source) return setMessages((current) => [...current, { role: 'assistant', content: '请先选择并等待一份已解析资料加载完成，再向 AI 提问。' }])
    const next = [...messages, { role: 'user' as const, content: question }]
    setMessages(next)
    setMessageDraft('')
    setChatBusy(true)
    try {
      const result = await window.xuejing?.ai.chat({ context: source.slice(0, 60_000), messages: next })
      if (!result) throw new Error('当前环境不支持应用内 AI 对话')
      setMessages((current) => [...current, { role: 'assistant', content: result.content }])
    } catch (error) {
      setMessages((current) => [...current, { role: 'assistant', content: '请求失败：' + (error instanceof Error ? error.message : String(error)) }])
    } finally {
      setChatBusy(false)
    }
  }

  const askAiPlan = async () => {
    if (!aiConfigured) return onOpenAiSettings()
    if (!selection.focus.trim()) return setAiPlanText('请先写下你的复习重点，例如“重点理解卷积与变换的推导，不需要复习绪论”。')
    setPlanBusy(true)
    setAiProposal(null)
    try {
      const context = [
        '可选择的课程知识点（方括号中的完整 ID 是机器标识；来源资料 ID 可用于 materialIds）：',
        ...conceptsByRating.map((concept) => `[C:${concept.id}] ${concept.title}；来源资料：${concept.sourceIds.join(', ')}`),
      ].join('\n').slice(0, 60_000)
      const result = await window.xuejing?.ai.chat({
        context,
        messages: [{
          role: 'user',
          content: `我的复习重点是：${selection.focus}。请只返回 JSON，不要 Markdown：{"conceptIds":[最多 8 个完整 C: 后的 id，必须保留 concept- 前缀],"materialIds":[可选，完整来源资料 id，必须保留 bb-material- 等前缀],"explanation":"不超过 180 字的安排理由"}。只能选择给定的 id。`,
        }],
      })
      const response = result?.content ?? '未得到可用的 AI 规划结果。'
      const proposal = extractPlan(response, documents, concepts)
      setAiProposal(proposal)
      setAiPlanText(proposal?.explanation || (proposal ? 'AI 已选出复习内容。' : `AI 返回了方案，但没有识别到可用的知识点或资料。请重试；原始回答：\n${response}`))
    } catch (error) {
      setAiPlanText('AI 规划失败：' + (error instanceof Error ? error.message : String(error)))
    } finally {
      setPlanBusy(false)
    }
  }

  const applyAiProposal = () => {
    if (!aiProposal) return
    onSelectionChange({ ...selection, conceptIds: aiProposal.conceptIds, materialIds: proposalDocumentIds, mode: 'manual' })
    setMode('manual')
  }

  if (active) return <div className={'review-session' + (immersive ? ' immersive' : '')}>
    <div className="review-session-top">
      <div><span className="eyebrow">复习会话 · {courseName}</span><h2>{route.concepts.length} 个知识点 · {route.documents.length} 份资料 · 已完成 {completed.size}/{route.documents.length}</h2></div>
      <Pomodoro focusMinutes={focusMinutes} breakMinutes={breakMinutes} onFocusComplete={() => { void window.xuejing?.deadlines.notify({ title: '番茄钟完成', body: `休息 ${breakMinutes} 分钟，再继续当前复习会话。` }) }} />
      <div className="review-session-actions"><button className="outline-button" onClick={() => { setQuizExitAfter(false); setQuizView('scope') }}><Sparkles size={14} />快速测试</button><button className="outline-button" onClick={() => setImmersive((value) => !value)}>{immersive ? <Minimize2 size={14} /> : <Maximize2 size={14} />}{immersive ? '退出沉浸' : '沉浸模式'}</button><button className="outline-button" onClick={() => { setImmersive(false); setShowExitAssessment(true) }}><X size={14} />结束会话</button></div>
    </div>
    <div className="review-session-layout">
      <section className="review-reader">
        <div className="review-reader-tabs"><label><span>当前资料</span><select value={activeDocument?.materialId ?? ''} onChange={(event) => setCurrentDocument(event.target.value)}>{route.documents.map((document, index) => <option key={document.materialId} value={document.materialId}>{completed.has(document.materialId) ? '✓ ' : ''}{index + 1}. {originalFilename(document)}</option>)}</select></label><small>{activeDocument?.path?.join(' / ') || courseName}</small></div>
        <div className="review-reader-head"><div><span className="eyebrow">学径内阅读 · {activeDocument?.type?.toUpperCase()}</span><h3>{originalFilename(activeDocument)}</h3><small>资料标题：{activeDocument?.title}</small></div><div><button className={completed.has(activeDocument?.materialId ?? '') ? 'outline-button completed' : 'outline-button'} onClick={toggleCompleted}>{completed.has(activeDocument?.materialId ?? '') ? '已复习' : '标为已复习'}</button>{activeDocument?.localPath ? <button className="outline-button" onClick={() => void window.xuejing?.documents.openLocal(activeDocument.localPath)}><ExternalLink size={14} />原文件</button> : null}</div></div>
        {activeDocument && completed.has(activeDocument.materialId) ? <div className="material-quick-assessment"><div><strong>10 秒掌握确认</strong><span>只记录这份资料的学习感受，不会自动修改课程知识点自评。</span></div><div>{([[1, '没看懂'], [2, '有些模糊'], [3, '基本理解'], [4, '可以解释']] as [MaterialAssessment, string][]).map(([value, label]) => <button key={value} className={session?.materialAssessments?.[activeDocument.materialId] === value ? 'selected assessment-' + value : 'assessment-' + value} onClick={() => assessCurrentMaterial(value)}>{label}</button>)}</div></div> : null}
        {readerError ? <p className="review-reader-error">{readerError}</p> : <DocumentViewer document={activeDocument} documents={documents} fallbackText={content?.text} />}
      </section>
      <aside className="review-chat">
        <div className="review-chat-head"><div><Bot size={17} /><div><strong>课程问答</strong><span>{aiConfigured ? '独立于左侧阅读区，基于当前资料回答' : '请先配置 AI API，或使用网页版 AI'}</span></div></div><div><button title="打开 DeepSeek" onClick={() => void window.xuejing?.external.openUrl('https://chat.deepseek.com/')}>DeepSeek</button><button title="打开豆包" onClick={() => void window.xuejing?.external.openUrl('https://www.doubao.com/chat/')}>豆包</button></div></div>
        <div className="review-chat-messages">{messages.length ? messages.map((message, index) => <article className={message.role} key={index}>{message.content}</article>) : <p>无需滚到资料底部。可以直接提问“这份资料的重点是什么？”、“请解释当前主题的推导步骤”。</p>}</div>
        <div className="review-chat-compose"><textarea value={messageDraft} onChange={(event) => setMessageDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendChat() } }} placeholder="向当前资料提问…（Enter 发送，Shift+Enter 换行）" /><button disabled={chatBusy || !messageDraft.trim()} onClick={() => void sendChat()}>{chatBusy ? '思考中…' : <><Send size={14} />发送</>}</button></div>
      </aside>
    </div>
    {showExitAssessment ? <div className="review-exit-backdrop" onMouseDown={() => setShowExitAssessment(false)}><div className="review-exit-card" onMouseDown={(event) => event.stopPropagation()}><span className="eyebrow">结束前的 10 秒确认</span><h3>这份资料你现在掌握得怎么样？</h3><p>{originalFilename(activeDocument)}</p><div className="review-exit-options">{([[1, '没看懂'], [2, '有些模糊'], [3, '基本理解'], [4, '可以解释']] as [MaterialAssessment, string][]).map(([value, label]) => <button key={value} className={'assessment-' + value} onClick={() => prepareExitQuickTest(value)}>{label}</button>)}</div><button className="review-exit-skip" onClick={() => finishSession()}>暂不评估，直接结束</button><small>选择后可以进行本次会话的综合快速测试，也可以跳过测试并结束。</small></div></div> : null}
    {quizView === 'scope' ? <div className="review-exit-backdrop"><div className="review-exit-card quick-test-scope"><span className="eyebrow">3 分钟快速测试</span><h3>选择检测范围</h3><p>题量会根据资料数量、模糊资料和薄弱知识点自动调整，单轮 3～10 题。</p><div className="quick-test-scope-options"><button onClick={() => void startQuickTest('session')}><strong>本次复习会话</strong><small>检测已标记完成的全部资料，推荐</small></button><button onClick={() => void startQuickTest('current')}><strong>仅当前资料</strong><small>{originalFilename(activeDocument)}</small></button></div><button className="review-exit-skip" onClick={() => { if (quizExitAfter) finishSession(); else setQuizView('closed'); setQuizExitAfter(false) }}>{quizExitAfter ? '保存进度并结束，不进行测试' : '取消'}</button></div></div> : null}
    {quizView === 'test' ? <div className="review-exit-backdrop quick-test-backdrop"><div className="quick-test-card"><div className="quick-test-head"><div><span className="eyebrow">自适应快速测试</span><h3>{activeQuickTest ? `${activeQuickTest.questions.length} 道题 · ${activeQuickTest.scope === 'session' ? '本次会话' : activeQuickTest.scope === 'weak' ? '薄弱内容重测' : '当前资料'}` : '正在准备题目'}</h3></div><button onClick={closeQuickTest}><X size={16} /></button></div>{quizBusy ? <div className="quick-test-loading"><RefreshCw className="spin" size={20} /><strong>正在读取已完成资料并生成题目…</strong><span>应用会校验每道题的来源资料，越界题目不会显示。</span></div> : quizError ? <div className="quick-test-error"><strong>生成失败</strong><span>{quizError}</span><button className="outline-button" onClick={() => setQuizView('scope')}>重新选择范围</button></div> : activeQuickTest ? <><div className="quick-test-questions">{activeQuickTest.questions.map((question, index) => <article key={question.id}><div className="quick-test-question-title"><b>{index + 1}</b><strong>{question.prompt}</strong></div><div className="quick-test-options">{question.options.map((option, optionIndex) => { const chosen = activeQuickTest.answers[question.id] === optionIndex; const correct = activeQuickTest.status === 'completed' && optionIndex === question.correctIndex; const wrong = activeQuickTest.status === 'completed' && chosen && !correct; return <button key={optionIndex} disabled={activeQuickTest.status === 'completed'} className={`${chosen ? 'chosen' : ''} ${correct ? 'correct' : ''} ${wrong ? 'wrong' : ''}`} onClick={() => answerQuickTest(question.id, optionIndex)}><span>{String.fromCharCode(65 + optionIndex)}</span>{option}</button> })}</div>{activeQuickTest.status === 'completed' ? <div className="quick-test-explanation"><strong>{activeQuickTest.answers[question.id] === question.correctIndex ? '回答正确' : `正确答案：${String.fromCharCode(65 + question.correctIndex)}`}</strong><p>{question.explanation || '暂无补充解释'}</p><small>来源：{question.materialIds.map((id) => documents.find((document) => document.materialId === id)?.title ?? id).join('、')}</small></div> : null}</article>)}</div>{activeQuickTest.remainingMaterialIds?.length ? <div className="quick-test-remaining">本轮题量已达到快速测试上限，还有 {activeQuickTest.remainingMaterialIds.length} 份资料未被题目覆盖；下次生成会优先检测这些资料。</div> : null}<div className="quick-test-footer">{activeQuickTest.status === 'completed' ? <><div><span>本轮结果</span><strong>{activeQuickTest.score}%</strong><small>结果已保存在当前复习会话中</small></div><button className="primary-button" onClick={closeQuickTest}>{quizExitAfter ? '保存结果并结束会话' : '返回复习会话'}</button></> : <><span>已回答 {Object.keys(activeQuickTest.answers).length}/{activeQuickTest.questions.length}</span><button className="primary-button" disabled={Object.keys(activeQuickTest.answers).length < activeQuickTest.questions.length} onClick={submitQuickTest}>提交并查看结果</button></>}</div></> : null}</div></div> : null}
  </div>

  return <div className="review-workspace">
    <div className="review-workspace-head"><div className="review-mode-tabs"><button className={mode === 'smart' ? 'active' : ''} onClick={() => changeMode('smart')}><Sparkles size={14} />系统规划</button><button className={mode === 'manual' ? 'active' : ''} onClick={() => changeMode('manual')}><Check size={14} />自选内容</button></div><div className="review-start-actions">{session && !session.active ? <button className="outline-button" onClick={resumePreviousSession}><RotateCcw size={14} />继续上次会话</button> : null}<button className="primary-button" disabled={!plannedRoute.documents.length || (mode === 'manual' && !selection.materialIds.length && !selection.conceptIds.length)} onClick={begin}><Play size={15} />{session && !session.active ? '按当前选择开始新会话' : '开始复习会话'}</button></div></div>
    <div className="review-rating-categories"><strong>知识点自评分类</strong><button className={ratingFilter === 'all' ? 'active' : ''} onClick={() => setRatingFilter('all')}>全部 {concepts.length}</button>{ratingText.map((label, rating) => <button className={ratingFilter === rating ? 'active rating-' + rating : 'rating-' + rating} key={label} onClick={() => setRatingFilter(rating as Rating)}>{label} {ratingCounts[rating]}</button>)}</div>
    {mode === 'smart' ? <div className="review-smart-plan">
      <div><h2>系统建议复习路线</h2><p>系统默认优先显示低自评的重点路线。点击“查看全部”可浏览当前课程的全部知识点；每项也可直接修改自评。</p><textarea value={selection.focus} onChange={(event) => updateSelection({ focus: event.target.value })} placeholder="例如：重点看离散时间卷积，跳过已掌握的绪论；希望先复习作业相关知识。" /></div>
      <div className="review-route-list-wrap"><div className="review-route-list-head"><small>{showAllRouteConcepts ? `当前分类下全部 ${conceptsByRating.length} 个知识点` : `建议优先复习 ${routeConceptsToShow.length} 个知识点`}</small>{conceptsByRating.length > 8 ? <button onClick={() => setShowAllRouteConcepts((value) => !value)}>{showAllRouteConcepts ? '仅看推荐路线' : `查看全部 ${conceptsByRating.length} 项`}</button> : null}</div><div className={'review-route-list' + (showAllRouteConcepts ? ' expanded' : '')}>{routeConceptsToShow.map((concept, index) => <article key={concept.id}><span>{index + 1}</span><div><strong>{concept.title}</strong><small>{concept.sourceIds.length} 份资料</small></div><select aria-label={concept.title + '自评'} value={ratings[concept.id] ?? 0} onChange={(event) => onRate(concept.id, Number(event.target.value) as Rating)}>{ratingText.map((label, value) => <option value={value} key={label}>{label}</option>)}</select></article>)}</div></div>
      <button className="outline-button" disabled={planBusy} onClick={() => void askAiPlan()}>{planBusy ? 'AI 规划中…' : '根据偏好让 AI 选择'}</button>
      {aiPlanText ? <div className="review-ai-plan"><p>{aiPlanText}</p>{aiProposal ? <button className="primary-button" onClick={applyAiProposal}>一键应用 AI 选择（{aiProposal.conceptIds.length} 个知识点 · {proposalDocumentIds.length} 份课件）</button> : null}</div> : null}
    </div> : <>
      <div className="review-manual-plan"><div className="review-selection-head"><div><h2>选择本次要复习的内容</h2><p>可混选资料和知识点；已选内容会固定在各列表顶部，方便快速取消。系统会自动带上所选知识点的来源课件，并显示自评入口。</p></div><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索资料或知识点" /></div><div className="review-selection-grid"><section><div className="panel-title"><h3>资料</h3><span>{selection.materialIds.length} 已选 · 已选置顶</span></div>{visibleDocuments.map((document) => <label className={selection.materialIds.includes(document.materialId) ? 'selected' : ''} key={document.materialId}><input type="checkbox" checked={selection.materialIds.includes(document.materialId)} onChange={() => updateSelection({ materialIds: toggle(selection.materialIds, document.materialId) })} /><FileText size={14} /><span title={originalFilename(document)}>{document.path?.at(-1) ? document.path.at(-1) + ' · ' : ''}{originalFilename(document)}</span></label>)}</section><section><div className="panel-title"><h3>知识点与自评</h3><span>{selection.conceptIds.length} 已选 · 已选置顶 · 共 {visibleConcepts.length} 项</span></div>{visibleConcepts.map((concept) => <label className={'review-concept-choice' + (selection.conceptIds.includes(concept.id) ? ' selected' : '')} key={concept.id}><input type="checkbox" checked={selection.conceptIds.includes(concept.id)} onChange={() => updateSelection({ conceptIds: toggle(selection.conceptIds, concept.id) })} /><span>{concept.title}<small>{concept.sourceIds.length} 份资料来源</small></span><select aria-label={concept.title + '自评'} value={ratings[concept.id] ?? 0} onChange={(event) => onRate(concept.id, Number(event.target.value) as Rating)}>{ratingText.map((label, value) => <option value={value} key={label}>{label}</option>)}</select></label>)}</section></div></div>
      <div className="review-session-preview"><strong>本次会话：</strong>{plannedRoute.concepts.length} 个知识点、{plannedRoute.documents.length} 份已解析资料。{!selection.materialIds.length && !selection.conceptIds.length ? '请至少选择一项，或切换到系统规划。' : ''}</div>
    </>}
    {session?.quickTests?.length ? <div className="quick-test-history"><div className="panel-title"><div><Sparkles size={15} /><h2>快速测试历史</h2></div><span>{session.quickTests.length} 次</span></div><div>{[...session.quickTests].reverse().slice(0, 6).map((test) => { const wrong = test.status === 'completed' ? test.questions.filter((question) => test.answers[question.id] !== question.correctIndex).length : 0; return <article key={test.id}><div><strong>{new Date(test.generatedAt).toLocaleString()}</strong><small>{test.scope === 'session' ? '本次会话' : test.scope === 'weak' ? '薄弱内容重测' : '当前资料'} · {test.questions.length} 题 · {test.remainingMaterialIds?.length ?? 0} 份待覆盖</small></div><b>{test.status === 'completed' ? `${test.score}%` : '未完成'}</b><span>{wrong ? `${wrong} 道需巩固` : test.status === 'completed' ? '本轮全部正确' : '可以继续作答'}</span></article> })}</div><button className="outline-button" onClick={retestWeakContent}>重新测试错误与未覆盖内容</button></div> : null}
  </div>
}
