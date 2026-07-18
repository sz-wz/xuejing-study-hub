import { ChevronLeft, ChevronRight, FileWarning, LoaderCircle, Maximize2, Minus, MoveHorizontal, Plus, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReviewDocument } from './review-workspace'
import { parsePptx, type PptxSlide } from './pptx-preview'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'

type PreviewFormat = 'pdf' | 'docx' | 'pptx' | 'ppt' | 'unknown'
type PreviewFile = { materialId: string; title: string; format: PreviewFormat; bytes: Uint8Array }
export type KnowledgeLocation = { materialId: string; kind: 'pdf-page' | 'pptx-slide' | 'docx-section'; start: number; end?: number; confidence?: number; evidence?: string }
type FitMode = 'width' | 'page' | 'manual'

export function fitDocumentScale({ pageWidth, pageHeight, containerWidth, containerHeight, mode, padding = 44 }: { pageWidth: number; pageHeight: number; containerWidth: number; containerHeight: number; mode: Exclude<FitMode, 'manual'>; padding?: number }) {
  if (![pageWidth, pageHeight, containerWidth, containerHeight].every((value) => Number.isFinite(value) && value > 0)) return 1
  const widthScale = Math.max(0.35, (containerWidth - padding) / pageWidth)
  const heightScale = Math.max(0.35, (containerHeight - padding) / pageHeight)
  return Math.min(2.4, Number((mode === 'width' ? widthScale : Math.min(widthScale, heightScale)).toFixed(3)))
}

export function stableDocumentScale(current: number, next: number, epsilon = 0.025) {
  return Math.abs(current - next) <= epsilon ? Math.min(current, next) : next
}

function useElementSize(ref: React.RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 })
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const update = () => {
      const next = { width: element.clientWidth, height: element.clientHeight }
      setSize((current) => current.width === next.width && current.height === next.height ? current : next)
    }
    update()
    let timer = 0
    const observer = new ResizeObserver(() => {
      window.clearTimeout(timer)
      timer = window.setTimeout(update, 90)
    })
    observer.observe(element)
    return () => { window.clearTimeout(timer); observer.disconnect() }
  }, [ref])
  return size
}

