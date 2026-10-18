#!/usr/bin/env node
// Renders app icons from public/icon.svg with headless Chromium (playwright-core):
//   build/icon.png, build/icons/<size>x<size>.png   Electron (all platforms)
//   android/app/src/main/res/mipmap-*/…           Android launcher icons (if android/ exists)
// Set CHROMIUM_PATH if Chromium isn't found automatically.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright-core'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const svg = fs.readFileSync(path.join(root, 'public', 'icon.svg'), 'utf8')
const fg = fs.readFileSync(path.join(root, 'build', 'icon-foreground.svg'), 'utf8')
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
const page = await browser.newPage()

const render = async (file, size, body) => {
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<html><body style="margin:0;background:transparent">${body}</body></html>`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  await page.screenshot({ path: file, omitBackground: true })
}
const full = size => `<div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</div>`
// macOS/Windows/Linux icons get a little breathing room around the rounded square
const padded = size => `<div style="width:${size}px;height:${size}px;display:grid;place-items:center">${svg.replace('<svg ', `<svg width="${Math.round(size * 0.86)}" height="${Math.round(size * 0.86)}" style="filter:drop-shadow(0 ${size * 0.012}px ${size * 0.02}px rgba(0,0,0,.28))" `)}</div>`
const round = size => `<div style="width:${size}px;height:${size}px;border-radius:50%;overflow:hidden">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `).replace('rx="114"', 'rx="0"')}</div>`
const bg = size => `<div style="width:${size}px;height:${size}px">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `).replace('rx="114"', 'rx="0"').replace(/<g transform="translate\(0 18\)">[\s\S]*<\/svg>/, '</svg>')}</div>`
// adaptive icon foreground: 108dp canvas, artwork within the central ~66dp safe zone
const fore = size => `<div style="width:${size}px;height:${size}px;display:grid;place-items:center">${fg.replace('<svg ', `<svg width="${Math.round(size * 0.66)}" height="${Math.round(size * 0.66)}" `)}</div>`

await render(path.join(root, 'build', 'icon.png'), 1024, padded(1024))
for (const s of [16, 24, 32, 48, 64, 128, 256, 512]) await render(path.join(root, 'build', 'icons', `${s}x${s}.png`), s, padded(s))

const res = path.join(root, 'android', 'app', 'src', 'main', 'res')
if (fs.existsSync(res)) {
  const densities = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
  for (const [d, k] of Object.entries(densities)) {
    await render(path.join(res, `mipmap-${d}`, 'ic_launcher.png'), 48 * k, full(48 * k))
    await render(path.join(res, `mipmap-${d}`, 'ic_launcher_round.png'), 48 * k, round(48 * k))
    await render(path.join(res, `mipmap-${d}`, 'ic_launcher_foreground.png'), 108 * k, fore(108 * k))
    await render(path.join(res, `mipmap-${d}`, 'ic_launcher_background.png'), 108 * k, bg(108 * k))
  }
}
await browser.close()
console.log('Icons written')
