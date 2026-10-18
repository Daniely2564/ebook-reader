import { speak, stopSpeaking } from '../lib/tts'
import type { ReaderEngine, SpeechChunk } from './types'

export type ReadAloudState = 'idle' | 'playing' | 'paused'

interface Options {
  lang?: string
  voiceId: string
  rate: number
  pitch: number
}

/** Long sentences are split at clause boundaries; some engines cut off long utterances. */
const splitLong = (text: string, max = 260) => {
  if (text.length <= max) return [text]
  const parts: string[] = []
  let rest = text
  while (rest.length > max) {
    const slice = rest.slice(0, max)
    const cut = Math.max(slice.lastIndexOf(', '), slice.lastIndexOf('; '), slice.lastIndexOf(': '), slice.lastIndexOf(' — '))
    const at = cut > max * 0.4 ? cut + 1 : slice.lastIndexOf(' ') > 0 ? slice.lastIndexOf(' ') : max
    parts.push(rest.slice(0, at).trim())
    rest = rest.slice(at).trim()
  }
  if (rest) parts.push(rest)
  return parts
}

/** Reads the book aloud sentence by sentence, highlighting and following along. */
export class ReadAloud {
  state: ReadAloudState = 'idle'
  #engine: ReaderEngine
  #opts: Options
  #onState: (s: ReadAloudState) => void
  #chunks: SpeechChunk[] = []
  #index = 0
  #run = 0

  constructor(engine: ReaderEngine, opts: Options, onState: (s: ReadAloudState) => void) {
    this.#engine = engine
    this.#opts = opts
    this.#onState = onState
  }

  setOptions(opts: Partial<Options>) {
    const changed = opts.rate !== this.#opts.rate || opts.voiceId !== this.#opts.voiceId || opts.pitch !== this.#opts.pitch
    this.#opts = { ...this.#opts, ...opts }
    // restart the current sentence with the new voice/rate
    if (changed && this.state === 'playing') {
      this.#run++
      stopSpeaking().then(() => this.#loop(this.#run))
    }
  }

  #set(s: ReadAloudState) {
    this.state = s
    this.#onState(s)
  }

  async start() {
    this.#run++
    await stopSpeaking()
    this.#chunks = await this.#engine.speechChunks()
    this.#index = 0
    this.#set('playing')
    this.#loop(this.#run)
  }

  async #loop(run: number) {
    while (run === this.#run && this.state === 'playing') {
      if (this.#index >= this.#chunks.length) {
        const more = await this.#engine.speechAdvance()
        if (run !== this.#run) return
        if (!more) {
          this.stop()
          return
        }
        this.#chunks = await this.#engine.speechChunks()
        this.#index = 0
        if (!this.#chunks.length) continue
      }
      const chunk = this.#chunks[this.#index]
      chunk.show()
      try {
        for (const part of splitLong(chunk.text)) {
          if (run !== this.#run) return
          await speak(part, this.#opts)
        }
      } catch (e) {
        if (run !== this.#run) return
        if ((e as Error).message !== 'interrupted') {
          console.warn('Speech failed', e)
          this.stop()
          return
        }
      }
      if (run !== this.#run) return
      this.#index++
    }
  }

  pause() {
    if (this.state !== 'playing') return
    this.#run++
    stopSpeaking()
    this.#set('paused')
  }

  resume() {
    if (this.state !== 'paused') return
    this.#set('playing')
    this.#loop(++this.#run)
  }

  skip(delta: 1 | -1) {
    if (this.state === 'idle') return
    this.#index = Math.max(0, Math.min(this.#chunks.length, this.#index + delta))
    if (this.state === 'playing') {
      this.#run++
      stopSpeaking().then(() => this.#loop(this.#run))
    } else this.#chunks[this.#index]?.show()
  }

  stop() {
    this.#run++
    stopSpeaking()
    this.#engine.clearSpeech()
    this.#chunks = []
    this.#set('idle')
  }
}
