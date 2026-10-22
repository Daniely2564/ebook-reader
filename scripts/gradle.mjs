#!/usr/bin/env node
// Runs the Android Gradle wrapper cross-platform (npm scripts use cmd.exe on Windows, where `./gradlew` fails).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'android')
const win = process.platform === 'win32'
const r = spawnSync(path.join(cwd, win ? 'gradlew.bat' : 'gradlew'), process.argv.slice(2), { cwd, stdio: 'inherit', shell: win })
if (r.status === 0) {
  const kind = /release/i.test(process.argv.join(' ')) ? 'release' : 'debug'
  const dir = path.join(cwd, 'app', 'build', 'outputs', 'apk', kind)
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.apk')) : []) {
    const file = path.join(dir, f)
    const { size, mtime } = fs.statSync(file)
    console.log(`
APK: ${file}
     ${(size / 1048576).toFixed(1)} MB, built ${mtime.toLocaleString()}`)
  }
}
process.exit(r.status ?? 1)
