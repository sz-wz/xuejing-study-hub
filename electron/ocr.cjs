const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const { createCanvas } = require('@napi-rs/canvas')
const { createWorker } = require('tesseract.js')

const OCR_SCALE = 1.7
const MAX_OCR_PAGES = 30
const MAX_OCR_TEXT_LENGTH = 500_000

async function loadPdf(buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  return pdfjs.getDocument({ data: new Uint8Array(buffer), disableWorker: true }).promise
}

async function ensureBundledLanguages(language, cachePath) {
  const codes = String(language).split('+').map((code) => code.trim()).filter(Boolean)
  await fs.mkdir(cachePath, { recursive: true })
  await Promise.all(codes.map(async (code) => {
    const filePath = require.resolve('@tesseract.js-data/' + code + '/4.0.0/' + code + '.traineddata.gz')
    const destination = path.join(cachePath, code + '.traineddata')
    try {
      await fs.access(destination)
    } catch {
      await fs.copyFile(filePath, destination)
    }
  }))
}

async function recognizePdf({ filePath, language = 'chi_sim+eng', cachePath, onProgress, maxPages = MAX_OCR_PAGES }) {
  const buffer = await fs.readFile(filePath)
  const pdf = await loadPdf(buffer)
  const pageCount = Math.min(pdf.numPages, Math.max(1, maxPages))
  const languageCachePath = cachePath || path.join(os.tmpdir(), 'xuejing-ocr-language-cache')
  await ensureBundledLanguages(language, languageCachePath)
  const worker = await createWorker(language, 1, {
    cachePath: languageCachePath,
    logger: (event) => {
      if (event.status !== 'recognizing text' || typeof event.progress !== 'number') return
      onProgress?.({
        completed: Math.min(pageCount, Number((event.progress).toFixed(2))),
        total: 1,
        title: '正在加载本地 OCR 识别引擎…',
      })
    },
  })
  const pages = []
  try {
    for (let number = 1; number <= pageCount; number += 1) {
      onProgress?.({ completed: number - 1, total: pageCount, title: '正在识别第 ' + number + '/' + pageCount + ' 页' })
      const page = await pdf.getPage(number)
      const viewport = page.getViewport({ scale: OCR_SCALE })
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
      const context = canvas.getContext('2d')
      await page.render({ canvasContext: context, viewport }).promise
      const image = await canvas.encode('png')
      const result = await worker.recognize(image)
      const text = String(result?.data?.text ?? '').trim()
      if (text) pages.push(text)
      if (pages.join('\n').length >= MAX_OCR_TEXT_LENGTH) break
    }
  } finally {
    await worker.terminate()
  }
  const text = pages.join('\n').slice(0, MAX_OCR_TEXT_LENGTH)
  onProgress?.({ completed: pageCount, total: pageCount, title: '' })
  return { text, pages: pages.length, totalPages: pdf.numPages, language, truncated: pdf.numPages > pageCount }
}

module.exports = { recognizePdf, ensureBundledLanguages, MAX_OCR_PAGES }
