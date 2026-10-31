# Lumen Reader

A calm, fast ebook reader for **desktop (Electron)** and **Android (Capacitor)**. It opens EPUB, PDF, MOBI/AZW3, FB2 and CBZ files and includes **offline English dictionaries** built from Wiktionary, WordNet and Webster's 1913 (280,000+ words and phrases). Double-click (or long-press) any word to look it up, even without internet.

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
- PDF: continuous or page-by-page scrolling, two-page spreads, fit width / page / text (trims the margins), pinch, double-tap (zooms into the column) and Ctrl+wheel zoom, page tinting that follows the theme (sepia, inverted night mode), selectable text. Each PDF remembers its zoom and position, and turning pages keeps the column you're reading in view.
- **Flowing text** for PDFs (`V`): the PDF's text is rebuilt as an ebook, so it follows your font, size and theme on any screen. Headings (by size or bold), paragraphs, lists, bold and italic words, superscripts and figures are kept; footnotes wait until the paragraph they interrupt ends; title and part pages are centered on a page of their own; paragraphs stay whole across page breaks. Running headers and page numbers are dropped and hyphenated words rejoined. Highlights (even across a page break), bookmarks and your place carry over between flowing text and the original pages.
- Tap/click zones, swipe, mouse wheel and full keyboard control (press `?` in the reader).
- Table of contents, full-text search with highlighted results, footnote popups, a "Back to page X" chip after jumps, and reading position restore.

**Dictionary and language**
- Built-in offline dictionaries (about 51 MB):
  - **Wiktionary**: 177,000 English headwords plus 230,000 inflected, archaic and alternative forms, with usage labels (*transitive*, *archaic*, *botany*…), examples, synonyms, irregular forms, US/UK IPA, word origins, and recorded pronunciations from Wikimedia Commons (played when online).
  - **WordNet 3.1**: concise definitions with synonyms and opposites, plus CMU Pronouncing Dictionary IPA.
  - **Webster's Revised Unabridged Dictionary (1913)**: 102,000 entries with full, literary definitions, quotations, synonyms and phrases; good for older books (public domain).
  - **English–Korean** (from the Korean Wiktionary, 15,000 words), and translations of 40,000 common words into 21 languages, shown for the language picked under *My language*.
- Understands inflections and old spellings (`running → run`, `geese → goose`, `went → go`, `hath → have`, `colour → color`, `'tis`, `o'er`) and offers "did you mean" suggestions.
- Senses come in reading order: the part of speech a word is mostly used as first (*bear* → verb, *still* → adverb), then common meanings, with obsolete, rare, slang and specialist senses last. Frequencies come from WordNet's tagged corpus, which also fills in a few frequent meanings the distilled Wiktionary entries lack (*set* → a collection).
- The dictionary card opens on the dictionary you picked last (per book language) or on the default chosen in Settings, and stays there: when it has no entry for a word, or can't be reached, it says so and shows another dictionary's entry below. Each built-in dictionary can be turned off.
- Import **StarDict** dictionaries (`.ifo/.idx/.dict(.dz)`, or `.zip`/`.tar.gz`) for any language. `.dict.dz` files are read with random access, so big dictionaries stay fast.
- Optional online sources: Wiktionary.org (all languages), Wikipedia and recorded pronunciations, plus one-tap Google Translate and links to Merriam-Webster, Cambridge, Oxford Learner's, Collins, Longman, Dictionary.com, Vocabulary.com and Etymonline.
- Save words to **Vocabulary** with the sentence you found them in, review them as flashcards, and export to CSV (Anki-friendly).

