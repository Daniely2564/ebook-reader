#!/usr/bin/env node
// Runs the Android Gradle wrapper cross-platform (npm scripts use cmd.exe on Windows, where `./gradlew` fails).
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cwd = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'android')
const win = process.platform === 'win32'

// Capacitor 8 needs JDK 21+. Use JAVA_HOME when it is one, else the newest found where JDKs
// (and Android Studio's bundled one) are usually installed.
const javaVersion = home => {
  try {
    return Number(/JAVA_VERSION="(\d+)/.exec(fs.readFileSync(path.join(home, 'release'), 'utf8'))?.[1] ?? 0)
  } catch {
    return 0
  }
}
const jdkDirs = () => {
  const dirs = []
  const under = (parent, sub = '') => {
    try {
      for (const d of fs.readdirSync(parent)) dirs.push(path.join(parent, d, sub))
    } catch { /* not there */ }
  }
  if (win) {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files'
    for (const vendor of ['Eclipse Adoptium', 'Java', 'Microsoft', 'Zulu', 'Amazon Corretto']) under(path.join(pf, vendor))
    dirs.push(path.join(pf, 'Android', 'Android Studio', 'jbr'))
  } else if (process.platform === 'darwin') {
    under('/Library/Java/JavaVirtualMachines', 'Contents/Home')
    dirs.push('/Applications/Android Studio.app/Contents/jbr/Contents/Home')
  } else {
    under('/usr/lib/jvm')
    dirs.push('/opt/android-studio/jbr', path.join(os.homedir(), 'android-studio', 'jbr'))
  }
  return dirs
}
const jdk = javaVersion(process.env.JAVA_HOME ?? '') >= 21 ? null
  : jdkDirs().map(dir => ({ dir, version: javaVersion(dir) })).filter(j => j.version >= 21).sort((a, b) => b.version - a.version)[0]?.dir
if (jdk) console.log(`Using the JDK in ${jdk}`)

const r = spawnSync(path.join(cwd, win ? 'gradlew.bat' : 'gradlew'), process.argv.slice(2), {
  cwd, stdio: 'inherit', shell: win, env: jdk ? { ...process.env, JAVA_HOME: jdk } : process.env,
})
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
