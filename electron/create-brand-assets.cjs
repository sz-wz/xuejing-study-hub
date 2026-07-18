const fs = require('fs')
const path = require('path')
const { createCanvas, loadImage } = require('@napi-rs/canvas')
const { createBrandIconPng, createTrayIconPng } = require('./tray-icon.cjs')

const buildDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(buildDir, { recursive: true })
const sourcePath = path.join(buildDir, 'source', 'xuejing-app-icon.png')
const electronAssetsDir = path.join(__dirname, 'assets')
fs.mkdirSync(electronAssetsDir, { recursive: true })

function removeConnectedWhiteBackground(canvas) {
  const context = canvas.getContext('2d')
  const image = context.getImageData(0, 0, canvas.width, canvas.height)
  const { data, width, height } = image
  const visited = new Uint8Array(width * height)
  const queue = []
  const white = (index) => data[index * 4] > 238 && data[index * 4 + 1] > 238 && data[index * 4 + 2] > 238
  const enqueue = (x, y) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    const pixel = y * width + x
    if (visited[pixel] || !white(pixel)) return
    visited[pixel] = 1
    queue.push(pixel)
  }
  for (let x = 0; x < width; x += 1) { enqueue(x, 0); enqueue(x, height - 1) }
  for (let y = 0; y < height; y += 1) { enqueue(0, y); enqueue(width - 1, y) }
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const pixel = queue[cursor]
    const x = pixel % width
    const y = Math.floor(pixel / width)
    data[pixel * 4 + 3] = 0
    enqueue(x - 1, y); enqueue(x + 1, y); enqueue(x, y - 1); enqueue(x, y + 1)
  }
  context.putImageData(image, 0, 0)
}

async function renderSourceIcon(size) {
  if (!fs.existsSync(sourcePath)) return createBrandIconPng(size)
  const image = await loadImage(sourcePath)
  const canvas = createCanvas(size, size)
  const context = canvas.getContext('2d')
  context.imageSmoothingEnabled = true
  context.imageSmoothingQuality = 'high'
  context.drawImage(image, 0, 0, size, size)
  removeConnectedWhiteBackground(canvas)
  return canvas.toBuffer('image/png')
}

function buildIco(images) {
  const count = images.length
  const header = Buffer.alloc(6 + count * 16)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(count, 4)
  let offset = header.length
  images.forEach(({ size, png }, index) => {
    const entry = 6 + index * 16
    header[entry] = size >= 256 ? 0 : size
    header[entry + 1] = size >= 256 ? 0 : size
    header[entry + 2] = 0
    header[entry + 3] = 0
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(png.length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += png.length
  })
  return Buffer.concat([header, ...images.map((item) => item.png)])
}

async function main() {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  const images = []
  for (const size of sizes) images.push({ size, png: await renderSourceIcon(size) })
  const largest = images.at(-1).png
  fs.writeFileSync(path.join(buildDir, 'icon.png'), largest)
  fs.writeFileSync(path.join(buildDir, 'icon.ico'), buildIco(images))
  fs.writeFileSync(path.join(electronAssetsDir, 'app-icon.png'), largest)
  fs.writeFileSync(path.join(electronAssetsDir, 'tray-icon.png'), createTrayIconPng())
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