**Notes and more**
- Highlights in 5 colors with notes, bookmarks, a Notes panel, and Markdown export.
- **Highlights** page: every highlight and note from all your books in one place, by book (in reading order) or by date, with search and color filters, and one click to jump back to the passage. Pick a cover on the shelf (or *Highlights* in a book's menu) to see just that book's highlights. Export what's shown as Markdown, as CSV for spreadsheets and database apps, or copy it as Markdown.
- **Read aloud** with sentence highlighting and automatic page turns (Web Speech on desktop, the native TTS engine on Android).
- Reading time and daily streak, "Continue reading", library search, filters, sort, and grid or list view.
- **Send to Dotion**: send highlights and notes (one book's, or all of them) to a Dotion database, one page per book, or add them to an existing page. Sending again only adds new highlights; nothing in Dotion is changed or removed.
- **Sync with Google Drive**: highlights, notes, bookmarks, vocabulary, reading positions and reading time stay the same on all your devices (desktop, Android, web), with an optional Markdown copy of each book's highlights in Drive to read in any app.
- Backup and restore of progress, highlights, vocabulary and stats as JSON.
- Everything stays on the device (IndexedDB) unless you turn on sync. No account or tracking.

## Getting started

Requirements: Node.js 20+ (22 recommended).

```bash
npm install
npm run dev            # web version at http://localhost:5173
npm run electron:dev   # desktop app with hot reload
```

`npm run dev` and `npm run build` first run `scripts/prepare.mjs`, which compiles the offline dictionaries into `public/dict/` (about a minute, and only when they or their sources change) and copies PDF.js assets into `public/pdfjs/`. Both folders are generated and git-ignored.

### Desktop packages

```bash
npm run dist:linux   # AppImage + .deb   → release/
npm run dist:win     # NSIS installer
npm run dist:mac     # .dmg
```

The packages register file associations for `.epub`, `.pdf`, `.mobi/.azw3`, `.fb2` and `.cbz`, so "Open with…" and double-clicking a book opens it in Lumen.

### Android

Requirements: JDK 21 and the Android SDK (Android Studio installs both). Set `ANDROID_HOME` if Gradle can't find the SDK. `npm run android:apk` uses `JAVA_HOME` when it is a JDK 21, and otherwise finds one where JDKs (or Android Studio's bundled one) are usually installed.

```bash
npm run android:apk        # build web app → sync → android/app/build/outputs/apk/debug/app-debug.apk
npm run android:open       # open the project in Android Studio
```

For a signed release build, set `LUMEN_KEYSTORE`, `LUMEN_KEYSTORE_PASSWORD`, `LUMEN_KEY_ALIAS` and `LUMEN_KEY_PASSWORD`, then run `npm run android:release`. The app registers as a handler for ebook and PDF files ("Open with Lumen Reader"), keeps the screen on while reading, and hides the system bars in the reader. The page always fills the screen behind the system bars (`MainActivity` gives it their size as `--safe-area-inset-*` CSS variables, in place of Capacitor's handling), so showing and hiding them doesn't lay the book out again.

#### Download the APK from GitHub Actions

Every push to `main` builds the APK (the Build workflow), and **Actions → Android APK → Run workflow** builds one for any branch. Open the run and download **lumen-reader-android** under *Artifacts*: a zip with

- `lumen-reader-<version>-<run>.apk`, a release build signed with your key (only when the signing secrets below are set). Each one installs over the last, keeping your library.
- `lumen-reader-<version>-<run>-debug.apk`, a debug build. Its key is made for that run, so uninstall other Lumen builds before installing it.

To get the release APK, create a signing key once (keep the file and its password safe and out of the repository: APKs signed with another key can't update the app):

```bash
keytool -genkeypair -v -keystore lumen-release.jks -alias lumen -keyalg RSA -keysize 2048 -validity 10000
```

Then add these repository secrets (**Settings → Secrets and variables → Actions**): `ANDROID_KEYSTORE_BASE64`, the file in base64 (`base64 -w0 lumen-release.jks` on Linux, `base64 -i lumen-release.jks` on macOS, `[Convert]::ToBase64String([IO.File]::ReadAllBytes("lumen-release.jks"))` in PowerShell); `ANDROID_KEYSTORE_PASSWORD`; `ANDROID_KEY_ALIAS` (`lumen`); and `ANDROID_KEY_PASSWORD` if the key's password differs from the keystore's.

### Sync with Google Drive

**Settings → Sync** keeps highlights, notes, bookmarks, vocabulary, reading positions and reading time in step across your devices through a "Lumen Reader" folder in your Google Drive. Lumen asks only for the `drive.file` scope, so it can see the files it creates there and nothing else. Each device connects once by entering a code at google.com/device. With **Save highlights as Markdown files** on, `Lumen Reader/Highlights` also gets one readable `.md` file per book, so your notes can be opened in Drive, Docs or a notes app.

Signing in needs a (free) Google OAuth client of your own:

1. In the [Google Cloud console](https://console.cloud.google.com/), create a project and enable the **Google Drive API**.
2. Under **Google Auth Platform**, set up the consent screen (audience *External*) and **publish** it. While it is in *Testing*, Google ends sign-ins after 7 days. `drive.file` needs no app verification.
3. Under **Clients**, create an OAuth client of type **TVs and Limited Input devices**.
4. Build it in with a git-ignored `.env.local` file (for CI builds, add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` repository secrets instead):

   ```ini
   VITE_GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
   VITE_GOOGLE_CLIENT_SECRET=GOCSPX-...
   ```

   Or leave it out of the build and paste the client ID and secret into Settings → Sync on each device. Google treats an installed app's client secret as public: it identifies the app and doesn't protect your data.

How it merges: each device combines its data with the copy in Drive. The newest edit of each highlight or note wins, deletions are remembered so they reach every device, a book's position follows the device that last turned a page (an open book offers to jump there), and reading time is counted per device and added up. Book files are not uploaded: add the same file on another device and it opens where you left off. Highlights of books that aren't on a device still show on its Highlights page. Removing a book while sync is on keeps its highlights.

### Send highlights to Dotion

In **Settings → Dotion**, paste an API token created on your Dotion's Developers page (`https://dotion-note.vercel.app/developers`, or your own Dotion address). Then, on the Highlights page, **Export → Send to Dotion…** sends what is shown, either:

- to a **database**: each book becomes a page titled with the book's title. If the database already has a page with that title (say, your own notes on the book), the highlights it doesn't have yet are added at its end under "Highlights from Lumen Reader";
- to an **existing page**, found by search or by pasting its link: highlights are added at its end under each book's title.

Highlights already on the page (as quotes) are skipped, so sending again is safe. The token is kept on the device. Dotion's API doesn't allow cross-origin requests, so the desktop app sends them from its main process and the Android app with native HTTP; the web version can only send to a Dotion server that allows its origin.

### Continuous integration

`.github/workflows/build.yml` type-checks the code, runs the end-to-end tests, then builds Linux/Windows/macOS packages and the Android APKs (`.github/workflows/android.yml`, which can also be run on its own) as workflow artifacts. Add the `ANDROID_KEYSTORE_*` secrets to get a signed release APK (see *Download the APK from GitHub Actions*), and `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to build in Google Drive sign-in.

### Tests

```bash
npm run typecheck
npm run test:e2e   # builds, serves the app and drives it in Chromium (set CHROMIUM_PATH if needed);
                   # the sync and Dotion tests run against fakes of Google Drive and Dotion
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
  build-dictionary.mjs     Wiktionary + WordNet + Webster + CMUdict → gzip shards in public/dict
  webster.mjs              parses Webster's 1913 into the same entry format as Wiktionary
  sense-order.mjs          puts senses in reading order using WordNet's corpus frequencies
  distill-wiktionary.mjs   distills kaikki.org Wiktionary dumps into data/wiktionary (run when updating)
  prepare.mjs              runs the dictionary build and copies PDF.js assets
  generate-icons.mjs       desktop and Android icons from public/icon.svg
data/wiktionary/     distilled Wiktionary data (CC BY-SA 4.0), input to build-dictionary.mjs
src/
  App.tsx                  shell, navigation, import, drag & drop, Android back button
  library/                 library grid/list, covers, details
  reader/
    Reader.tsx             reader UI shared by all formats
    epub-engine.ts         foliate-js engine (EPUB/MOBI/FB2/CBZ)
    pdf-engine.ts          PDF.js engine (original pages)
    pdf-flow.ts            PDF → reflowable book conversion for flowing text
    pdf-flow-engine.ts     flowing-text engine (foliate-js reading the converted PDF)
    read-aloud.ts          sentence-by-sentence TTS controller
  dictionary/              dictionary card and Dictionary page
  lib/dictionary/          Wiktionary + WordNet lookup and lemmatizer, StarDict reader, online sources, sanitizer
  lib/db.ts                IndexedDB storage (books, files, annotations, vocabulary, stats)
  lib/sync/                Google Drive sync: merge rules, sign-in and Drive calls, scheduling
  lib/dotion.ts            sending highlights to Dotion through its REST API
  highlights/              Highlights page and the Send to Dotion dialog
  settings/                Settings, including Sync and Dotion
  vendor/foliate-js/       vendored foliate-js (MIT)
tests/smoke.mjs            end-to-end test
tests/sync.mjs             end-to-end sync test (two devices, fake Google Drive)
tests/dotion.mjs           end-to-end Send to Dotion test (fake Dotion API)
tests/pdf.mjs              end-to-end test of selecting and highlighting in a PDF
```

## Licenses

Lumen Reader is MIT licensed. Bundled data and libraries keep their own licenses:
Wiktionary content from the English and Korean editions via kaikki.org (CC BY-SA 4.0, see `public/dict/LICENSES.txt` after building), WordNet 3.1 (WordNet License), Webster's Revised Unabridged Dictionary (1913, public domain, via Project Gutenberg), CMU Pronouncing Dictionary (BSD), foliate-js (MIT), PDF.js (Apache-2.0), and the fonts (SIL Open Font License).
