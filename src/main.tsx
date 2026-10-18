import '@fontsource-variable/inter'
import '@fontsource-variable/literata'
import './styles/base.css'
import './styles/library.css'
import './styles/reader.css'
import './styles/dictionary.css'
import { createRoot } from 'react-dom/client'
import { App } from './App'

// ask the browser not to evict the library under storage pressure
navigator.storage?.persist?.().catch(() => {})

createRoot(document.getElementById('root')!).render(<App />)
