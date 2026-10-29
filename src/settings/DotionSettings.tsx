import { ExternalLink, KeyRound } from 'lucide-react'
import { useState } from 'react'
import { DOTION_URL, loadAccount, useDotion } from '../lib/dotion'
import { openExternal } from '../lib/platform'
import { toast } from '../lib/store'
import { Button, Spinner } from '../components/ui'

export const DotionSettings = () => {
  const target = useDotion(s => s.target)
  return (
    <div className="settings-section">
      <h3>Dotion</h3>
      <p className="muted small">
        Send highlights and notes to Dotion from the Highlights page (<b>Export → Send to Dotion</b>): each book as a page
        in a database, or added to a page you pick. Sending again only adds new highlights; nothing in Dotion is changed or removed.
      </p>
      <DotionAccount />
      {target && (
        <p className="muted small">
          Highlights go to the {target.kind === 'database' ? 'database' : 'page'} <b>{target.name}</b>. You can pick another one when you send.
        </p>
      )}
    </div>
  )
}

/** The API token: a form to add it, or whose it is. */
export const DotionAccount = () => {
  const s = useDotion()
  const [url, setUrl] = useState(s.url)
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (s.token && s.user) {
    return (
      <div className="card sync-card">
        <KeyRound size={20} />
        <div className="sync-card-main">
          <strong>Connected as {s.user}</strong>
          <span className="muted small">{s.url.replace(/^https?:\/\//, '')}</span>
        </div>
        <Button variant="ghost" onClick={() => useDotion.setState({ token: '', user: null })}>Forget token</Button>
      </div>
    )
  }

  const connect = async () => {
    setBusy(true)
    setError(null)
    useDotion.setState({ url: url.trim() || DOTION_URL, token })
    try {
      const { user } = await loadAccount()
      setToken('')
      toast(`Connected to Dotion as ${user}`, 'success')
    } catch (e) {
      useDotion.setState({ token: '', user: null })
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="card sync-setup">
      <p className="small">
        Create an API token on Dotion’s{' '}
        <button className="link-btn" onClick={() => openExternal(`${(url.trim() || DOTION_URL).replace(/\/+$/, '')}/developers`)}>Developers page<ExternalLink size={13} /></button>{' '}
        and paste it here. It is kept on this device only.
      </p>
      <label className="sync-field">
        <span>Dotion address</span>
        <input value={url} onChange={e => setUrl(e.target.value)} placeholder={DOTION_URL} spellCheck={false} autoComplete="off" />
      </label>
      <label className="sync-field">
        <span>API token</span>
        <input type="password" value={token} onChange={e => setToken(e.target.value.trim())} placeholder="dot_…" spellCheck={false} autoComplete="off"
          onKeyDown={e => e.key === 'Enter' && token && !busy && connect()} />
      </label>
      {error && <p className="small sync-error">{error}</p>}
      <div className="row-gap">
        <Button variant="primary" disabled={!token || busy} onClick={connect}>{busy && <Spinner size={16} />}Connect</Button>
      </div>
    </div>
  )
}