function arrayBufferOf(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function PdfPreview({ bytes, initialPage, onLocationChange }: { bytes: Uint8Array; initialPage?: number; onLocationChange?: (location: KnowledgeLocation) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [pdf, setPdf] = useState<any>(null)
  const [page, setPage] = useState(Math.max(1, initialPage ?? 1))
  const [pages, setPages] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [fitMode, setFitMode] = useState<FitMode>('width')
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 })
  const [error, setError] = useState('')
  const [rendering, setRendering] = useState(true)
  const [hasRendered, setHasRendered] = useState(false)
  const renderTaskRef = useRef<any>(null)
  const renderGenerationRef = useRef(0)
  const containerSize = useElementSize(scrollRef)

  useEffect(() => {
    let cancelled = false
    let loaded: any
    setPdf(null)
    setPage(Math.max(1, initialPage ?? 1))
    setPages(0)
    setError('')
    setRendering(true)
    setHasRendered(false)
    void import('pdfjs-dist/legacy/build/pdf.mjs').then(async (pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
      loaded = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise
      if (cancelled) return void loaded.destroy()
      setPdf(loaded)
      setPages(loaded.numPages)
      setPage((value) => Math.min(Math.max(1, value), loaded.numPages))
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '无法载入 PDF 原文件')
    }).finally(() => {
      if (!cancelled) setRendering(false)
    })
    return () => {
      cancelled = true
      void loaded?.destroy?.()
    }
  }, [bytes])

  useEffect(() => {
    if (!pages || !initialPage) return
    setPage(Math.min(pages, Math.max(1, initialPage)))
  }, [initialPage, pages])

  useEffect(() => {
    if (fitMode === 'manual' || !pageSize.width || !containerSize.width) return
    const next = fitDocumentScale({ pageWidth: pageSize.width, pageHeight: pageSize.height, containerWidth: containerSize.width, containerHeight: containerSize.height, mode: fitMode })
    setZoom((current) => stableDocumentScale(current, next))
  }, [containerSize.height, containerSize.width, fitMode, pageSize.height, pageSize.width])

  useEffect(() => {
    if (!pdf || !canvasRef.current) return
    const generation = ++renderGenerationRef.current
    let cancelled = false
    let task: any
    setRendering(true)
    setError('')
    const previous = renderTaskRef.current
    previous?.cancel?.()
    const settled = previous?.promise ? Promise.resolve(previous.promise).catch(() => {}) : Promise.resolve()
    void settled.then(async () => {
      if (cancelled || generation !== renderGenerationRef.current || !canvasRef.current) return
      const pdfPage = await pdf.getPage(page)
      if (cancelled || generation !== renderGenerationRef.current || !canvasRef.current) return
      const baseViewport = pdfPage.getViewport({ scale: 1 })
      setPageSize((current) => current.width === baseViewport.width && current.height === baseViewport.height ? current : { width: baseViewport.width, height: baseViewport.height })
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = pdfPage.getViewport({ scale: zoom })
      const offscreen = window.document.createElement('canvas')
      offscreen.width = Math.ceil(viewport.width * ratio)
      offscreen.height = Math.ceil(viewport.height * ratio)
      const offscreenContext = offscreen.getContext('2d', { alpha: false })
      if (!offscreenContext) throw new Error('浏览器不支持 PDF 画布渲染')
      task = pdfPage.render({ canvasContext: offscreenContext, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
      renderTaskRef.current = task
      await task.promise
      if (cancelled || generation !== renderGenerationRef.current || !canvasRef.current) return
      const canvas = canvasRef.current
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('浏览器不支持 PDF 画布渲染')
      canvas.width = offscreen.width
      canvas.height = offscreen.height
      canvas.style.width = `${Math.ceil(viewport.width)}px`
      canvas.style.height = `${Math.ceil(viewport.height)}px`
      context.clearRect(0, 0, canvas.width, canvas.height)
      context.drawImage(offscreen, 0, 0)
      setHasRendered(true)
    }).catch((reason: unknown) => {
      if (!cancelled && generation === renderGenerationRef.current && (reason as { name?: string })?.name !== 'RenderingCancelledException') setError(reason instanceof Error ? reason.message : 'PDF 页面渲染失败')
    }).finally(() => {
      if (!cancelled && generation === renderGenerationRef.current) setRendering(false)
    })
    return () => {
      cancelled = true
      if (generation === renderGenerationRef.current) task?.cancel?.()
    }
  }, [page, pdf, zoom])

  useEffect(() => {
    onLocationChange?.({ materialId: '', kind: 'pdf-page', start: page })
  }, [onLocationChange, page])

  const changeZoom = (next: number) => {
    setFitMode('manual')
    setZoom(Math.max(0.35, Math.min(2.4, Number(next.toFixed(2)))))
  }

  return <div className="embedded-viewer pdf-viewer">
    <div className="embedded-viewer-toolbar"><div><button title="上一页" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={15} /></button><span>{pages ? `${page} / ${pages}` : '载入页数…'}</span><button title="下一页" disabled={!pages || page >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))}><ChevronRight size={15} /></button>{rendering && hasRendered ? <small className="pdf-render-status"><LoaderCircle size={11} />正在更新</small> : null}</div><div><button title="适合宽度" className={fitMode === 'width' ? 'active' : ''} onClick={() => setFitMode('width')}><MoveHorizontal size={14} /></button><button title="适合整页" className={fitMode === 'page' ? 'active' : ''} onClick={() => setFitMode('page')}><Maximize2 size={13} /></button><button title="缩小" disabled={zoom <= 0.35} onClick={() => changeZoom(zoom - 0.15)}><Minus size={14} /></button><span>{Math.round(zoom * 100)}%</span><button title="放大" disabled={zoom >= 2.4} onClick={() => changeZoom(zoom + 0.15)}><Plus size={14} /></button><button title="恢复 100%" onClick={() => changeZoom(1)}><RotateCcw size={13} /></button></div></div>{error ? <PreviewError message={error} /> : <div className="pdf-canvas-scroll" ref={scrollRef}>{rendering && !hasRendered ? <span className="embedded-viewer-loading"><LoaderCircle size={16} />正在渲染原始 PDF…</span> : null}<canvas ref={canvasRef} /></div>}</div>
}

