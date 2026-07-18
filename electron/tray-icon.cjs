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
  const size = 64
  const canvas = createCanvas(size, size)
  const context = canvas.getContext('2d')
  context.clearRect(0, 0, size, size)
  context.fillStyle = '#0f5b48'
  context.beginPath()
  context.roundRect(5, 5, 54, 54, 15)
  context.fill()
  context.strokeStyle = '#e9f5dc'
  context.lineWidth = 4.8
  context.lineCap = 'round'
  context.beginPath()
  context.moveTo(22, 49)
  context.bezierCurveTo(18, 39, 42, 38, 31, 27)
  context.bezierCurveTo(26, 22, 38, 18, 39, 13)
  context.stroke()
  context.fillStyle = '#d8ef68'
  context.beginPath()
  context.moveTo(42, 8)
  context.lineTo(45, 14)
  context.lineTo(52, 17)
  context.lineTo(45, 20)
  context.lineTo(42, 27)
  context.lineTo(39, 20)
  context.lineTo(32, 17)
  context.lineTo(39, 14)
  context.closePath()
  context.fill()
  return canvas.toBuffer('image/png')
}

module.exports = { createBrandIconPng, createTrayIconPng }
