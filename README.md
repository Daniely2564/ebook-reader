# Lumen Reader

A calm, fast ebook reader for **desktop (Electron)** and **Android (Capacitor)**. It opens EPUB, PDF, MOBI/AZW3, FB2 and CBZ files and includes an **offline English dictionary** with 148,000+ words. Double-click (or long-press) any word to look it up, even without internet.

![Library](docs/screenshots/library-dark.jpg)

| Instant offline dictionary | Night theme with highlights |
| --- | --- |
| ![Dictionary popup](docs/screenshots/dictionary-popup.jpg) | ![Night theme](docs/screenshots/night-theme.jpg) |

| PDF with lookup | Search in book | Phone |
| --- | --- | --- |
| ![PDF](docs/screenshots/pdf-lookup.jpg) | ![Search](docs/screenshots/search.jpg) | ![Phone reader](docs/screenshots/phone-reader.jpg) |

## Features

**Reading**
- EPUB 2/3, MOBI/AZW3 (KF8), FB2/FBZ, CBZ, fixed-layout EPUB (rendered with [foliate-js](https://github.com/johnfactotum/foliate-js)), and PDF (rendered with [PDF.js](https://mozilla.github.io/pdf.js/)).
- Paginated two-column layout on wide screens or continuous scroll, with page-turn animation, running header, page numbers and "minutes left in chapter".
- 7 themes (Light, Paper, Sepia, Sage, Dusk, Night, Black), plus a brightness dimmer.
- Typography: 8 bundled fonts (Literata, Source Serif, Merriweather, Inter, Atkinson Hyperlegible, OpenDyslexic, and system fonts), size, weight, line spacing, letter spacing, paragraph spacing, margins, line length, justification and hyphenation.
- PDF: continuous or page-by-page scrolling, two-page spreads, fit width/page, pinch and Ctrl+wheel zoom, page tinting that follows the theme (sepia, inverted night mode), selectable text.
- Tap/click zones, swipe, mouse wheel and full keyboard control (press `?` in the reader).
- Table of contents, full-text search with highlighted results, footnote popups, a "Back to page X" chip after jumps, and reading position restore.

**Dictionary and language**
- Built-in offline dictionary: WordNet 3.1 (definitions, examples, synonyms, antonyms) + Wiktionary entries for function words (the, whom, amid, 'tis…) + 82,000 IPA pronunciations from the CMU Pronouncing Dictionary.
- Understands inflections (`running → run`, `geese → goose`, `went → go`) and offers "did you mean" suggestions.
- Import **StarDict** dictionaries (`.ifo/.idx/.dict(.dz)`, or `.zip`/`.tar.gz`) for any language. `.dict.dz` files are read with random access, so big dictionaries stay fast.
- Optional online sources: Wiktionary (all languages), Wikipedia and pronunciation audio, plus one-tap Google Translate.
- Save words to **Vocabulary** with the sentence you found them in, review them as flashcards, and export to CSV (Anki-friendly).

**Notes and more**
- Highlights in 5 colors with notes, bookmarks, a Notes panel, and Markdown export.
- **Read aloud** with sentence highlighting and automatic page turns (Web Speech on desktop, the native TTS engine on Android).
- Reading time and daily streak, "Continue reading", library search, filters, sort, and grid or list view.
- Backup and restore of progress, highlights, vocabulary and stats as JSON.
- Everything stays on the device (IndexedDB). No account or tracking.

## Getting started

Requirements: Node.js 20+ (22 recommended).

```bash
npm install
npm run dev            # web version at http://localhost:5173
npm run electron:dev   # desktop app with hot reload
```

`npm run dev` and `npm run build` first run `scripts/prepare.mjs`, which compiles the offline dictionary into `public/dict/` (about 7 s) and copies PDF.js assets into `public/pdfjs/`. Both folders are generated and git-ignored.

### Desktop packages

```bash
npm run dist:linux   # AppImage + .deb   → release/
npm run dist:win     # NSIS installer
npm run dist:mac     # .dmg
```

The packages register file associations for `.epub`, `.pdf`, `.mobi/.azw3`, `.fb2` and `.cbz`, so "Open with…" and double-clicking a book opens it in Lumen.

### Android

Requirements: JDK 21 and the Android SDK (Android Studio installs both). Set `ANDROID_HOME` if Gradle can't find the SDK.

```bash
npm run android:apk        # build web app → sync → android/app/build/outputs/apk/debug/app-debug.apk
npm run android:open       # open the project in Android Studio
```

For a signed release build, set `LUMEN_KEYSTORE`, `LUMEN_KEYSTORE_PASSWORD`, `LUMEN_KEY_ALIAS` and `LUMEN_KEY_PASSWORD`, then run `npm run android:release`. The app registers as a handler for ebook and PDF files ("Open with Lumen Reader"), keeps the screen on while reading, and hides the system bars in the reader.

### Continuous integration

`.github/workflows/build.yml` type-checks the code, runs the end-to-end smoke test, then builds Linux/Windows/macOS packages and Android APKs as workflow artifacts. Add the `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` secrets to get a signed release APK.

### Tests

```bash
npm run typecheck
npm run test:e2e   # builds, serves the app and drives it in Chromium (set CHROMIUM_PATH if needed)
```

## Before you publish

A few values are placeholders. Replace them with your own:
- `author`, `homepage` in `package.json` and `linux.maintainer` in `electron-builder.yml` (used by the `.deb`).
- `appId` (`app.lumenreader`) in `capacitor.config.ts`, `electron-builder.yml` and `android/app/build.gradle`, if you want a different package name.
- App icons are generated from `public/icon.svg` by `npm run icons` (needs Chromium via `playwright-core`).

## Project layout

```
electron/            main process (app:// protocol, file associations, menus) and preload bridge
android/             Capacitor Android project
scripts/
  build-dictionary.mjs     WordNet + Wiktionary + CMUdict → gzip shards in public/dict
  distill-wiktionary.mjs   one-time extraction of function words (output in scripts/data)
  prepare.mjs              runs the dictionary build and copies PDF.js assets
  generate-icons.mjs       desktop and Android icons from public/icon.svg
src/
  App.tsx                  shell, navigation, import, drag & drop, Android back button
  library/                 library grid/list, covers, details
  reader/
    Reader.tsx             reader UI shared by all formats
    epub-engine.ts         foliate-js engine (EPUB/MOBI/FB2/CBZ)
    pdf-engine.ts          PDF.js engine
    read-aloud.ts          sentence-by-sentence TTS controller
  dictionary/              dictionary card and Dictionary page
  lib/dictionary/          WordNet lookup + lemmatizer, StarDict reader, online sources, sanitizer
  lib/db.ts                IndexedDB storage (books, files, annotations, vocabulary, stats)
  vendor/foliate-js/       vendored foliate-js (MIT)
tests/smoke.mjs            end-to-end test
```

## Licenses

Lumen Reader is MIT licensed. Bundled data and libraries keep their own licenses:
WordNet 3.1 (WordNet License), Wiktionary content (CC BY-SA 4.0, see `public/dict/LICENSES.txt` after building), CMU Pronouncing Dictionary (BSD), foliate-js (MIT), PDF.js (Apache-2.0), and the fonts (SIL Open Font License).
