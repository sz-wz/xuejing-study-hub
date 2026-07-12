const assert = require('node:assert/strict')
const fs = require('fs/promises')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { ensureBundledLanguages } = require('./ocr.cjs')

test('OCR 使用随应用安装的语言包，不依赖运行时 CDN 下载', async () => {
  const cachePath = await fs.mkdtemp(path.join(os.tmpdir(), 'xuejing-ocr-language-'))
  try {
    await ensureBundledLanguages('eng+chi_sim', cachePath)
    const english = await fs.stat(path.join(cachePath, 'eng.traineddata'))
    const chinese = await fs.stat(path.join(cachePath, 'chi_sim.traineddata'))
    assert.ok(english.size > 1_000_000)
    assert.ok(chinese.size > 1_000_000)
  } finally {
    await fs.rm(cachePath, { recursive: true, force: true })
  }
})
