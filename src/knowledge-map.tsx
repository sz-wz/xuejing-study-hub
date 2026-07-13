import { Minus, Move, Plus, RotateCcw, Search } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { conceptEvidenceLabels, type ConceptEvidence } from './concept-evidence'

export type MapDocument = {
  materialId: string
  courseId: string
  courseName: string
  title: string
  status: string
  outline?: string[]
  ai?: { concepts: { title: string; evidence: string }[]; sourceHash?: string }
}

export type MapConcept = { id: string; title: string; sourceIds: string[]; courseIds: string[] }
type Rating = 0 | 1 | 2 | 3 | 4
type NodeKind = 'course' | 'document' | 'documentConcept' | 'courseConcept'

type MapNode = {
  id: string
  kind: NodeKind
  title: string
  subtitle: string
  x: number
  y: number
  radius: number
  courseId?: string
  documentId?: string
  conceptId?: string
}

type MapEdge = { from: string; to: string; kind: 'contains' | 'maps' }
type KnowledgeMapData = { nodes: MapNode[]; edges: MapEdge[]; bounds: { width: number; height: number }; nodeById: Map<string, MapNode> }

const palette = ['#4b7d66', '#55799f', '#9a6c49', '#7a689b', '#4d8990', '#aa627a']

function normalized(value: string) {
  return value.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function documentConcepts(document: MapDocument) {
  const candidates = document.ai?.concepts?.length ? document.ai.concepts.map((concept) => concept.title) : document.outline ?? []
  const seen = new Set<string>()
  return candidates.filter((title) => {
    const key = normalized(title)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, 8)
}

function buildLegacyKnowledgeMap(documents: MapDocument[], concepts: MapConcept[]): KnowledgeMapData {
  const parsedDocuments = documents.filter((document) => document.status === 'parsed' || document.status === 'ocr').sort((left, right) => left.courseName.localeCompare(right.courseName, 'zh-CN') || left.title.localeCompare(right.title, 'zh-CN', { numeric: true }))
  const courseIds = [...new Map(parsedDocuments.map((document) => [document.courseId, document.courseName])).entries()]
  const nodes: MapNode[] = []
  const edges: MapEdge[] = []
  let offsetY = 80

  for (let courseIndex = 0; courseIndex < courseIds.length; courseIndex += 1) {
    const [courseId, courseName] = courseIds[courseIndex]
    const courseDocuments = parsedDocuments.filter((document) => document.courseId === courseId)
    const courseConcepts = concepts.filter((concept) => concept.courseIds.includes(courseId))
    const documentColumns = 5
    const documentRows = Math.max(1, Math.ceil(courseDocuments.length / documentColumns))
    const conceptRows = Math.max(1, Math.ceil(courseConcepts.length / 2))
    const height = Math.max(420, documentRows * 170 + 180, conceptRows * 62 + 170)
    const courseNodeId = `course:${courseId}`
    nodes.push({ id: courseNodeId, kind: 'course', title: courseName, subtitle: `${courseDocuments.length} 份资料 · ${courseConcepts.length} 个课程知识点`, x: 125, y: offsetY + 90, radius: 30, courseId })

    const courseConceptByKey = new Map(courseConcepts.map((concept) => [normalized(concept.title), concept]))
    courseConcepts.forEach((concept, index) => {
      const column = Math.floor(index / conceptRows)
      const row = index % conceptRows
      const nodeId = `course-concept:${concept.id}`
      nodes.push({ id: nodeId, kind: 'courseConcept', title: concept.title, subtitle: `${concept.sourceIds.length} 份资料来源`, x: 350 + column * 190, y: offsetY + 100 + row * 62, radius: 13, courseId, conceptId: concept.id })
      edges.push({ from: courseNodeId, to: nodeId, kind: 'contains' })
    })

    courseDocuments.forEach((document, documentIndex) => {
      const column = documentIndex % documentColumns
      const row = Math.floor(documentIndex / documentColumns)
      const documentNodeId = `document:${document.materialId}`
      const x = 850 + column * 220
      const y = offsetY + 100 + row * 170
      nodes.push({ id: documentNodeId, kind: 'document', title: document.title, subtitle: '资料节点', x, y, radius: 15, courseId, documentId: document.materialId })
      edges.push({ from: courseNodeId, to: documentNodeId, kind: 'contains' })
      documentConcepts(document).forEach((title, conceptIndex) => {
        const documentConceptId = `document-concept:${document.materialId}:${conceptIndex}`
        const angle = (Math.PI * 2 * conceptIndex) / Math.max(1, documentConcepts(document).length) - Math.PI / 2
        const conceptX = x + Math.cos(angle) * 52
        const conceptY = y + 38 + Math.sin(angle) * 35
        nodes.push({ id: documentConceptId, kind: 'documentConcept', title, subtitle: document.title, x: conceptX, y: conceptY, radius: 7, courseId, documentId: document.materialId })
        edges.push({ from: documentNodeId, to: documentConceptId, kind: 'contains' })
        const courseConcept = courseConceptByKey.get(normalized(title))
        if (courseConcept) edges.push({ from: documentConceptId, to: `course-concept:${courseConcept.id}`, kind: 'maps' })
      })
    })
    offsetY += height + 140
  }

  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  return { nodes, edges, nodeById, bounds: { width: 850 + Math.max(1, 5) * 220 + 180, height: Math.max(620, offsetY) } }
}

export function prioritizeMapConcepts(concepts: MapConcept[], ratings: Record<string, Rating>, evidence: Record<string, ConceptEvidence> = {}) {
  const order: Record<Rating, number> = { 0: 2, 1: 0, 2: 1, 3: 3, 4: 4 }
  const evidenceOrder = { conflict: 0, test_weak: 1, self_weak: 2, unassessed: 3, developing: 4, verified: 5 }
  return [...concepts].sort((left, right) => (evidence[left.id] ? evidenceOrder[evidence[left.id].status] : order[ratings[left.id] ?? 0]) - (evidence[right.id] ? evidenceOrder[evidence[right.id].status] : order[ratings[right.id] ?? 0]) || right.sourceIds.length - left.sourceIds.length || left.title.localeCompare(right.title, 'zh-CN'))
}

export function buildKnowledgeMap(documents: MapDocument[], concepts: MapConcept[], focusConceptId: string | null, overviewOnly = false): KnowledgeMapData {
  const parsedDocuments = documents.filter((document) => document.status === 'parsed' || document.status === 'ocr').sort((left, right) => left.courseName.localeCompare(right.courseName, 'zh-CN') || left.title.localeCompare(right.title, 'zh-CN', { numeric: true }))
  const nodes: MapNode[] = []
  const edges: MapEdge[] = []

  if (focusConceptId) {
    const concept = concepts.find((item) => item.id === focusConceptId)
    if (concept) {
      const sourceDocuments = parsedDocuments.filter((document) => concept.sourceIds.includes(document.materialId)).slice(0, 12)
      const centerId = `course-concept:${concept.id}`
      nodes.push({ id: centerId, kind: 'courseConcept', title: concept.title, subtitle: `${sourceDocuments.length} 份来源资料 · 点击“返回概览”可浏览其它主题`, x: 480, y: 340, radius: 28, courseId: concept.courseIds[0], conceptId: concept.id })
      sourceDocuments.forEach((document, index) => {
        const angle = (Math.PI * 2 * index) / Math.max(1, sourceDocuments.length) - Math.PI / 2
        const radius = Math.max(180, Math.min(330, 150 + sourceDocuments.length * 18))
        const x = 480 + Math.cos(angle) * radius
        const y = 340 + Math.sin(angle) * radius
        const documentId = `document:${document.materialId}`
        nodes.push({ id: documentId, kind: 'document', title: document.title, subtitle: '该主题的来源资料', x, y, radius: 17, courseId: document.courseId, documentId: document.materialId })
        edges.push({ from: centerId, to: documentId, kind: 'maps' })
        const themes = documentConcepts(document).filter((title) => normalized(title) !== normalized(concept.title)).slice(0, 3)
        themes.forEach((title, themeIndex) => {
          const childAngle = angle + (themeIndex - (themes.length - 1) / 2) * .38
          const childId = `document-concept:${document.materialId}:${themeIndex}`
          nodes.push({ id: childId, kind: 'documentConcept', title, subtitle: document.title, x: x + Math.cos(childAngle) * 75, y: y + Math.sin(childAngle) * 75, radius: 8, courseId: document.courseId, documentId: document.materialId })
          edges.push({ from: documentId, to: childId, kind: 'contains' })
        })
      })
    }
  } else if (overviewOnly) {
    const courses = [...new Map(parsedDocuments.map((document) => [document.courseId, document.courseName])).entries()]
    courses.forEach(([courseId, courseName], courseIndex) => {
      const courseConcepts = concepts.filter((concept) => concept.courseIds.includes(courseId))
      const column = courseIndex % 3
      const row = Math.floor(courseIndex / 3)
      const centerX = 230 + column * 330
      const centerY = 180 + row * 250
      const courseIdNode = `course:${courseId}`
      nodes.push({ id: courseIdNode, kind: 'course', title: courseName, subtitle: `${parsedDocuments.filter((document) => document.courseId === courseId).length} 份资料 · ${courseConcepts.length} 个主题 · 点击进入`, x: centerX, y: centerY, radius: 36, courseId })
    })
  } else {
    const [courseId, courseName] = [...new Map(parsedDocuments.map((document) => [document.courseId, document.courseName])).entries()][0] ?? ['', '当前课程']
    const centerX = 500
    const centerY = 390
    const courseIdNode = `course:${courseId}`
    nodes.push({ id: courseIdNode, kind: 'course', title: courseName, subtitle: `${parsedDocuments.length} 份资料 · 当前显示 ${concepts.length} 个主题`, x: centerX, y: centerY, radius: 34, courseId })
    concepts.forEach((concept, index) => {
      const ring = index < 8 ? 0 : index < 20 ? 1 : 2
      const start = ring === 0 ? 0 : ring === 1 ? 8 : 20
      const ringCount = ring === 0 ? Math.min(8, concepts.length) : ring === 1 ? Math.min(12, Math.max(0, concepts.length - 8)) : Math.max(1, concepts.length - 20)
      const angle = (Math.PI * 2 * (index - start)) / Math.max(1, ringCount) - Math.PI / 2 + ring * .12
      const radius = 145 + ring * 105
      const nodeId = `course-concept:${concept.id}`
      nodes.push({ id: nodeId, kind: 'courseConcept', title: concept.title, subtitle: `${concept.sourceIds.length} 份资料来源 · 点击展开局部溯源`, x: centerX + Math.cos(angle) * radius, y: centerY + Math.sin(angle) * radius, radius: 12, courseId, conceptId: concept.id })
      edges.push({ from: courseIdNode, to: nodeId, kind: 'contains' })
    })
  }
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const maxX = nodes.length ? Math.max(...nodes.map((node) => node.x)) + 420 : 960
  const maxY = nodes.length ? Math.max(...nodes.map((node) => node.y)) + 420 : 680
  return { nodes, edges, nodeById, bounds: { width: Math.max(960, maxX), height: Math.max(680, maxY) } }
}

function nodeColor(node: MapNode, ratings: Record<string, Rating>, evidence: Record<string, ConceptEvidence>) {
  if (node.kind === 'course') return palette[Math.abs([...node.courseId ?? ''].reduce((sum, value) => sum + value.charCodeAt(0), 0)) % palette.length]
  if (node.kind === 'document') return '#c97b61'
  if (node.kind === 'documentConcept') return '#d4ab48'
  const status = node.conceptId ? evidence[node.conceptId]?.status : undefined
  if (status) return { unassessed: '#9ba9a0', self_weak: '#d38a58', test_weak: '#d45f5f', conflict: '#9a63b1', verified: '#4f9a6c', developing: '#6788b5' }[status]
  const rating = node.conceptId ? ratings[node.conceptId] ?? 0 : 0
  return ['#9ba9a0', '#c87a61', '#c6a04b', '#5f9b73', '#6586b7'][rating]
}

function shortLabel(value: string, limit: number) {
  return value.length > limit ? value.slice(0, Math.max(1, limit - 1)) + '…' : value
}

function initialView(canvas: HTMLCanvasElement, bounds: KnowledgeMapData['bounds']) {
  const padding = 48
  const scale = Math.min(0.75, Math.max(0.055, Math.min((canvas.clientWidth - padding) / bounds.width, (canvas.clientHeight - padding) / Math.min(bounds.height, 1700))))
  return { x: padding / 2, y: padding / 2, scale }
}

type CanvasProps = { data: KnowledgeMapData; ratings: Record<string, Rating>; evidence: Record<string, ConceptEvidence>; selectedId: string | null; onSelect: (id: string) => void }

function MapCanvas({ data, ratings, evidence, selectedId, onSelect }: CanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const viewRef = useRef({ x: 28, y: 28, scale: 0.45 })
  const pointerRef = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const drawFrameRef = useRef<number | null>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ratio = window.devicePixelRatio || 1
    const width = canvas.clientWidth
    const height = canvas.clientHeight
    if (!width || !height) return
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio)
      canvas.height = Math.round(height * ratio)
    }
    const context = canvas.getContext('2d')
    if (!context) return
    context.setTransform(ratio, 0, 0, ratio, 0, 0)
    context.clearRect(0, 0, width, height)
    context.fillStyle = '#fbfcfa'
    context.fillRect(0, 0, width, height)
    const view = viewRef.current
    const minX = -view.x / view.scale - 90
    const minY = -view.y / view.scale - 90
    const maxX = (width - view.x) / view.scale + 90
    const maxY = (height - view.y) / view.scale + 90
    const visible = (node: MapNode) => node.x >= minX && node.x <= maxX && node.y >= minY && node.y <= maxY

    context.save()
    context.translate(view.x, view.y)
    context.scale(view.scale, view.scale)
    context.lineWidth = Math.max(0.45, 1.1 / view.scale)
    for (const edge of data.edges) {
      const from = data.nodeById.get(edge.from)
      const to = data.nodeById.get(edge.to)
      if (!from || !to || (!visible(from) && !visible(to))) continue
      context.strokeStyle = edge.kind === 'maps' ? 'rgba(83, 136, 104, .40)' : 'rgba(168, 187, 171, .45)'
      context.beginPath()
      context.moveTo(from.x, from.y)
      context.lineTo(to.x, to.y)
      context.stroke()
    }
    for (const node of data.nodes) {
      if (!visible(node)) continue
      const selected = node.id === selectedId
      context.beginPath()
      context.fillStyle = nodeColor(node, ratings, evidence)
      context.globalAlpha = node.kind === 'documentConcept' ? 0.78 : 1
      context.arc(node.x, node.y, node.radius + (selected ? 3 : 0), 0, Math.PI * 2)
      context.fill()
      context.globalAlpha = 1
      const conceptEvidence = node.conceptId ? evidence[node.conceptId] : undefined
      if (node.kind === 'courseConcept' && conceptEvidence?.latestTestScore !== null && conceptEvidence?.latestTestScore !== undefined) {
        context.strokeStyle = conceptEvidence.latestTestScore >= 80 ? '#276b48' : conceptEvidence.latestTestScore < 70 ? '#8f3030' : '#465f87'
        context.lineWidth = Math.max(1, 2 / view.scale)
        context.stroke()
      }
      if (selected) {
        context.strokeStyle = '#13271e'
        context.lineWidth = Math.max(1.5, 2.5 / view.scale)
        context.stroke()
      }
      if (view.scale >= 0.34 && (node.kind !== 'documentConcept' || view.scale >= 0.65)) {
        context.fillStyle = '#3f564a'
        context.font = `${node.kind === 'course' ? 600 : 500} ${Math.max(10, Math.min(14, 12 / view.scale))}px "Noto Sans SC", sans-serif`
        context.fillText(shortLabel(node.title, node.kind === 'documentConcept' ? 14 : 24), node.x + node.radius + 7, node.y + 4)
      }
    }
    context.restore()
  }, [data, evidence, ratings, selectedId])

  const requestDraw = useCallback(() => {
    if (drawFrameRef.current !== null) return
    drawFrameRef.current = window.requestAnimationFrame(() => {
      drawFrameRef.current = null
      draw()
    })
  }, [draw])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    viewRef.current = initialView(canvas, data.bounds)
    const observer = new ResizeObserver(() => requestDraw())
    observer.observe(canvas)
    requestDraw()
    return () => { observer.disconnect(); if (drawFrameRef.current !== null) window.cancelAnimationFrame(drawFrameRef.current) }
  }, [data.bounds, requestDraw])

  useEffect(() => { requestDraw() }, [requestDraw])

  const zoom = (factor: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const view = viewRef.current
    const nextScale = Math.min(2.4, Math.max(0.045, view.scale * factor))
    const centerX = canvas.clientWidth / 2
    const centerY = canvas.clientHeight / 2
    view.x = centerX - (centerX - view.x) * (nextScale / view.scale)
    view.y = centerY - (centerY - view.y) * (nextScale / view.scale)
    view.scale = nextScale
    requestDraw()
  }

  const selectAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const view = viewRef.current
    const x = (clientX - rect.left - view.x) / view.scale
    const y = (clientY - rect.top - view.y) / view.scale
    const match = [...data.nodes].reverse().find((node) => Math.hypot(node.x - x, node.y - y) <= Math.max(node.radius + 8, 14 / view.scale))
    if (match) onSelect(match.id)
  }

  return <div className="knowledge-map-canvas-wrap"><canvas ref={canvasRef} className="knowledge-map-canvas" onPointerDown={(event) => { event.currentTarget.setPointerCapture(event.pointerId); pointerRef.current = { x: event.clientX, y: event.clientY, moved: false } }} onPointerMove={(event) => { const pointer = pointerRef.current; if (!pointer) return; const dx = event.clientX - pointer.x; const dy = event.clientY - pointer.y; if (Math.abs(dx) + Math.abs(dy) > 2) pointer.moved = true; viewRef.current.x += dx; viewRef.current.y += dy; pointer.x = event.clientX; pointer.y = event.clientY; requestDraw() }} onPointerUp={(event) => { const pointer = pointerRef.current; pointerRef.current = null; if (!pointer?.moved) selectAt(event.clientX, event.clientY) }} onWheel={(event) => { event.preventDefault(); zoom(event.deltaY < 0 ? 1.13 : .88) }} />
    <div className="knowledge-map-tools"><button onClick={() => zoom(1.2)} title="放大"><Plus size={16} /></button><button onClick={() => zoom(.82)} title="缩小"><Minus size={16} /></button><button onClick={() => { const canvas = canvasRef.current; if (canvas) { viewRef.current = initialView(canvas, data.bounds); requestDraw() } }} title="适配画布"><RotateCcw size={15} /></button></div>
    <div className="knowledge-map-hint"><Move size={14} />拖拽移动 · 滚轮缩放 · 点击节点查看详情</div>
  </div>
}

