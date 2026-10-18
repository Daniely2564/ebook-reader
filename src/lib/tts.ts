// Text-to-speech: Web Speech API on desktop/web, the native Android engine
// (via @capacitor-community/text-to-speech) inside the Android app, where the
// WebView has no speechSynthesis.
import { TextToSpeech } from '@capacitor-community/text-to-speech'
import { isNative } from './platform'

export interface Voice {
  id: string
  name: string
  lang: string
  local: boolean
  default: boolean
}

const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null
export const ttsAvailable = () => isNative || !!synth

let nativeVoices: Voice[] = []

export const getVoices = async (): Promise<Voice[]> => {
  if (isNative) {
    try {
      const { voices } = await TextToSpeech.getSupportedVoices()
      nativeVoices = voices.map((v, i) => ({ id: String(i), name: v.name, lang: v.lang, local: v.localService, default: v.default }))
      return nativeVoices
    } catch {
      return []
    }
  }
  if (!synth) return []
  let list = synth.getVoices()
  if (!list.length) {
    await new Promise<void>(res => {
      const done = () => res()
      synth.addEventListener('voiceschanged', done, { once: true })
      setTimeout(done, 1200)
    })
    list = synth.getVoices()
  }
  return list.map(v => ({ id: v.voiceURI, name: v.name, lang: v.lang, local: v.localService, default: v.default }))
}

const pickVoice = (voices: Voice[], voiceId: string, lang?: string) => {
  const byId = voices.find(v => v.id === voiceId)
  if (byId && (!lang || byId.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()))) return byId
  if (!lang) return byId
  const base = lang.slice(0, 2).toLowerCase()
  const matches = voices.filter(v => v.lang.toLowerCase().startsWith(base))
  return matches.find(v => v.default) ?? matches.find(v => v.local) ?? matches[0] ?? byId
}

export interface SpeakOptions {
  lang?: string
  voiceId?: string
  rate?: number
  pitch?: number
}

let voiceCache: Voice[] | null = null

/** Speaks `text`; resolves when finished, rejects with 'interrupted' when stopped. */
export const speak = async (text: string, opts: SpeakOptions = {}): Promise<void> => {
  voiceCache ??= await getVoices()
  const voice = pickVoice(voiceCache, opts.voiceId ?? '', opts.lang)
  if (isNative) {
    await TextToSpeech.speak({
      text,
      lang: voice?.lang ?? opts.lang ?? 'en-US',
      rate: opts.rate ?? 1,
      pitch: opts.pitch ?? 1,
      voice: voice ? Number(voice.id) : undefined,
      queueStrategy: 0,
    })
    return
  }
  if (!synth) throw new Error('Speech is not available on this device')
  await new Promise<void>((resolve, reject) => {
    const u = new SpeechSynthesisUtterance(text)
    const sv = voice && synth.getVoices().find(v => v.voiceURI === voice.id)
    if (sv) u.voice = sv
    u.lang = sv?.lang ?? opts.lang ?? ''
    u.rate = opts.rate ?? 1
    u.pitch = opts.pitch ?? 1
    u.onend = () => resolve()
    u.onerror = e => reject(new Error(e.error === 'interrupted' || e.error === 'canceled' ? 'interrupted' : e.error))
    synth.speak(u)
  })
}

export const stopSpeaking = async () => {
  if (isNative) await TextToSpeech.stop().catch(() => {})
  else synth?.cancel()
}

export const resetVoiceCache = () => {
  voiceCache = null
}

/** Pronounces a single word (dictionary). */
export const sayWord = async (word: string, lang = 'en-US', voiceId = '') => {
  await stopSpeaking()
  await speak(word, { lang, voiceId, rate: 0.9 }).catch(() => {})
}
