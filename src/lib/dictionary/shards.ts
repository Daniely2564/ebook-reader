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

export const fetchGz = async (path: string) => {
  const res = await fetch(publicUrl(path))
  if (!res.ok) throw new Error(`${res.status} ${path}`)
  return strFromU8(gunzipSync(new Uint8Array(await res.arrayBuffer())))
}

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
    return this.#split ??= fetch(publicUrl(`${this.#dir}/index.json`))
      .then(r => (r.ok ? r.json() : { split: [] }))
      .then((j: { split?: string[] }) => new Set(j.split ?? []))
      .catch(() => new Set<string>())
  }

  #shard(key: string) {
    let p = this.#cache.get(key)
    if (p) {
      // keep recently used shards
      this.#cache.delete(key)
      this.#cache.set(key, p)
      return p
    }
    p = fetchGz(`${this.#dir}/${key}.bin`)
      .then(text => JSON.parse(text) as Record<string, T>)
      .catch(() => ({}) as Record<string, T>)
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
