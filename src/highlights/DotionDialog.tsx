import { FileText, Search, Send } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { Annotation, BookRecord } from '../lib/db'
import { getPage, loadAccount, pageIdIn, searchPages, sendToDotion, useDotion, type DotionDatabase, type DotionPage, type SendResult } from '../lib/dotion'
import { openExternal } from '../lib/platform'
import { Button, Segmented, Sheet, Spinner } from '../components/ui'
import { DotionAccount } from '../settings/DotionSettings'

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

const STATUS: Record<SendResult['status'], (r: SendResult) => string> = {
  created: r => `New page with ${plural(r.count, 'highlight')}`,
  added: r => `Added ${plural(r.count, 'highlight')}`,
  unchanged: () => 'Already there',
  failed: r => `Failed: ${r.error}`,
}

/** Sends the highlights shown on the Highlights page to a Dotion database or page. */
export const DotionDialog = ({ groups, scope, onClose }: {
  groups: { book: BookRecord; items: Annotation[] }[]
  /** what is being sent, e.g. “Dune” or "3 books" */
  scope: string
  onClose: () => void
}) => {
  const { token, user, target, url } = useDotion()
  const connected = !!token && !!user
  const [kind, setKind] = useState<'database' | 'page'>(target?.kind ?? 'database')
  const [databases, setDatabases] = useState<DotionDatabase[] | null>(null)
  const [progress, setProgress] = useState<[number, number] | null>(null)
  const [results, setResults] = useState<SendResult[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!connected) return
    let alive = true
    loadAccount().then(r => alive && setDatabases(r.databases), e => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [connected])

  const count = groups.reduce((n, g) => n + g.items.length, 0)
  const chosen = target?.kind === kind ? target : null
  const pick = (t: { id: string; name: string }) => useDotion.setState({ target: { kind, id: t.id, name: t.name } })

  const send = async () => {
    if (!chosen) return
    setError(null)
    setProgress([0, groups.length])
    try {
      setResults(await sendToDotion(groups, chosen, (done, total) => setProgress([done, total])))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setProgress(null)
    }
  }

  const byWorkspace = new Map<string, DotionDatabase[]>()
  for (const d of databases ?? []) byWorkspace.set(d.workspace, [...(byWorkspace.get(d.workspace) ?? []), d])

  return (
    <Sheet open onClose={onClose} title="Send to Dotion" className="dotion-sheet">
      {!connected ? (
        <DotionAccount />
      ) : results ? (
        <>
          <p>Sent to <b>{chosen?.name}</b>.</p>
          <ul className="dotion-results">
            {results.map((r, i) => (
              <li key={i} className={r.status}>
                <div>
                  <strong>{r.book}</strong>
                  <span className="small">{STATUS[r.status](r)}</span>
                </div>
                {r.url && <button className="link-btn" onClick={() => openExternal(new URL(r.url!, url).href)}>Open</button>}
              </li>
            ))}
          </ul>
          <div className="sheet-actions">
            <span className="spacer" />
            <Button variant="primary" onClick={onClose}>Done</Button>
          </div>
        </>
      ) : (
        <>
          <p>{plural(count, 'highlight')} from {scope}. Send them to</p>
          <Segmented value={kind} onChange={setKind} options={[
            { value: 'database', label: 'A database' },
            { value: 'page', label: 'An existing page' },
          ]} />
          {kind === 'database' ? (
            <div className="dotion-pick">
              {databases === null ? (error ? null : <Spinner />) : (
                <select className="select full" aria-label="Database" value={chosen?.id ?? ''}
                  onChange={e => { const d = databases.find(x => x.id === e.target.value); if (d) pick(d) }}>
                  <option value="" disabled>Choose a database</option>
                  {[...byWorkspace].map(([ws, list]) => (
                    <optgroup key={ws} label={ws || 'Databases'}>
                      {list.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </optgroup>
                  ))}
                </select>
              )}
              <p className="muted small">Each book gets a page titled with its title. If the database already has a page with that title, the highlights it doesn’t have yet are added at its end.</p>
            </div>
          ) : (
            <div className="dotion-pick">
              <PagePicker chosen={chosen} onPick={p => pick({ id: p.id, name: p.title })} />
              <p className="muted small">Highlights are added at the end of this page, under each book’s title. Ones already on the page are skipped.</p>
            </div>
          )}
          <p className="muted small">Nothing in Dotion is changed or removed, so sending again only adds new highlights.</p>
          {error && <p className="small sync-error">{error}</p>}
          <div className="sheet-actions">
            <span className="spacer" />
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!chosen || !count || !!progress} onClick={send}>
              {progress ? <><Spinner size={16} />Sending {Math.min(progress[0] + 1, progress[1])} of {progress[1]}…</> : <><Send size={16} />Send {plural(count, 'highlight')}</>}
            </Button>
          </div>
        </>
      )}
    </Sheet>
  )
}

/** Finds a page by searching, or by a pasted link. */
const PagePicker = ({ chosen, onPick }: { chosen: { id: string; name: string } | null; onPick: (p: DotionPage) => void }) => {
  const [query, setQuery] = useState('')
  const [found, setFound] = useState<DotionPage[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setFound(null)
      return
    }
    let alive = true
    const t = setTimeout(async () => {
      try {
        const id = pageIdIn(q)
        const pages = id ? [await getPage(id).then(p => ({ id: p.id, title: p.title || 'Untitled', where: 'From the link' }))] : await searchPages(q)
        if (alive) {
          setFound(pages)
          setError(null)
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    }, 350)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [query])

  return (
    <>
      {chosen && <div className="dotion-chosen"><FileText size={16} /><b>{chosen.name}</b></div>}
      <div className="search-field">
        <Search size={16} />
        <input type="search" aria-label="Find a page" placeholder="Search your pages, or paste a page link" value={query} onChange={e => setQuery(e.target.value)} />
      </div>
      {error && <p className="small sync-error">{error}</p>}
      {found && (found.length ? (
        <ul className="dotion-pages">
          {found.map(p => (
            <li key={p.id}>
              <button type="button" aria-pressed={chosen?.id === p.id} onClick={() => onPick(p)}>
                <span>{p.title}</span>
                {p.where && <small>{p.where}</small>}
              </button>
            </li>
          ))}
        </ul>
      ) : <p className="muted small">No pages found.</p>)}
    </>
  )
}
