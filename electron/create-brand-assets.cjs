const fs = require('fs')
const path = require('path')
const { createBrandIconPng } = require('./tray-icon.cjs')

const buildDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(buildDir, { recursive: true })
fs.writeFileSync(path.join(buildDir, 'icon.png'), createBrandIconPng(256))
