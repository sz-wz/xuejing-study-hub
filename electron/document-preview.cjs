const fs = require('fs/promises')
const path = require('path')

const MAX_PREVIEW_BYTES = 96 * 1024 * 1024

function findPreviewDocument(documents, materialId) {
  return (Array.isArray(documents) ? documents : []).find((document) => document?.materialId === materialId)
}

function previewFormat(document) {
  const extension = (path.extname(String(document?.localPath || '')) || path.extname(String(document?.title || ''))).toLowerCase()
  if (extension === '.pdf') return 'pdf'
  if (extension === '.docx') return 'docx'
  if (['.pptx', '.ppsx'].includes(extension)) return 'pptx'
  if (['.ppt', '.pps'].includes(extension)) return 'ppt'
  return 'unknown'
}

async function readPreviewFile(document) {
  if (!document?.localPath || !path.isAbsolute(document.localPath)) throw new Error('资料路径无效')
  const stat = await fs.stat(document.localPath)
  if (!stat.isFile()) throw new Error('资料文件不存在')
  if (stat.size > MAX_PREVIEW_BYTES) throw new Error(`资料超过 ${Math.floor(MAX_PREVIEW_BYTES / 1024 / 1024)} MB，无法安全载入应用内预览；请使用“原文件”打开。`)
  const bytes = await fs.readFile(document.localPath)
  return { materialId: document.materialId, title: document.title, format: previewFormat(document), bytes }
}

module.exports = { MAX_PREVIEW_BYTES, findPreviewDocument, previewFormat, readPreviewFile }