function DocxPreview({ bytes }: { bytes: Uint8Array }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [fitWidth, setFitWidth] = useState(true)

  useEffect(() => {
    let cancelled = false
    const target = mountRef.current
    if (!target) return
    target.replaceChildren()
    setError('')
    setLoading(true)
    void import('docx-preview').then(async ({ renderAsync }) => {
      await renderAsync(arrayBufferOf(bytes), target, target, { breakPages: true, ignoreLastRenderedPageBreak: false, renderHeaders: true, renderFooters: true, renderFootnotes: true, renderEndnotes: true, useBase64URL: true })
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'DOCX 原文件预览失败')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true; target.replaceChildren() }
  }, [bytes])

  return <div className="embedded-viewer document-preview"><div className="embedded-viewer-toolbar"><span>DOCX 原文件预览</span><div><small>图片、表格和分页会保留；复杂 Office 公式请以原文件为准。</small><button title={fitWidth ? '按原始页面宽度显示' : '适合阅读区宽度'} className={fitWidth ? 'active' : ''} onClick={() => setFitWidth((value) => !value)}><MoveHorizontal size={14} /></button></div></div>{loading ? <span className="embedded-viewer-loading"><LoaderCircle size={16} />正在排版 DOCX…</span> : null}{error ? <PreviewError message={error} /> : null}<div ref={mountRef} className={'docx-preview-mount' + (fitWidth ? ' fit-width' : '')} /></div>
}

