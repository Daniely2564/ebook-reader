import { Capacitor } from '@capacitor/core'

export interface NativeFile {
  name: string
  data: Uint8Array
}

interface LumenNative {
  platform: string
  onOpenFiles(cb: (files: NativeFile[]) => void): () => void
  onMenu(cb: (action: string) => void): () => void
  onFullscreen(cb: (value: boolean) => void): () => void
  toggleFullscreen(): void
  isFullscreen(): Promise<boolean>
}

declare global {
  interface Window {
    lumenNative?: LumenNative
  }
}

export const electron = window.lumenNative
export const isElectron = !!electron
export const isNative = Capacitor.isNativePlatform()
export const isAndroid = Capacitor.getPlatform() === 'android'
export const isMac = /Mac|iPhone|iPad/.test(navigator.platform) || electron?.platform === 'darwin'
export const isTouch = matchMedia('(pointer: coarse)').matches

export const modKey = isMac ? '⌘' : 'Ctrl'

export const toggleFullscreen = async () => {
  if (electron) return electron.toggleFullscreen()
  if (document.fullscreenElement) await document.exitFullscreen()
  else await document.documentElement.requestFullscreen?.().catch(() => {})
}

export const openExternal = (url: string) => {
  window.open(url, '_blank', 'noopener')
}

/** Absolute URL for a file in /public, valid on web, app:// and https://localhost. */
export const publicUrl = (path: string) => new URL(path, document.baseURI).href

const blobToBase64 = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader()
  r.onload = () => resolve(String(r.result).split(',')[1] ?? '')
  r.onerror = () => reject(r.error)
  r.readAsDataURL(blob)
})

/** Saves a file: a download on desktop/web, the share sheet on Android. */
export const exportFile = async (name: string, data: string | Blob, type = 'text/plain') => {
  const blob = typeof data === 'string' ? new Blob([data], { type }) : data
  if (isNative) {
    const [{ Filesystem, Directory }, { Share }] = await Promise.all([import('@capacitor/filesystem'), import('@capacitor/share')])
    const { uri } = await Filesystem.writeFile({ path: name, data: await blobToBase64(blob), directory: Directory.Cache })
    await Share.share({ title: name, files: [uri] })
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.append(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}
