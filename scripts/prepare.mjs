#!/usr/bin/env node
// Generates runtime assets that are derived from node_modules (not committed):
//   public/dict/   offline dictionary (see build-dictionary.mjs)
//   public/pdfjs/  pdf.js CMaps, standard fonts, wasm decoders and ICC profiles
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
execFileSync(process.execPath, [path.join(root, 'scripts', 'build-dictionary.mjs'), '--if-missing'], { stdio: 'inherit' })

const pdfjs = path.join(root, 'node_modules', 'pdfjs-dist')
const dest = path.join(root, 'public', 'pdfjs')
const version = JSON.parse(fs.readFileSync(path.join(pdfjs, 'package.json'), 'utf8')).version
const stamp = path.join(dest, '.version')
if (!fs.existsSync(stamp) || fs.readFileSync(stamp, 'utf8') !== version) {
  fs.rmSync(dest, { recursive: true, force: true })
  for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs'])
    fs.cpSync(path.join(pdfjs, dir), path.join(dest, dir), { recursive: true })
  fs.writeFileSync(stamp, version)
  console.log(`Copied pdf.js ${version} assets`)
}
