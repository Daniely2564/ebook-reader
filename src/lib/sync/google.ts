// Google sign-in and Drive storage for sync. Sign-in uses the device flow ("enter this code at
// google.com/device"), which works the same in Electron, the Android WebView and a browser, and
// needs no redirect back into the app. Google's OAuth and Drive endpoints allow CORS, so everything
// runs in the renderer.

const OAUTH = 'https://oauth2.googleapis.com'
const API = 'https://www.googleapis.com/drive/v3'
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3'
/** only files this app created: the sync file and the Markdown notes */
const SCOPE = 'https://www.googleapis.com/auth/drive.file'
const FOLDER = 'application/vnd.google-apps.folder'

export interface GoogleClient {
  id: string
  secret: string
}

/** The OAuth client compiled into this build, if any (see README, "Sync with Google Drive"). */
export const builtInClient: GoogleClient | null = import.meta.env.VITE_GOOGLE_CLIENT_ID
  ? { id: import.meta.env.VITE_GOOGLE_CLIENT_ID, secret: import.meta.env.VITE_GOOGLE_CLIENT_SECRET ?? '' }
  : null

/** Google no longer accepts this sign-in: the user has to connect again. */
export class SignedOutError extends Error {}

const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const t = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => {
    clearTimeout(t)
    reject(new DOMException('Cancelled', 'AbortError'))
  }, { once: true })
})

const postForm = async (path: string, params: Record<string, string>, signal?: AbortSignal) => {
  const res = await fetch(OAUTH + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal,
  })
  return { ok: res.ok, json: await res.json().catch(() => ({})) as Record<string, any> }
}

const oauthMessage = (json: Record<string, any>) => {
  if (json.error === 'invalid_client') return 'Google doesn’t recognize this OAuth client. Check the client ID and secret.'
  if (json.error === 'unauthorized_client') return 'This OAuth client can’t sign in with a code. Create one of type “TVs and Limited Input devices”.'
  if (json.error === 'invalid_scope') return 'This OAuth client isn’t allowed to use Google Drive.'
  return json.error_description || json.error || 'Google sign-in failed'
}

// ---------------------------------------------------------------- sign-in

export interface DeviceCode {
  deviceCode: string
  userCode: string
  verificationUrl: string
  interval: number
  expiresAt: number
}

export interface Tokens {
  accessToken: string
  expiresAt: number
  refreshToken: string
}

export const startSignIn = async (client: GoogleClient): Promise<DeviceCode> => {
  const { ok, json } = await postForm('/device/code', { client_id: client.id, scope: SCOPE })
  if (!ok) throw new Error(oauthMessage(json))
  return {
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUrl: json.verification_url ?? json.verification_uri ?? 'https://www.google.com/device',
    interval: Math.max(1, Number(json.interval) || 5),
    expiresAt: Date.now() + (Number(json.expires_in) || 1800) * 1000,
  }
}

/** Waits until the code is entered and access is allowed (or denied). */
export const finishSignIn = async (client: GoogleClient, code: DeviceCode, signal?: AbortSignal): Promise<Tokens> => {
  let interval = code.interval
  while (Date.now() < code.expiresAt) {
    await sleep(interval * 1000, signal)
    const { ok, json } = await postForm('/token', {
      client_id: client.id,
      client_secret: client.secret,
      device_code: code.deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }, signal).catch(e => {
      if (signal?.aborted) throw e
      return { ok: false, json: { error: 'authorization_pending' } as Record<string, any> } // offline for a moment: keep waiting
    })
    if (ok) {
      if (!json.refresh_token) throw new Error('Google didn’t allow offline access. Try connecting again.')
      return { accessToken: json.access_token, expiresAt: Date.now() + json.expires_in * 1000, refreshToken: json.refresh_token }
    }
    if (json.error === 'authorization_pending') continue
    if (json.error === 'slow_down') {
      interval += 5
      continue
    }
    if (json.error === 'access_denied') throw new Error('Access to Google Drive was not allowed.')
    if (json.error === 'expired_token') break
    throw new Error(oauthMessage(json))
  }
  throw new Error('The code expired. Connect again to get a new one.')
}

export const revoke = (token: string) =>
  fetch(`${OAUTH}/revoke?token=${encodeURIComponent(token)}`, { method: 'POST' }).catch(() => {})

// ---------------------------------------------------------------- Drive

export interface DriveFile {
  id: string
  name: string
  version?: string
  createdTime?: string
  appProperties?: Record<string, string>
}

const FILE_FIELDS = 'id,name,version,createdTime,appProperties'

export class DriveError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

export class Drive {
  #client: GoogleClient
  #refreshToken: string
  #access: { token: string; expiresAt: number } | null

  constructor(client: GoogleClient, refreshToken: string, access?: Tokens) {
    this.#client = client
    this.#refreshToken = refreshToken
    this.#access = access ? { token: access.accessToken, expiresAt: access.expiresAt } : null
  }

