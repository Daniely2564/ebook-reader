# foliate-js (vendored)

Upstream: https://github.com/johnfactotum/foliate-js (MIT, see LICENSE).
Fetched from the `main` branch on 2026-10-18.

Local changes:
- `pdf.js` replaced by a stub; PDFs are rendered by Lumen's pdf.js viewer.
- `reader.js`, `opds.js`, `dict.js`, `ui/` and tests are not included.
- `paginator.js`: selection-safe paging. In paginated mode the container only
  scrolls where the paginator puts it (the browser's own scrolling while a
  selection is revealed or extended is undone); a touch only becomes a swipe
  after moving 10 px (not after a long press, and never while text is selected);
  `touchcancel` snaps back to a page; `pointercancel` ends a pointer selection;
  and the page no longer turns to follow a selection once the mouse is released.
  In scrolled mode, the first scroll after going to a place the view was already
  at (such as opening a book at its start) is reported as a relocation.
