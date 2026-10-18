import { ArrowDown, ArrowUp, BookA, Database, Download, Headphones, Info, Monitor, Moon, Plus, Sun, Trash, Upload } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { deleteUserDict, exportBackup, getUserDicts, importBackup, putUserDict, type UserDictRecord } from '../lib/db'
import { getWordNetMeta, type WordNetMeta } from '../lib/dictionary/wordnet'
import { forgetStarDict, importStarDict } from '../lib/dictionary/stardict'
import { formatSize } from '../lib/format'
import { exportFile, isNative } from '../lib/platform'
import { useSettings } from '../lib/settings'
import { toast, useApp } from '../lib/store'
import { getVoices, resetVoiceCache, speak, stopSpeaking, type Voice } from '../lib/tts'
import { Button, IconButton, Segmented, Sheet, Slider, Spinner, Switch } from '../components/ui'

const LANGS = ['ar', 'bn', 'cs', 'da', 'de', 'el', 'es', 'fa', 'fi', 'fr', 'he', 'hi', 'hu', 'id', 'it', 'ja', 'ko', 'ms', 'nl', 'no', 'pl', 'pt', 'ro', 'ru', 'sv', 'th', 'tr', 'uk', 'vi', 'zh-CN', 'zh-TW', 'en']
const langName = new Intl.DisplayNames(['en'], { type: 'language' })

type Section = 'general' | 'dictionary' | 'voice' | 'data' | 'about'

export const SettingsModal = () => {
  const open = useApp(s => s.settingsOpen)
  const setOpen = useApp(s => s.openSettings)
  const [section, setSection] = useState<Section>('general')
  return (
    <Sheet open={open} onClose={() => setOpen(false)} title="Settings" wide className="settings">
      <div className="settings-layout">
        <nav className="settings-nav">
          {([
            ['general', 'General', <Monitor size={17} key="g" />],
            ['dictionary', 'Dictionaries', <BookA size={17} key="d" />],
            ['voice', 'Read aloud', <Headphones size={17} key="v" />],
            ['data', 'Data & backup', <Database size={17} key="b" />],
            ['about', 'About', <Info size={17} key="a" />],
          ] as [Section, string, React.ReactNode][]).map(([id, label, icon]) => (
            <button key={id} className={section === id ? 'on' : ''} onClick={() => setSection(id)}>{icon}<span>{label}</span></button>
          ))}
        </nav>
        <div className="settings-content">
          {section === 'general' && <General />}
          {section === 'dictionary' && <Dictionaries />}
          {section === 'voice' && <VoiceSettings />}
          {section === 'data' && <DataSettings />}
          {section === 'about' && <About />}
        </div>
      </div>
    </Sheet>
  )
}

const General = () => {
  const s = useSettings()
  return (
    <div className="settings-section">
      <h3>Appearance</h3>
      <div className="typo-row">
        <span>App theme</span>
        <Segmented value={s.appTheme} onChange={v => s.set({ appTheme: v })} options={[
          { value: 'system', label: <><Monitor size={15} />Auto</> }, { value: 'light', label: <><Sun size={15} />Light</> }, { value: 'dark', label: <><Moon size={15} />Dark</> },
        ]} />
      </div>
      <p className="muted small">Book page colors are chosen in the reader with the <b>Aa</b> button.</p>
      <h3>Reading</h3>
      <Switch label="Tap or click page edges to turn pages" hint="The middle of the page shows or hides the toolbars" checked={s.tapZones} onChange={v => s.set({ tapZones: v })} />
      <Switch label="Instant dictionary" hint="Double-click (or long-press) a word to look it up right away" checked={s.instantLookup} onChange={v => s.set({ instantLookup: v })} />
      <Switch label="Keep screen on while reading" checked={s.keepAwake} onChange={v => s.set({ keepAwake: v })} />
      <Switch label="Show clock when toolbars are hidden" checked={s.showClock} onChange={v => s.set({ showClock: v })} />
    </div>
  )
}

