import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'app.lumenreader',
  appName: 'Lumen Reader',
  webDir: 'dist',
  android: {
    backgroundColor: '#f6f1e7',
  },
  plugins: {
    // MainActivity keeps the page full screen and sets the --safe-area-inset-* variables
    SystemBars: { insetsHandling: 'disable' },
  },
}

export default config
