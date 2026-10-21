import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// Content-Security-Policy for production builds only (the dev server needs
// inline scripts for React Fast Refresh). Book pages are rendered in blob:
// iframes that inherit this policy, so scripts embedded in ebooks never run.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src 'self' blob: data: https:",
  "font-src 'self' blob: data:",
  "media-src 'self' blob: data: https:",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data: https:",
  "object-src 'none'",
  "base-uri 'self'",
].join('; ')

const injectCsp = (): Plugin => ({
  name: 'lumen-csp',
  apply: 'build',
  transformIndexHtml: html =>
    html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`),
})

export default defineConfig({
  base: './',
  plugins: [react(), injectCsp()],
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
    assetsInlineLimit: 0,
  },
  worker: { format: 'es' },
  server: { port: 5173 },
})
