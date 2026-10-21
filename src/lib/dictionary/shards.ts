// Loads the gzip'd JSON shards written by scripts/build-dictionary.mjs.
import { gunzipSync, strFromU8 } from 'fflate'
import { publicUrl } from '../platform'

/** Must match shardKey() in scripts/build-dictionary.mjs. */
export const shardKey = (word: string, len = 2) => {
  const s = word.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  let k = ''
  for (const ch of s) {
    if (k.length === len) break
    k += /[a-z0-9]/.test(ch) ? ch : '_'
  }
  return k.padEnd(len, '_')
}

/** Must match shardFile() in scripts/build-dictionary.mjs: Windows can't create con.bin, prn.bin… */
export const shardFile = (key: string) => (/^(con|prn|aux|nul)$/.test(key) ? `${key}_` : key)

export class NotFound extends Error {}

export const fetchGz = async (path: string) => {
  const res = await fetch(publicUrl(path))
  if (res.status === 404) throw new NotFound(path)
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return strFromU8(gunzipSync(new Uint8Array(await res.arrayBuffer())))
}

/** Caches a load, except when it fails for a reason other than "not found", so it is retried. */
export const retryable = <T>(load: () => Promise<T>, fallback: T, forget: () => void): Promise<T> =>
  load().catch(e => {
    if (!(e instanceof NotFound)) forget()
    return fallback
  })

/** A dictionary split into shards by the first two (or three) letters, loaded on demand. */
export class ShardSource<T> {
  #dir: string
  #max: number
  #split: Promise<Set<string>> | null = null
  #cache = new Map<string, Promise<Record<string, T>>>()

  constructor(dir: string, maxShards = 32) {
    this.#dir = dir
    this.#max = maxShards
  }

  #index() {
    return this.#split ??= retryable(
      async () => {
        const r = await fetch(publicUrl(`${this.#dir}/index.json`))
        if (r.status === 404) return new Set<string>()
        if (!r.ok) throw new Error(`${r.status}`)
        return new Set<string>((await r.json() as { split?: string[] }).split ?? [])
      },
      new Set<string>(),
      () => (this.#split = null),
    )
  }

  #shard(key: string) {
    let p = this.#cache.get(key)
    if (p) {
      // keep recently used shards
      this.#cache.delete(key)
      this.#cache.set(key, p)
      return p
    }
    p = retryable(
      () => fetchGz(`${this.#dir}/${shardFile(key)}.bin`).then(text => JSON.parse(text) as Record<string, T>),
      {} as Record<string, T>,
      () => this.#cache.delete(key),
    )
    this.#cache.set(key, p)
    if (this.#cache.size > this.#max) this.#cache.delete(this.#cache.keys().next().value!)
    return p
  }

  async get(word: string): Promise<T | undefined> {
    if (!word) return undefined
    const split = await this.#index()
    const two = shardKey(word, 2)
    const shard = await this.#shard(split.has(two) ? shardKey(word, 3) : two)
    return Object.prototype.hasOwnProperty.call(shard, word) ? shard[word] : undefined
  }
}
