import { Cloud, CloudCheck, ExternalLink, FolderOpen, LogOut, RefreshCw } from 'lucide-react'
import { useEffect, useState } from 'react'
import { setMeta } from '../lib/db'
import { formatRelative } from '../lib/format'
import { openExternal } from '../lib/platform'
import { toast } from '../lib/store'
import { connect, disconnect, googleClient, requestSync, syncNow, useSync } from '../lib/sync'
import { builtInClient, finishSignIn, folderUrl, startSignIn, type DeviceCode } from '../lib/sync/google'
import { Button, Spinner, Switch } from '../components/ui'

export const SyncSettings = () => {
  const s = useSync()
  const client = googleClient()
  const connected = !!s.refreshToken && !!client
  const [signIn, setSignIn] = useState<{ code: DeviceCode; abort: AbortController } | null>(null)
  const [starting, setStarting] = useState(false)
  const [, tick] = useState(0)

  // stop waiting for the code when Settings closes; keep "last synced" current
  useEffect(() => () => signIn?.abort.abort(), [signIn])
  useEffect(() => {
    const iv = setInterval(() => tick(n => n + 1), 30_000)
    return () => clearInterval(iv)
  }, [])

  const start = async () => {
    if (!client) return
    setStarting(true)
    try {
      const code = await startSignIn(client)
      const abort = new AbortController()
      setSignIn({ code, abort })
      setStarting(false)
      const tokens = await finishSignIn(client, code, abort.signal)
      setSignIn(null)
      await connect(client, tokens)
      const { status, error } = useSync.getState()
      if (status === 'error') toast(error ?? 'Sync failed', 'error')
      else toast('Connected to Google Drive', 'success')
    } catch (e) {
      if (e instanceof TypeError) toast('Can’t reach Google. Check your internet connection.', 'error')
      else if ((e as Error)?.name !== 'AbortError') toast(e instanceof Error ? e.message : String(e), 'error')
      setSignIn(null)
    } finally {
      setStarting(false)
    }
  }

  const copyAndOpen = (code: DeviceCode) => {
    navigator.clipboard?.writeText(code.userCode).then(() => toast('Code copied'), () => {})
    openExternal(code.verificationUrl)
  }

  const status = s.status === 'syncing' ? 'Syncing…'
    : s.status === 'offline' ? 'Offline. Changes will sync when you’re back online.'
      : s.status === 'error' ? s.error
        : s.lastSyncAt ? `Last synced ${formatRelative(s.lastSyncAt)}` : 'Not synced yet'

  return (
    <div className="settings-section">
      <h3>Google Drive sync</h3>
      <p className="muted small">
        Keeps your highlights, notes, bookmarks, vocabulary, reading position and reading time the same on all your devices.
        They’re saved in a “Lumen Reader” folder in your Google Drive. Book files stay on each device: add the same book on another
        device and its highlights and place are already there.
      </p>

      {!client ? <ClientSetup /> : connected ? (
        <>
          <div className="card sync-card">
            <CloudCheck size={20} />
            <div className="sync-card-main">
              <strong>Connected{s.account ? ` as ${s.account}` : ''}</strong>
              <span className={`small ${s.status === 'error' ? 'sync-error' : 'muted'}`}>{status}</span>
            </div>
          </div>
          <div className="row-gap">
            <Button onClick={() => syncNow()} disabled={s.status === 'syncing'}>
              {s.status === 'syncing' ? <Spinner size={16} /> : <RefreshCw size={16} />}Sync now
            </Button>
            {s.folderId && <Button onClick={() => openExternal(folderUrl(s.folderId!))}><FolderOpen size={16} />Open in Drive</Button>}
            <Button variant="ghost" onClick={async () => {
              if (!confirm('Stop syncing on this device? Your data stays on this device and in Google Drive.')) return
              await disconnect()
              toast('Disconnected from Google Drive')
            }}><LogOut size={16} />Disconnect</Button>
          </div>
          <Switch label="Save highlights as Markdown files"
            hint="One file per book in Lumen Reader › Highlights, to read your highlights and notes in Google Drive or any notes app"
            checked={s.exportNotes} onChange={async v => {
              useSync.setState({ exportNotes: v })
              if (v) {
                await setMeta('notesExported', null)
                requestSync(0)
              }
            }} />
        </>
      ) : signIn ? (
        <div className="card sync-code">
          <p>On this or any other device, go to <b>{signIn.code.verificationUrl.replace(/^https?:\/\/(www\.)?/, '')}</b>, sign in and enter this code:</p>
          <div className="sync-code-value" aria-label="Code">{signIn.code.userCode}</div>
          <div className="row-gap">
            <Button variant="primary" onClick={() => copyAndOpen(signIn.code)}><ExternalLink size={16} />Copy code and open Google</Button>
            <Button variant="ghost" onClick={() => setSignIn(null)}>Cancel</Button>
          </div>
          <p className="muted small sync-wait"><Spinner size={14} />Waiting for you to allow access to Google Drive…</p>
        </div>
      ) : (
        <>
          {s.error && <p className="small sync-error">{s.error}</p>}
          <div className="row-gap">
            <Button variant="primary" onClick={start} disabled={starting}>{starting ? <Spinner size={16} /> : <Cloud size={16} />}Connect Google Drive</Button>
          </div>
          <p className="muted small">Lumen only sees the files it creates in your Drive.</p>
          {!builtInClient && (
            <p className="muted small">
              Using OAuth client <code>{client.id.replace(/\.apps\.googleusercontent\.com$/, '').slice(0, 24)}…</code>{' '}
              <button className="link-btn" onClick={() => useSync.setState({ clientId: '', clientSecret: '' })}>Change</button>
            </p>
          )}
        </>
      )}
    </div>
  )
}

/** For builds without a Google client compiled in: the user brings their own. */
const ClientSetup = () => {
  const [id, setId] = useState('')
  const [secret, setSecret] = useState('')
  return (
    <div className="card sync-setup">
      <p className="small">This copy of Lumen Reader has no Google sign-in client yet. Create one (it’s free) and paste it here:</p>
      <ol className="small">
        <li>In the <button className="link-btn" onClick={() => openExternal('https://console.cloud.google.com/apis/library/drive.googleapis.com')}>Google Cloud console</button>, create a project and enable the <b>Google Drive API</b>.</li>
        <li>Set up the consent screen (audience: External) and publish the app, so sign-ins don’t expire after a week.</li>
        <li>Create an OAuth client of type <b>TVs and Limited Input devices</b>.</li>
        <li>Paste its client ID and secret below. Use the same client on all your devices.</li>
      </ol>
      <label className="sync-field">
        <span>Client ID</span>
        <input value={id} onChange={e => setId(e.target.value.trim())} placeholder="1234…apps.googleusercontent.com" spellCheck={false} autoComplete="off" />
      </label>
      <label className="sync-field">
        <span>Client secret</span>
        <input value={secret} onChange={e => setSecret(e.target.value.trim())} placeholder="GOCSPX-…" spellCheck={false} autoComplete="off" />
      </label>
      <div className="row-gap">
        <Button variant="primary" disabled={!id || !secret} onClick={() => useSync.setState({ clientId: id, clientSecret: secret, error: null })}>Save</Button>
      </div>
    </div>
  )
}
