const assert = require('node:assert/strict')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { findPreviewDocument, previewFormat, readPreviewFile } = require('./document-preview.cjs')

test('应用内预览按 materialId 定位当前会话中的原文件', () => {
  const documents = [{ materialId: 'lecture-1', localPath: 'C:\\vault\\lecture.pdf' }, { materialId: 'lecture-2', localPath: 'C:\\vault\\lecture-2.pdf' }]
  assert.equal(findPreviewDocument(documents, 'lecture-2')?.localPath, 'C:\\vault\\lecture-2.pdf')
  assert.equal(findPreviewDocument(documents, 'missing'), undefined)
})

test('应用内预览识别 PDF、DOCX、PPTX 和旧版 PPT', () => {
  assert.equal(previewFormat({ localPath: 'C:\\vault\\lecture.pdf' }), 'pdf')
  assert.equal(previewFormat({ localPath: 'C:\\vault\\report.docx' }), 'docx')
  assert.equal(previewFormat({ localPath: 'C:\\vault\\slides.pptx' }), 'pptx')
  assert.equal(previewFormat({ localPath: 'C:\\vault\\slides.ppt' }), 'ppt')
})

test('应用内预览从已缓存资料读取原始字节', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-document-preview-'))
  try {
    const filePath = path.join(root, 'lecture.pdf')
    await fs.writeFile(filePath, Buffer.from('%PDF-1.7\nsource'))
    const result = await readPreviewFile({ materialId: 'material-1', title: 'lecture.pdf', localPath: filePath })
    assert.equal(result.format, 'pdf')
    assert.equal(result.bytes.toString('utf8'), '%PDF-1.7\nsource')
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
