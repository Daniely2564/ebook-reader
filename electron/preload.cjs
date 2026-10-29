// Minimal, typed bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('lumenNative', {
  platform: process.platform,
  onOpenFiles(callback) {
    const handler = (_e, files) => callback(files)
    ipcRenderer.on('open-files', handler)
    ipcRenderer.send('renderer-ready')
    return () => ipcRenderer.off('open-files', handler)
  },
  onMenu(callback) {
    const handler = (_e, action) => callback(action)
    ipcRenderer.on('menu', handler)
    return () => ipcRenderer.off('menu', handler)
  },
  onFullscreen(callback) {
    const handler = (_e, value) => callback(value)
    ipcRenderer.on('fullscreen', handler)
    return () => ipcRenderer.off('fullscreen', handler)
  },
  toggleFullscreen: () => ipcRenderer.send('toggle-fullscreen'),
  isFullscreen: () => ipcRenderer.invoke('is-fullscreen'),
  dotionRequest: request => ipcRenderer.invoke('dotion-request', request),
})
