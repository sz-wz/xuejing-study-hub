const { createCanvas } = require('@napi-rs/canvas')

function createBrandIconPng(size = 64) {
  const canvas = createCanvas(size, size)
  const context = canvas.getContext('2d')
  const scale = size / 64
  context.clearRect(0, 0, size, size)
  context.fillStyle = '#285f4b'
  context.beginPath()
  context.roundRect(3 * scale, 3 * scale, 58 * scale, 58 * scale, 15 * scale)
  context.fill()
  context.strokeStyle = 'rgba(232,243,197,.72)'
  context.lineWidth = 2 * scale
  context.stroke()
  context.fillStyle = '#f2f7dd'
  context.font = `700 ${38 * scale}px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.fillText('径', 32 * scale, 33 * scale)
  return canvas.toBuffer('image/png')
}

function createTrayIconPng() {
  return createBrandIconPng(64)
}

module.exports = { createBrandIconPng, createTrayIconPng }
