import { ChevronLeft, ChevronRight, FileWarning, LoaderCircle, Minus, Plus, RotateCcw } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { ReviewDocument } from './review-workspace'
import { parsePptx, type PptxSlide } from './pptx-preview'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url'

type PreviewFormat = 'pdf' | 'docx' | 'pptx' | 'ppt' | 'unknown'
type PreviewFile = { materialId: string; title: string; format: PreviewFormat; bytes: Uint8Array }

function arrayBufferOf(bytes: Uint8Array) {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function PdfPreview({ bytes }: { bytes: Uint8Array }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [pdf, setPdf] = useState<any>(null)
  const [page, setPage] = useState(1)
  const [pages, setPages] = useState(0)
  const [zoom, setZoom] = useState(1.16)
  const [error, setError] = useState('')
  const [rendering, setRendering] = useState(true)

  useEffect(() => {
    let cancelled = false
    let loaded: any
    setPdf(null)
    setPage(1)
    setPages(0)
    setError('')
    setRendering(true)
    void import('pdfjs-dist/legacy/build/pdf.mjs').then(async (pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
      loaded = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise
      if (cancelled) return void loaded.destroy()
      setPdf(loaded)
      setPages(loaded.numPages)
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
    if (!pdf || !canvasRef.current) return
    let cancelled = false
    let task: any
    setRendering(true)
    setError('')
    void pdf.getPage(page).then((pdfPage: any) => {
      if (cancelled || !canvasRef.current) return
      const ratio = Math.min(window.devicePixelRatio || 1, 2)
      const viewport = pdfPage.getViewport({ scale: zoom })
      const canvas = canvasRef.current
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('浏览器不支持 PDF 画布渲染')
      canvas.width = Math.ceil(viewport.width * ratio)
      canvas.height = Math.ceil(viewport.height * ratio)
      canvas.style.width = `${Math.ceil(viewport.width)}px`
      canvas.style.height = `${Math.ceil(viewport.height)}px`
      task = pdfPage.render({ canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] })
      return task.promise
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'PDF 页面渲染失败')
    }).finally(() => {
      if (!cancelled) setRendering(false)
    })
    return () => {
      cancelled = true
      task?.cancel?.()
    }
  }, [page, pdf, zoom])

  return <div className="embedded-viewer pdf-viewer">
    <div className="embedded-viewer-toolbar"><div><button title="上一页" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={15} /></button><span>{pages ? `${page} / ${pages}` : '载入页数…'}</span><button title="下一页" disabled={!pages || page >= pages} onClick={() => setPage((value) => Math.min(pages, value + 1))}><ChevronRight size={15} /></button></div><div><button title="缩小" disabled={zoom <= 0.6} onClick={() => setZoom((value) => Math.max(0.6, Number((value - 0.15).toFixed(2))))}><Minus size={14} /></button><span>{Math.round(zoom * 100)}%</span><button title="放大" disabled={zoom >= 2.4} onClick={() => setZoom((value) => Math.min(2.4, Number((value + 0.15).toFixed(2))))}><Plus size={14} /></button><button title="恢复默认缩放" onClick={() => setZoom(1.16)}><RotateCcw size={13} /></button></div></div>{error ? <PreviewError message={error} /> : <div className="pdf-canvas-scroll">{rendering ? <span className="embedded-viewer-loading"><LoaderCircle size={16} />正在渲染原始 PDF…</span> : null}<canvas ref={canvasRef} /></div>}</div>
}

function DocxPreview({ bytes }: { bytes: Uint8Array }) {
  const mountRef = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

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

  return <div className="embedded-viewer document-preview"><div className="embedded-viewer-toolbar"><span>DOCX 原文件预览</span><small>图片、表格和分页会保留；复杂 Office 公式请以原文件为准。</small></div>{loading ? <span className="embedded-viewer-loading"><LoaderCircle size={16} />正在排版 DOCX…</span> : null}{error ? <PreviewError message={error} /> : null}<div ref={mountRef} className="docx-preview-mount" /></div>
}

function PptxPreview({ bytes }: { bytes: Uint8Array }) {
  const [slides, setSlides] = useState<PptxSlide[]>([])
  const [slideIndex, setSlideIndex] = useState(0)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setError('')
    setLoading(true)
    setSlides([])
    setSlideIndex(0)
    void parsePptx(bytes).then((result) => {
      if (!cancelled) setSlides(result)
    }).catch((reason: unknown) => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : 'PPTX 原文件预览失败')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [bytes])

  const slide = slides[slideIndex]
  return <div className="embedded-viewer presentation-preview"><div className="embedded-viewer-toolbar"><div><button title="上一页" disabled={slideIndex <= 0} onClick={() => setSlideIndex((value) => Math.max(0, value - 1))}><ChevronLeft size={15} /></button><span>{slides.length ? `第 ${slideIndex + 1} / ${slides.length} 页` : '载入幻灯片…'}</span><button title="下一页" disabled={!slides.length || slideIndex >= slides.length - 1} onClick={() => setSlideIndex((value) => Math.min(slides.length - 1, value + 1))}><ChevronRight size={15} /></button></div><small>保留原文件内的文字与图片位置；动画、图表和复杂公式请以原文件为准。</small></div>{loading ? <span className="embedded-viewer-loading"><LoaderCircle size={16} />正在读取 PPTX 幻灯片…</span> : null}{error ? <PreviewError message={error} /> : slide ? <div className="pptx-preview-scroll"><div className="pptx-slide-canvas" style={{ aspectRatio: `${slide.width} / ${slide.height}` }}>{slide.elements.map((element, index) => element.kind === 'image' ? <img key={index} src={element.src} style={{ left: `${element.left}%`, top: `${element.top}%`, width: `${element.width}%`, height: `${element.height}%` }} /> : <div key={index} className="pptx-text-box" style={{ left: `${element.left}%`, top: `${element.top}%`, width: `${element.width}%`, height: `${element.height}%` }}>{element.text}</div>)}</div></div> : !loading ? <PreviewError message="未在该 PPTX 中找到可显示的幻灯片。" /> : null}</div>
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

export function DocumentViewer({ document, documents, fallbackText }: { document?: ReviewDocument; documents: ReviewDocument[]; fallbackText?: string }) {
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

  if (!document) return <PreviewError message="没有可打开的资料。" />
  if (error) return <PreviewError message={error} />
  if (!file) return <div className="embedded-viewer"><span className="embedded-viewer-loading"><LoaderCircle size={16} />正在读取原始资料…</span></div>
  if (file.format === 'pdf') return <PdfPreview bytes={file.bytes} />
  if (file.format === 'docx') return <DocxPreview bytes={file.bytes} />
  if (file.format === 'pptx') return <PptxPreview bytes={file.bytes} />
  return <UnsupportedPreview format={file.format} text={fallbackText} />
}