const Dictionaries = () => {
  const s = useSettings()
  const [meta, setMeta] = useState<WordNetMeta | null>(null)
  const [dicts, setDicts] = useState<UserDictRecord[] | null>(null)
  const [busy, setBusy] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  const load = () => getUserDicts().then(setDicts)
  useEffect(() => {
    getWordNetMeta().then(setMeta)
    load()
  }, [])

  const onFiles = async (files: FileList | null) => {
    if (!files?.length) return
    setBusy(true)
    try {
      const added = await importStarDict(Array.from(files))
      toast(`Added ${added.map(d => d.name).join(', ')}`, 'success')
      load()
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error')
    } finally {
      setBusy(false)
      if (input.current) input.current.value = ''
    }
  }

  const update = async (d: UserDictRecord, patch: Partial<UserDictRecord>) => {
    await putUserDict({ ...d, ...patch })
    forgetStarDict(d.id)
    load()
  }

  const move = async (i: number, dir: -1 | 1) => {
    if (!dicts) return
    const list = [...dicts]
    const j = i + dir
    if (j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    await Promise.all(list.map((d, order) => putUserDict({ ...d, order })))
    load()
  }

  return (
    <div className="settings-section">
      <h3>Built-in dictionary</h3>
      <div className="dict-card card">
        <BookA size={22} />
        <div>
          <strong>English (WordNet 3.1 + Wiktionary)</strong>
          <div className="muted small">
            {meta ? `${meta.words.toLocaleString()} words · ${meta.withPronunciation.toLocaleString()} pronunciations · works offline` : 'Loading…'}
          </div>
        </div>
      </div>

      <h3>Your dictionaries</h3>
      <p className="muted small">Import StarDict dictionaries (<code>.ifo</code> + <code>.idx</code> + <code>.dict</code>/<code>.dict.dz</code>, or a <code>.zip</code>/<code>.tar.gz</code> archive) to look up words in other languages or use a different English dictionary. They work offline.</p>
      {dicts === null ? <Spinner /> : dicts.length === 0 ? null : (
        <ul className="dict-list">
          {dicts.map((d, i) => (
            <li key={d.id} className="card">
              <div className="dict-list-main">
                <strong>{d.name}</strong>
                <span className="muted small">{d.wordCount.toLocaleString()} entries · {formatSize(d.size)}{d.ifo.description ? ` · ${d.ifo.description.replace(/<[^>]+>/g, '').slice(0, 80)}` : ''}</span>
              </div>
              <IconButton label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={15} /></IconButton>
              <IconButton label="Move down" disabled={i === dicts.length - 1} onClick={() => move(i, 1)}><ArrowDown size={15} /></IconButton>
              <label className="mini-switch" title={d.enabled ? 'Enabled' : 'Disabled'}>
                <input type="checkbox" role="switch" checked={d.enabled} onChange={e => update(d, { enabled: e.target.checked })} />
                <span className="switch" />
              </label>
              <IconButton label="Delete" onClick={async () => {
                if (!confirm(`Delete the dictionary “${d.name}”?`)) return
                await deleteUserDict(d.id)
                forgetStarDict(d.id)
                load()
              }}><Trash size={15} /></IconButton>
            </li>
          ))}
        </ul>
      )}
      <input ref={input} type="file" multiple hidden accept={isNative ? undefined : '.ifo,.idx,.dict,.dz,.syn,.gz,.zip,.tar,.tgz'} onChange={e => onFiles(e.target.files)} />
      <Button onClick={() => input.current?.click()} disabled={busy}>{busy ? <Spinner size={16} /> : <Plus size={16} />}Import StarDict dictionary</Button>

      <h3>Online</h3>
      <Switch label="Use online sources when available" hint="Wiktionary (all languages), Wikipedia and pronunciation audio. Nothing is sent unless you open a lookup." checked={s.onlineLookup} onChange={v => s.set({ onlineLookup: v })} />
      <div className="typo-row">
        <span>Translate to</span>
        <select className="select" value={s.translateTo} onChange={e => s.set({ translateTo: e.target.value })}>
          {LANGS.map(l => <option key={l} value={l}>{langName.of(l) ?? l}</option>)}
        </select>
      </div>
    </div>
  )
}

const VoiceSettings = () => {
  const s = useSettings()
  const [voices, setVoices] = useState<Voice[] | null>(null)
  useEffect(() => {
    resetVoiceCache()
    getVoices().then(setVoices)
  }, [])
  const grouped = new Map<string, Voice[]>()
  for (const v of voices ?? []) {
    const key = (() => {
      try {
        return langName.of(v.lang) ?? v.lang
      } catch {
        return v.lang
      }
    })()
    grouped.set(key, [...(grouped.get(key) ?? []), v])
  }
  return (
    <div className="settings-section">
      <h3>Voice</h3>
      {voices === null ? <Spinner /> : !voices.length ? (
        <p className="muted">No text-to-speech voices were found on this device.{navigator.userAgent.includes('Linux') && !isNative ? ' On Linux, install speech-dispatcher with a voice (e.g. espeak-ng) and restart the app.' : ''}</p>
      ) : (
        <>
          <select className="select full" value={s.ttsVoice} onChange={e => s.set({ ttsVoice: e.target.value })}>
            <option value="">Automatic (matches the book’s language)</option>
            {[...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([lang, list]) => (
              <optgroup key={lang} label={lang}>
                {list.map(v => <option key={v.id} value={v.id}>{v.name}{v.local ? '' : ' (online)'}</option>)}
              </optgroup>
            ))}
          </select>
          <Slider label="Speed" min={0.5} max={2.5} step={0.05} value={s.ttsRate} onChange={v => s.set({ ttsRate: Math.round(v * 100) / 100 })} format={v => `${v.toFixed(2)}×`} />
          <Slider label="Pitch" min={0.5} max={1.5} step={0.05} value={s.ttsPitch} onChange={v => s.set({ ttsPitch: v })} format={v => v.toFixed(2)} />
          <div className="row-gap">
            <Button onClick={async () => {
              await stopSpeaking()
              const v = voices.find(x => x.id === s.ttsVoice)
              speak('It was the best of times, it was the worst of times.', { voiceId: s.ttsVoice, lang: v?.lang ?? 'en-US', rate: s.ttsRate, pitch: s.ttsPitch }).catch(() => {})
            }}><Headphones size={16} />Test voice</Button>
          </div>
        </>
      )}
      <p className="muted small">Start reading aloud from the headphones button in the reader, or press <kbd>R</kbd>. The current sentence is highlighted and pages turn automatically.</p>
    </div>
  )
}

const DataSettings = () => {
  const refresh = useApp(s => s.refreshLibrary)
  const [usage, setUsage] = useState<{ usage: number; quota: number } | null>(null)
  const [persisted, setPersisted] = useState<boolean | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    navigator.storage?.estimate?.().then(e => setUsage({ usage: e.usage ?? 0, quota: e.quota ?? 0 })).catch(() => {})
    navigator.storage?.persisted?.().then(setPersisted).catch(() => {})
  }, [])
  return (
    <div className="settings-section">
      <h3>Storage</h3>
      <p className="muted">
        Your books, highlights and settings are stored only on this device.
        {usage && ` Using ${formatSize(usage.usage)}${usage.quota ? ` of ${formatSize(usage.quota)} available` : ''}.`}
        {persisted === false && ' Storage may be cleared by the system when space is low.'}
      </p>
      <h3>Backup</h3>
      <p className="muted small">A backup contains reading progress, highlights, notes, bookmarks, vocabulary and reading stats (not the book files). Restore it after re-adding the same books on another device.</p>
      <div className="row-gap">
        <Button onClick={async () => {
          const data = await exportBackup()
          await exportFile(`lumen-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data), 'application/json')
        }}><Download size={16} />Export backup</Button>
        <Button onClick={() => input.current?.click()}><Upload size={16} />Restore backup</Button>
        <input ref={input} type="file" hidden accept={isNative ? undefined : '.json,application/json'} onChange={async e => {
          const f = e.target.files?.[0]
          if (!f) return
          try {
            const n = await importBackup(JSON.parse(await f.text()))
            toast(`Backup restored${n ? ` (${n} book${n === 1 ? '' : 's'} matched)` : ''}`, 'success')
            refresh()
          } catch (err) {
            toast(err instanceof Error ? err.message : 'Invalid backup file', 'error')
          } finally {
            e.target.value = ''
          }
        }} />
      </div>
    </div>
  )
}

const About = () => (
  <div className="settings-section about">
    <div className="about-brand">
      <img src="./icon.svg" alt="" width={56} height={56} />
      <div>
        <h3>Lumen Reader</h3>
        <div className="muted small">Version {__APP_VERSION__}</div>
      </div>
    </div>
    <p>A calm, fast ebook reader for EPUB, PDF, MOBI/AZW3, FB2 and CBZ, with an offline dictionary, highlights, notes and read-aloud.</p>
    <h3>Open source components</h3>
    <ul className="credits">
      <li><b>foliate-js</b> by John Factotum, MIT — EPUB, MOBI, FB2 and CBZ rendering</li>
      <li><b>PDF.js</b> by Mozilla, Apache-2.0 — PDF rendering</li>
      <li><b>WordNet 3.1</b>, Princeton University — dictionary definitions (WordNet License)</li>
      <li><b>Wiktionary</b> contributors, via kaikki.org — definitions of function words (CC BY-SA 4.0)</li>
      <li><b>CMU Pronouncing Dictionary</b>, Carnegie Mellon University — pronunciations (BSD)</li>
      <li><b>Literata, Source Serif 4, Merriweather, Inter, Atkinson Hyperlegible, OpenDyslexic</b> — SIL Open Font License</li>
      <li><b>React, Electron, Capacitor, Lucide</b> — MIT / ISC</li>
    </ul>
  </div>
)