export function KnowledgeMap({ documents, concepts, ratings, evidence, courseFilter, onCourseFilterChange, onOpenDocument, onReviewConcept }: { documents: MapDocument[]; concepts: MapConcept[]; ratings: Record<string, Rating>; evidence: Record<string, ConceptEvidence>; courseFilter: string; onCourseFilterChange: (value: string) => void; onOpenDocument: (documentId: string, courseId: string) => void; onReviewConcept: (conceptId: string, courseId: string) => void }) {
  const courseOptions = useMemo(() => [...new Map(documents.map((document) => [document.courseId, document.courseName])).entries()].sort((left, right) => left[1].localeCompare(right[1], 'zh-CN')), [documents])
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [focusConceptId, setFocusConceptId] = useState<string | null>(null)
  const [conceptPage, setConceptPage] = useState(0)
  const filteredDocuments = useMemo(() => documents.filter((document) => courseFilter === 'all' || document.courseId === courseFilter), [courseFilter, documents])
  const filteredConcepts = useMemo(() => concepts.filter((concept) => courseFilter === 'all' || concept.courseIds.includes(courseFilter)), [concepts, courseFilter])
  const prioritizedConcepts = useMemo(() => prioritizeMapConcepts(filteredConcepts, ratings, evidence), [evidence, filteredConcepts, ratings])
  const pageSize = 24
  const pageCount = Math.max(1, Math.ceil(prioritizedConcepts.length / pageSize))
  const visibleConcepts = courseFilter === 'all' || focusConceptId ? filteredConcepts : prioritizedConcepts.slice(conceptPage * pageSize, (conceptPage + 1) * pageSize)
  const data = useMemo(() => buildKnowledgeMap(filteredDocuments, visibleConcepts, focusConceptId, courseFilter === 'all'), [courseFilter, filteredDocuments, focusConceptId, visibleConcepts])
  const selected = selectedId ? data.nodeById.get(selectedId) : undefined
  const matches = useMemo(() => {
    const text = normalized(query)
    if (!text) return []
    return filteredConcepts.filter((concept) => normalized(concept.title).includes(text)).slice(0, 8).map((concept) => ({ id: `course-concept:${concept.id}`, title: concept.title, kind: 'courseConcept' as const, conceptId: concept.id }))
  }, [filteredConcepts, query])

  useEffect(() => { setSelectedId(null); setFocusConceptId(null); setQuery(''); setConceptPage(0) }, [courseFilter])
  const selectNode = (id: string) => {
    const node = data.nodeById.get(id)
    if (node?.kind === 'course' && node.courseId && courseFilter === 'all') {
      onCourseFilterChange(node.courseId)
      return
    }
    if (node?.kind === 'courseConcept' && node.conceptId && !focusConceptId) {
      setFocusConceptId(node.conceptId)
      setSelectedId(`course-concept:${node.conceptId}`)
      return
    }
    setSelectedId(id)
  }

  const selectedEvidence = selected?.conceptId ? evidence[selected.conceptId] : undefined
  return <div className="knowledge-map-layout"><div className="knowledge-map-toolbar"><label>范围<select value={courseFilter} onChange={(event) => onCourseFilterChange(event.target.value)}><option value="all">全部课程地图</option>{courseOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label className="knowledge-map-search"><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索课程知识点" />{matches.length ? <div>{matches.map((node) => <button key={node.id} onClick={() => { setFocusConceptId(node.conceptId); setSelectedId(node.id); setQuery('') }}>{node.title}<small>展开资料级来源</small></button>)}</div> : null}</label>{focusConceptId ? <button className="outline-button" onClick={() => { setFocusConceptId(null); setSelectedId(null) }}>返回主题列表</button> : courseFilter !== 'all' ? <><button className="outline-button" onClick={() => onCourseFilterChange('all')}>返回全部课程</button>{pageCount > 1 ? <div className="knowledge-map-pages"><button disabled={conceptPage === 0} onClick={() => setConceptPage((page) => Math.max(0, page - 1))}>上一批</button><span>{conceptPage + 1}/{pageCount} · 每批最多 {pageSize} 个</span><button disabled={conceptPage >= pageCount - 1} onClick={() => setConceptPage((page) => Math.min(pageCount - 1, page + 1))}>下一批</button></div> : null}</> : <span>先选择课程，再逐层查看主题与来源</span>}<span>{data.nodes.length} 个可见节点 · {data.edges.length} 条关系</span></div><div className="knowledge-evidence-legend"><span className="unassessed">未形成证据</span><span className="self_weak">自评薄弱</span><span className="test_weak">测试薄弱</span><span className="conflict">自评与测试不一致</span><span className="verified">测试验证较好</span><small>有描边的知识点已经被快速测试覆盖</small></div><div className="knowledge-map-workspace"><MapCanvas data={data} ratings={ratings} evidence={evidence} selectedId={selectedId} onSelect={selectNode} /><aside className="knowledge-map-inspector"><span className="eyebrow">节点详情</span>{selected ? <><i className={'map-kind ' + selected.kind}>{selected.kind === 'course' ? '课程' : selected.kind === 'document' ? '来源资料' : selected.kind === 'documentConcept' ? '资料级主题' : '课程主题'}</i><h2>{selected.title}</h2><p>{selected.subtitle}</p>{selected.conceptId ? <div className="map-concept-evidence"><span className={`concept-evidence-status ${selectedEvidence?.status ?? 'unassessed'}`}>{conceptEvidenceLabels[selectedEvidence?.status ?? 'unassessed']}</span><p>主动自评：{['未评估', '陌生', '模糊', '理解', '掌握'][ratings[selected.conceptId] ?? 0]}</p><p>最近测试：{selectedEvidence?.latestTestScore === null || selectedEvidence?.latestTestScore === undefined ? '尚未覆盖' : `${selectedEvidence.latestTestScore}%（${selectedEvidence.latestTestCorrect}/${selectedEvidence.latestTestQuestions}）`}</p><p>最近复习：{selectedEvidence?.lastReviewedAt ? new Date(selectedEvidence.lastReviewedAt).toLocaleDateString() : '尚无记录'}</p>{selected.courseId ? <button className="outline-button" onClick={() => onReviewConcept(selected.conceptId!, courseFilter !== 'all' ? courseFilter : selected.courseId!)}>加入自选复习</button> : null}</div> : null}{selected.documentId && selected.courseId ? <button className="primary-button map-open-document" onClick={() => onOpenDocument(selected.documentId!, selected.courseId!)}>在学径中打开这份资料</button> : null}</> : <p>{focusConceptId ? '当前只显示一个主题及其来源资料。点击资料可以在学径中打开原文件。' : courseFilter === 'all' ? '全课程地图只显示课程入口，避免把上千个节点堆在一起。点击课程进入它的主题地图。' : `当前课程共 ${filteredConcepts.length} 个主题，每批最多显示 ${pageSize} 个。薄弱、矛盾和来源较多的主题优先。`}</p>}</aside></div></div>
}