  async #token() {
    if (this.#access && this.#access.expiresAt - 60_000 > Date.now()) return this.#access.token
    const { ok, json } = await postForm('/token', {
      client_id: this.#client.id,
      client_secret: this.#client.secret,
      refresh_token: this.#refreshToken,
      grant_type: 'refresh_token',
    })
    if (!ok) {
      if (['invalid_grant', 'invalid_client', 'unauthorized_client'].includes(json.error))
        throw new SignedOutError('Google Drive access has ended. Connect again to keep syncing.')
      throw new Error(oauthMessage(json))
    }
    this.#access = { token: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 }
    return this.#access.token
  }

  async #fetch(url: string, init: RequestInit = {}, attempt = 0): Promise<Response> {
    const res = await fetch(url, { ...init, headers: { ...init.headers, Authorization: `Bearer ${await this.#token()}` } })
    if (res.ok) return res
    const body = await res.json().catch(() => ({})) as { error?: { message?: string; errors?: { reason?: string }[] } }
    const reason = body.error?.errors?.[0]?.reason ?? ''
    if (res.status === 401 && attempt === 0) {
      this.#access = null
      return this.#fetch(url, init, attempt + 1)
    }
    if ((res.status === 429 || res.status >= 500 || /rateLimit/i.test(reason)) && attempt < 3) {
      await sleep(1000 * 2 ** attempt + Math.random() * 500)
      return this.#fetch(url, init, attempt + 1)
    }
    throw new DriveError(res.status, body.error?.message || `Google Drive error ${res.status}`)
  }

  async #json<T>(url: string, init?: RequestInit) {
    return await (await this.#fetch(url, init)).json() as T
  }

  user() {
    return this.#json<{ user?: { displayName?: string; emailAddress?: string } }>(`${API}/about?fields=user(displayName,emailAddress)`)
      .then(r => r.user ?? {})
  }

  async list(q: string) {
    const files: DriveFile[] = []
    let pageToken = ''
    do {
      const params = new URLSearchParams({ q: `${q} and trashed = false`, spaces: 'drive', orderBy: 'createdTime', pageSize: '200', fields: `nextPageToken,files(${FILE_FIELDS})` })
      if (pageToken) params.set('pageToken', pageToken)
      const r = await this.#json<{ files: DriveFile[]; nextPageToken?: string }>(`${API}/files?${params}`)
      files.push(...r.files)
      pageToken = r.nextPageToken ?? ''
    } while (pageToken)
    return files
  }

  /** Files this app tagged with `lumen=<role>`, oldest first. */
  byRole(role: string, parent?: string) {
    return this.list(`appProperties has { key='lumen' and value='${role}' }${parent ? ` and '${parent}' in parents` : ''}`)
  }

  async get(id: string) {
    try {
      const f = await this.#json<DriveFile & { trashed?: boolean }>(`${API}/files/${id}?fields=${FILE_FIELDS},trashed`)
      return f.trashed ? null : f
    } catch (e) {
      if (e instanceof DriveError && e.status === 404) return null
      throw e
    }
  }

  async read(id: string) {
    return (await this.#fetch(`${API}/files/${id}?alt=media`)).text()
  }

  /** Finds the folder tagged `role` (the oldest, if two devices made one at once), or makes it. */
  async folder(role: string, name: string, parent?: string) {
    const [found] = await this.byRole(role, parent)
    if (found) return found.id
    return (await this.#json<DriveFile>(`${API}/files?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, mimeType: FOLDER, parents: parent ? [parent] : undefined, appProperties: { lumen: role } }),
    })).id
  }

  create(meta: { name: string; parents: string[]; appProperties: Record<string, string> }, content: string, type: string) {
    return this.#json<DriveFile>(`${UPLOAD}/files?uploadType=multipart&fields=${FILE_FIELDS}`, { method: 'POST', ...multipart({ ...meta, mimeType: type }, content, type) })
  }

  /** Replaces a file's content, and its name and properties when given. */
  update(id: string, content: string, type: string, meta?: { name?: string; appProperties?: Record<string, string> }) {
    return meta
      ? this.#json<DriveFile>(`${UPLOAD}/files/${id}?uploadType=multipart&fields=${FILE_FIELDS}`, { method: 'PATCH', ...multipart(meta, content, type) })
      : this.#json<DriveFile>(`${UPLOAD}/files/${id}?uploadType=media&fields=${FILE_FIELDS}`, {
        method: 'PATCH', headers: { 'Content-Type': `${type}; charset=UTF-8` }, body: content,
      })
  }

  async trash(id: string) {
    await this.#fetch(`${API}/files/${id}?fields=id`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }),
    })
  }
}

const multipart = (meta: object, content: string, type: string) => {
  const boundary = `lumen-${Math.random().toString(36).slice(2)}`
  return {
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body: [
      `--${boundary}`, 'Content-Type: application/json; charset=UTF-8', '', JSON.stringify(meta),
      `--${boundary}`, `Content-Type: ${type}; charset=UTF-8`, '', content,
      `--${boundary}--`, '',
    ].join('\r\n'),
  }
}

export const folderUrl = (id: string) => `https://drive.google.com/drive/folders/${id}`
