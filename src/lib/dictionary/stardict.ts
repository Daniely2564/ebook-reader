// StarDict dictionary support: .ifo + .idx(.gz) + .dict(.dz) [+ .syn].
// .dict.dz files are read with random access (dictzip chunks), so even large
// dictionaries load instantly and use little memory.
import { gunzipSync, Inflate, unzipSync } from 'fflate'
import { getUserDicts, putUserDict, uid, type UserDictRecord } from '../db'
import { sanitizeHtml, textToHtml } from './sanitize'
import type { DictEntry } from './types'

const decoder = new TextDecoder()

// ---------------------------------------------------------------- dictzip
const inflateRaw = (data: Uint8Array) => {
  const parts: Uint8Array[] = []
  const inf = new Inflate(chunk => parts.push(chunk))
  inf.push(data, false)
  return concat(parts)
}

const concat = (parts: Uint8Array[]) => {
  if (parts.length === 1) return parts[0]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

class DictReader {
  #blob: Blob
  #chunkLen = 0
  #chunks: [number, number][] = []
  #data: Blob | null = null
  constructor(blob: Blob) {
    this.#blob = blob
  }
  /** Returns false if the file is plain gzip rather than dictzip. */
  async initZip() {
    const head = new Uint8Array(await this.#blob.slice(0, 12).arrayBuffer())
    if (head[0] !== 31 || head[1] !== 139 || head[2] !== 8) throw new Error('Not a gzip file')
    const flg = head[3]
    if (!(flg & 4)) return false
    const view = new DataView(head.buffer)
    const xlen = view.getUint16(10, true)
    const extra = new DataView(await this.#blob.slice(12, 12 + xlen).arrayBuffer())
    if (extra.getUint8(0) !== 82 || extra.getUint8(1) !== 65) return false // "RA"
    this.#chunkLen = extra.getUint16(6, true)
    const count = extra.getUint16(8, true)
    let pos = 0
    for (let i = 0; i < count; i++) {
      const size = extra.getUint16(10 + 2 * i, true)
      this.#chunks.push([pos, size])
      pos += size
    }
    let offset = 12 + xlen
    const tail = new Uint8Array(await this.#blob.slice(0, Math.min(offset + 1024, this.#blob.size)).arrayBuffer())
    if (flg & 8) offset = tail.indexOf(0, offset) + 1 // file name
    if (flg & 16) offset = tail.indexOf(0, offset) + 1 // comment
    if (flg & 2) offset += 2 // header crc
    this.#data = this.#blob.slice(offset)
    return true
  }
  async read(offset: number, size: number, zipped: boolean) {
    if (!zipped) return new Uint8Array(await this.#blob.slice(offset, offset + size).arrayBuffer())
    const first = Math.floor(offset / this.#chunkLen)
    const last = Math.floor((offset + size - 1) / this.#chunkLen)
    const start = this.#chunks[first][0]
    const end = this.#chunks[last][0] + this.#chunks[last][1]
    const buf = new Uint8Array(await this.#data!.slice(start, end).arrayBuffer())
    const parts: Uint8Array[] = []
    for (let i = first, p = 0; i <= last; i++) {
      const [, len] = this.#chunks[i]
      parts.push(inflateRaw(buf.subarray(p, p + len)))
      p += len
    }
    const all = concat(parts)
    const s = offset - first * this.#chunkLen
    return all.subarray(s, s + size)
  }
}

// ---------------------------------------------------------------- index
// StarDict sorts entries with g_ascii_strcasecmp, falling back to strcmp.
const asciiLower = (s: string) => s.replace(/[A-Z]/g, c => c.toLowerCase())
const cmp = (a: string, b: string) => {
  const x = asciiLower(a)
  const y = asciiLower(b)
  return x < y ? -1 : x > y ? 1 : 0
}

class Index {
  bytes!: Uint8Array
  starts!: Uint32Array
  ends!: Uint32Array
  offsets!: Float64Array
  sizes!: Uint32Array
  load(bytes: Uint8Array, opts: { syn?: boolean; offsetBits?: number }) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const starts: number[] = []
    const ends: number[] = []
    const offsets: number[] = []
    const sizes: number[] = []
    const is64 = opts.offsetBits === 64
    for (let i = 0; i < bytes.length;) {
      const z = bytes.indexOf(0, i)
      if (z < 0) break
      starts.push(i)
      ends.push(z)
      if (opts.syn) {
        offsets.push(view.getUint32(z + 1))
        i = z + 5
      } else {
        if (is64) {
          offsets.push(view.getUint32(z + 1) * 2 ** 32 + view.getUint32(z + 5))
          sizes.push(view.getUint32(z + 9))
          i = z + 13
        } else {
          offsets.push(view.getUint32(z + 1))
          sizes.push(view.getUint32(z + 5))
          i = z + 9
        }
      }
    }
    this.bytes = bytes
    this.starts = Uint32Array.from(starts)
    this.ends = Uint32Array.from(ends)
    this.offsets = Float64Array.from(offsets)
    this.sizes = Uint32Array.from(sizes)
    return this
  }
  get length() {
    return this.starts.length
  }
  word(i: number) {
    return decoder.decode(this.bytes.subarray(this.starts[i], this.ends[i]))
  }
  find(query: string) {
    let lo = 0
    let hi = this.length - 1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      const c = cmp(query, this.word(mid))
      if (c === 0) {
        let a = mid
        let b = mid
        while (a > 0 && cmp(query, this.word(a - 1)) === 0) a--
        while (b < this.length - 1 && cmp(query, this.word(b + 1)) === 0) b++
        return Array.from({ length: b - a + 1 }, (_, k) => a + k)
      }
      if (c < 0) hi = mid - 1
      else lo = mid + 1
    }
    return []
  }
}

// ---------------------------------------------------------------- dictionary
const renderField = (type: string, data: Uint8Array) => {
  const text = decoder.decode(data)
  switch (type) {
    case 'h': case 'g': case 'x':
      return `<div class="dict-field">${sanitizeHtml(text)}</div>`
    case 't': case 'y':
      return `<div class="dict-ipa">[${textToHtml(text)}]</div>`
    case 'm': case 'l': case 'k': case 'w': case 'n':
      return `<div class="dict-field dict-pre">${textToHtml(text)}</div>`
    default:
      return '' // resources, images, audio: not supported
  }
}

const parseEntry = (data: Uint8Array, seq?: string) => {
  const html: string[] = []
  let pos = 0
  const readField = (type: string, last: boolean) => {
    if (type === type.toUpperCase() && type !== type.toLowerCase()) {
      // binary types: 32-bit size prefix (except the last field of a sametypesequence)
      if (last && seq) return void (pos = data.length)
      const size = new DataView(data.buffer, data.byteOffset + pos, 4).getUint32(0)
      pos += 4 + size
      return
    }
    let end = last && seq ? data.length : data.indexOf(0, pos)
    if (end < 0) end = data.length
    html.push(renderField(type, data.subarray(pos, end)))
    pos = end + 1
  }
  if (seq) {
    for (let i = 0; i < seq.length && pos < data.length; i++) readField(seq[i], i === seq.length - 1)
  } else {
    while (pos < data.length) {
      const type = String.fromCharCode(data[pos++])
      readField(type, false)
    }
  }
  return html.join('')
}

export class StarDict {
  record: UserDictRecord
  #idx = new Index()
  #syn: Index | null = null
  #reader: DictReader
  #ready: Promise<void> | null = null
  constructor(record: UserDictRecord) {
    this.record = record
    this.#reader = new DictReader(record.dict)
  }
  #init() {
    return this.#ready ??= (async () => {
      const r = this.record
      this.#idx.load(new Uint8Array(await r.idx.arrayBuffer()), { offsetBits: Number(r.ifo.idxoffsetbits) || 32 })
      if (r.syn) this.#syn = new Index().load(new Uint8Array(await r.syn.arrayBuffer()), { syn: true })
      if (r.dictZipped) await this.#reader.initZip()
    })()
  }
  async lookup(query: string): Promise<DictEntry[]> {
    await this.#init()
    const ids = new Set(this.#idx.find(query))
    if (this.#syn) for (const i of this.#syn.find(query)) ids.add(this.#syn.offsets[i])
    const out: DictEntry[] = []
    for (const i of [...ids].slice(0, 6)) {
      const data = await this.#reader.read(this.#idx.offsets[i], this.#idx.sizes[i], this.record.dictZipped)
      out.push({ word: this.#idx.word(i), html: parseEntry(data, this.record.ifo.sametypesequence) })
    }
    return out
  }
}

const instances = new Map<string, StarDict>()
export const getStarDict = (record: UserDictRecord) => {
  let d = instances.get(record.id)
  if (!d || d.record !== record) {
    d = new StarDict(record)
    instances.set(record.id, d)
  }
  return d
}
export const forgetStarDict = (id: string) => instances.delete(id)

// ---------------------------------------------------------------- import
type FileLike = { name: string; blob: Blob }

const untar = (bytes: Uint8Array) => {
  const files: FileLike[] = []
  for (let pos = 0; pos + 512 <= bytes.length;) {
    const header = bytes.subarray(pos, pos + 512)
    if (header.every(b => b === 0)) break
    const name = decoder.decode(header.subarray(0, 100)).replace(/\0.*$/s, '')
    const size = parseInt(decoder.decode(header.subarray(124, 136)).replace(/\0.*$/s, '').trim() || '0', 8)
    const type = header[156]
    pos += 512
    if (type === 0 || type === 48) files.push({ name, blob: new Blob([bytes.slice(pos, pos + size)]) })
    pos += Math.ceil(size / 512) * 512
  }
  return files
}

const expand = async (files: File[]): Promise<FileLike[]> => {
  const out: FileLike[] = []
  for (const f of files) {
    const name = f.name.toLowerCase()
    if (name.endsWith('.zip')) {
      const entries = unzipSync(new Uint8Array(await f.arrayBuffer()))
      for (const [n, data] of Object.entries(entries)) if (data.length) out.push({ name: n, blob: new Blob([data]) })
    } else if (/\.(tar\.gz|tgz)$/.test(name)) {
      out.push(...untar(gunzipSync(new Uint8Array(await f.arrayBuffer()))))
    } else if (name.endsWith('.tar')) {
      out.push(...untar(new Uint8Array(await f.arrayBuffer())))
    } else if (/\.(tar\.bz2|tbz2?|tar\.xz|7z|rar)$/.test(name)) {
      throw new Error(`${f.name}: please extract this archive first, then select the .ifo, .idx and .dict files`)
    } else out.push({ name: f.name, blob: f })
  }
  return out
}

const baseName = (name: string) => name.split(/[\\/]/).pop()!
  .replace(/\.(ifo|idx\.gz|idx|dict\.dz|dict|syn\.dz|syn|syn\.gz)$/i, '')

export const importStarDict = async (files: File[]) => {
  const all = await expand(files)
  const groups = new Map<string, Record<string, FileLike>>()
  for (const f of all) {
    const m = f.name.toLowerCase().match(/\.(ifo|idx\.gz|idx|dict\.dz|dict|syn\.dz|syn\.gz|syn)$/)
    if (!m) continue
    const key = baseName(f.name)
    if (!groups.has(key)) groups.set(key, {})
    groups.get(key)![m[1]] = f
  }
  const existing = await getUserDicts()
  const added: UserDictRecord[] = []
  for (const [key, g] of groups) {
    if (!g.ifo) continue
    const idxFile = g['idx'] ?? g['idx.gz']
    const dictFile = g['dict'] ?? g['dict.dz']
    if (!idxFile || !dictFile) throw new Error(`${key}: missing .idx or .dict file`)
    const ifoText = decoder.decode(await g.ifo.blob.arrayBuffer())
    if (!ifoText.startsWith("StarDict's dict ifo file")) throw new Error(`${key}.ifo is not a StarDict file`)
    const ifo = Object.fromEntries(ifoText.split(/\r?\n/).slice(1)
      .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()])
      .filter(([k]) => k))

    let idx = idxFile.blob
    if (idxFile === g['idx.gz']) idx = new Blob([gunzipSync(new Uint8Array(await idx.arrayBuffer()))])
    let syn = g.syn?.blob
    const synGz = g['syn.dz'] ?? g['syn.gz']
    if (!syn && synGz) syn = new Blob([gunzipSync(new Uint8Array(await synGz.blob.arrayBuffer()))])

    let dict = dictFile.blob
    let dictZipped = dictFile === g['dict.dz']
    if (dictZipped && !(await new DictReader(dict).initZip())) {
      dict = new Blob([gunzipSync(new Uint8Array(await dict.arrayBuffer()))])
      dictZipped = false
    }
    const record: UserDictRecord = {
      id: uid(),
      name: ifo.bookname || key,
      wordCount: Number(ifo.wordcount) || 0,
      enabled: true,
      order: existing.length + added.length,
      ifo,
      idx,
      dict,
      dictZipped,
      syn,
      size: idx.size + dict.size + (syn?.size ?? 0),
      addedAt: Date.now(),
    }
    // sanity check: the dictionary must be readable
    const sd = new StarDict(record)
    const probe = new Index().load(new Uint8Array(await idx.arrayBuffer()), { offsetBits: Number(ifo.idxoffsetbits) || 32 })
    if (probe.length) await sd.lookup(probe.word(0))
    await putUserDict(record)
    added.push(record)
  }
  if (!added.length) throw new Error('No StarDict dictionary found. Select the .ifo, .idx and .dict(.dz) files, or a .zip/.tar.gz archive.')
  return added
}