function PptxPreview({ bytes, initialSlide, onLocationChange }: { bytes: Uint8Array; initialSlide?: number; onLocationChange?: (location: KnowledgeLocation) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const [slides, setSlides] = useState<PptxSlide[]>([])
  const [slideIndex, setSlideIndex] = useState(Math.max(0, (initialSlide ?? 1) - 1))
  const [zoom, setZoom] = useState(1)
  const [fitMode, setFitMode] = useState<FitMode>('page')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const containerSize = useElementSize(scrollRef)

  useEffect(() => {
    let cancelled = false
    setError('')
    setLoading(true)
    setSlides([])
    setSlideIndex(Math.max(0, (initialSlide ?? 1) - 1))
    void parsePptx(bytes).then((result) => {
      if (!cancelled) {
        setSlides(result)
        setSlideIndex((value) => Math.min(Math.max(0, value), Math.max(0, result.length - 1)))
      }
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'PPTX 原文件预览失败')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [bytes, initialSlide])

  const slide = slides[slideIndex]
  const baseWidth = 1280
  const baseHeight = slide ? baseWidth * slide.height / slide.width : 720

  useEffect(() => {
    if (!slide || fitMode === 'manual' || !containerSize.width) return
    setZoom(fitDocumentScale({ pageWidth: baseWidth, pageHeight: baseHeight, containerWidth: containerSize.width, containerHeight: containerSize.height, mode: fitMode }))
  }, [baseHeight, containerSize.height, containerSize.width, fitMode, slide])

  useEffect(() => {
    if (!initialSlide || !slides.length) return
    setSlideIndex(Math.min(slides.length - 1, Math.max(0, initialSlide - 1)))
  }, [initialSlide, slides.length])

  useEffect(() => {
    onLocationChange?.({ materialId: '', kind: 'pptx-slide', start: slideIndex + 1 })
  }, [onLocationChange, slideIndex])

  const changeZoom = (next: number) => {
    setFitMode('manual')
    setZoom(Math.max(0.35, Math.min(2.4, Number(next.toFixed(2)))))
  }

  return <div className="embedded-viewer presentation-preview"><div className="embedded-viewer-toolbar"><div><button title="上一页" disabled={slideIndex <= 0} onClick={() => setSlideIndex((value) => Math.max(0, value - 1))}><ChevronLeft size={15} /></button><span>{slides.length ? `第 ${slideIndex + 1} / ${slides.length} 页` : '载入幻灯片…'}</span><button title="下一页" disabled={!slides.length || slideIndex >= slides.length - 1} onClick={() => setSlideIndex((value) => Math.min(slides.length - 1, value + 1))}><ChevronRight size={15} /></button></div><div><button title="适合宽度" className={fitMode === 'width' ? 'active' : ''} onClick={() => setFitMode('width')}><MoveHorizontal size={14} /></button><button title="适合整页" className={fitMode === 'page' ? 'active' : ''} onClick={() => setFitMode('page')}><Maximize2 size={13} /></button><button title="缩小" disabled={zoom <= 0.35} onClick={() => changeZoom(zoom - 0.15)}><Minus size={14} /></button><span>{Math.round(zoom * 100)}%</span><button title="放大" disabled={zoom >= 2.4} onClick={() => changeZoom(zoom + 0.15)}><Plus size={14} /></button><button title="恢复 100%" onClick={() => changeZoom(1)}><RotateCcw size={13} /></button></div></div>{loading ? <span className="embedded-viewer-loading"><LoaderCircle size={16} />正在读取 PPTX 幻灯片…</span> : null}{error ? <PreviewError message={error} /> : slide ? <div className="pptx-preview-scroll" ref={scrollRef}><div className="pptx-slide-canvas" style={{ aspectRatio: `${slide.width} / ${slide.height}`, width: `${Math.round(baseWidth * zoom)}px` }}>{slide.elements.map((element, index) => element.kind === 'image' ? <img key={index} src={element.src} style={{ left: `${element.left}%`, top: `${element.top}%`, width: `${element.width}%`, height: `${element.height}%` }} /> : <div key={index} className="pptx-text-box" style={{ left: `${element.left}%`, top: `${element.top}%`, width: `${element.width}%`, height: `${element.height}%` }}>{element.text}</div>)}</div></div> : !loading ? <PreviewError message="未在该 PPTX 中找到可显示的幻灯片。" /> : null}</div>
}

function PreviewError({ message }: { message: string }) {
  return <div className="embedded-viewer-error"><FileWarning size={18} /><div><strong>无法显示原文件</strong><span>{message}</span></div></div>
}

function UnsupportedPreview({ format, text }: { format: PreviewFormat; text?: string }) {
  const [showText, setShowText] = useState(false)
  const message = format === 'ppt'
    ? '旧版 .ppt 为二进制格式，无法在不依赖 Office/WPS 的情况下高保真还原图片和版式。请使用右上方“原文件”打开。'
    : '该文件暂不支持应用内原文件预览。请使用右上方“原文件”打开。'
  return <div className="embedded-viewer unsupported-preview"><PreviewError message={message} />{text ? <button className="outline-button" onClick={() => setShowText((value) => !value)}>{showText ? '隐藏提取文本' : '查看用于 AI 的提取文本'}</button> : null}{showText && text ? <article className="review-reader-content extracted-fallback">{text.replace(/\\n/g, '\n').split(/\n+/).filter(Boolean).slice(0, 260).map((paragraph, index) => <p key={index}>{paragraph}</p>)}</article> : null}</div>
}

export function DocumentViewer({ document, documents, fallbackText, initialLocation, onLocationChange }: { document?: ReviewDocument; documents: ReviewDocument[]; fallbackText?: string; initialLocation?: KnowledgeLocation; onLocationChange?: (location: KnowledgeLocation) => void }) {
  const [file, setFile] = useState<PreviewFile | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!document) return
    let cancelled = false
    setFile(null)
    setError('')
    const load = window.xuejing?.knowledge.documentFile
    if (!load) {
      setError('当前环境不支持应用内文件预览。')
      return
    }
    void load({ documents, materialId: document.materialId }).then((result) => {
      if (!cancelled) setFile({ ...result, bytes: new Uint8Array(result.bytes) })
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : '无法读取原始资料文件')
    })
    return () => { cancelled = true }
  }, [document?.materialId, documents])

  const reportLocation = useCallback((location: KnowledgeLocation) => {
    if (document) onLocationChange?.({ ...location, materialId: document.materialId })
  }, [document, onLocationChange])

  if (!document) return <PreviewError message="没有可打开的资料。" />
  if (error) return <PreviewError message={error} />
  if (!file) return <div className="embedded-viewer"><span className="embedded-viewer-loading"><LoaderCircle size={16} />正在读取原始资料…</span></div>
  if (file.format === 'pdf') return <PdfPreview bytes={file.bytes} initialPage={initialLocation?.kind === 'pdf-page' ? initialLocation.start : undefined} onLocationChange={reportLocation} />
  if (file.format === 'docx') return <DocxPreview bytes={file.bytes} />
  if (file.format === 'pptx') return <PptxPreview bytes={file.bytes} initialSlide={initialLocation?.kind === 'pptx-slide' ? initialLocation.start : undefined} onLocationChange={reportLocation} />
  return <UnsupportedPreview format={file.format} text={fallbackText} />
}
