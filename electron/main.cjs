// Lumen Reader — Electron main process.
// Serves the built web app from a privileged app:// scheme (so fetch, ES
// modules and workers behave exactly like on the web), forwards "Open with…"
// files to the renderer, and keeps the renderer sandboxed.
const { app, BrowserWindow, Menu, ipcMain, net, protocol, shell, nativeTheme } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const DIST = path.join(__dirname, '..', 'dist')
const DEV_URL = process.env.ELECTRON_DEV_URL
const APP_ORIGIN = 'app://lumen'
const BOOK_EXT = /\.(epub|pdf|mobi|azw3?|kf8|fb2|fbz|fb2\.zip|cbz)$/i

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
}])

let win = null
let rendererReady = false
const pendingPaths = []

const bookPathsFrom = argv => argv
  .slice(app.isPackaged ? 1 : 2)
  .filter(arg => BOOK_EXT.test(arg) && fs.existsSync(arg))

const sendFiles = async paths => {
  if (!paths.length) return
  if (!win || !rendererReady) {
    pendingPaths.push(...paths)
    return
  }
  const files = []
  for (const p of paths) {
    try {
      files.push({ name: path.basename(p), data: await fs.promises.readFile(p) })
    } catch (e) {
      console.error('Could not read', p, e)
    }
  }
  if (files.length) win.webContents.send('open-files', files)
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_e, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
    sendFiles(bookPathsFrom(argv))
  })
}

// macOS: files dropped on the dock icon or opened from Finder
app.on('open-file', (e, p) => {
  e.preventDefault()
  sendFiles([p])
})

const sendMenu = action => win?.webContents.send('menu', action)

const buildMenu = () => {
  const isMac = process.platform === 'darwin'
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Import Books…', accelerator: 'CmdOrCtrl+O', click: () => sendMenu('import') },
        { label: 'Library', accelerator: 'CmdOrCtrl+L', click: () => sendMenu('library') },
        { type: 'separator' },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'togglefullscreen' },
        { type: 'separator' },
        // Ctrl +/− is handled by the reader (text size / PDF zoom), so no page zoom items here
        { role: 'reload' },
        { role: 'toggleDevTools' },
      ],
    },
    { role: 'windowMenu' },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const createWindow = () => {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 360,
    minHeight: 480,
    show: false,
    title: 'Lumen Reader',
    autoHideMenuBar: true,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#16161a' : '#f6f1e7',
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })

  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    win = null
    rendererReady = false
  })

  // External links open in the user's browser; nothing else may open windows.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(APP_ORIGIN) && !(DEV_URL && url.startsWith(DEV_URL))) {
      e.preventDefault()
      if (/^https?:/i.test(url)) shell.openExternal(url)
    }
  })
  win.on('enter-full-screen', () => win.webContents.send('fullscreen', true))
  win.on('leave-full-screen', () => win.webContents.send('fullscreen', false))

  win.loadURL(DEV_URL || `${APP_ORIGIN}/index.html`)
}

ipcMain.on('renderer-ready', () => {
  rendererReady = true
  const paths = pendingPaths.splice(0)
  sendFiles(paths)
})
ipcMain.on('toggle-fullscreen', () => win?.setFullScreen(!win.isFullScreen()))
ipcMain.handle('is-fullscreen', () => !!win?.isFullScreen())

app.whenReady().then(() => {
  protocol.handle('app', req => {
    const { pathname } = new URL(req.url)
    const rel = path.normalize(decodeURIComponent(pathname)).replace(/^([/\\])+/, '')
    const file = path.join(DIST, rel || 'index.html')
    if (!file.startsWith(DIST)) return new Response('Forbidden', { status: 403 })
    return net.fetch(pathToFileURL(file).toString())
  })

  buildMenu()
  pendingPaths.push(...bookPathsFrom(process.argv))
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
