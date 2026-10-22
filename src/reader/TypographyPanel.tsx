import { AlignJustify, AlignLeft, Columns2, File, FileText, Minus, Plus, RotateCcw, ScrollText, Sun, TextWrap, X } from 'lucide-react'
import { useEffect } from 'react'
import { useSettings, type Settings } from '../lib/settings'
import { FONTS, injectFontPreviews, THEMES } from '../lib/themes'
import { IconButton, Segmented, Slider, Switch } from '../components/ui'
import type { ZoomAction } from './types'

const TEXT_KEYS: (keyof Settings)[] = ['font', 'fontSize', 'fontWeight', 'lineHeight', 'paragraphSpacing', 'letterSpacing', 'justify', 'hyphenate', 'margin', 'maxWidth', 'flow', 'columns', 'animated', 'runningHeads', 'overrideColors']
const PDF_KEYS: (keyof Settings)[] = ['pdfThemed', 'pdfScroll', 'pdfSpread', 'pdfZoom']
const ZOOM_FITS: { value: string; action: ZoomAction; label: string; title: string }[] = [
  { value: 'auto', action: 'reset', label: 'Auto', title: 'Automatic' },
  { value: 'page-width', action: 'fit-width', label: 'Width', title: 'Fit the page width' },
  { value: 'page-fit', action: 'fit-page', label: 'Page', title: 'Fit the whole page' },
  { value: 'text-width', action: 'fit-text', label: 'Text', title: 'Fit the text, trimming the margins' },
]

export const TypographyPanel = ({ open, onClose, kind, pdfView, onPdfView, onZoom, zoomLabel, zoomMode }: {
  open: boolean
  onClose: () => void
  kind: 'reflowable' | 'pdf'
  /** set for PDF books: the original pages or flowing text */
  pdfView?: 'pages' | 'flow'
  onPdfView?: (v: 'pages' | 'flow') => void
  onZoom?: (a: ZoomAction) => void
  zoomLabel?: string
  zoomMode?: string
}) => {
  const s = useSettings()
  useEffect(() => {
    if (open) injectFontPreviews()
  }, [open])
  if (!open) return null
  return (
    <>
      <div className="typo-backdrop" onClick={onClose} />
      <div className="typo-panel" role="dialog" aria-label="Reading settings">
        <div className="typo-head">
          <h3>Appearance</h3>
          <IconButton label="Reset to defaults" onClick={() => s.reset(['theme', 'brightness', ...(kind === 'pdf' ? PDF_KEYS : TEXT_KEYS)])}><RotateCcw size={17} /></IconButton>
          <IconButton label="Close" onClick={onClose}><X size={19} /></IconButton>
        </div>
        <div className="typo-body">
          {pdfView && (
            <>
              <Segmented className="view-toggle" value={pdfView} onChange={v => onPdfView?.(v)} options={[
                { value: 'pages', label: <><FileText size={15} />Original pages</>, title: 'Show the PDF pages as they are' },
                { value: 'flow', label: <><TextWrap size={15} />Flowing text</>, title: 'Rebuild the text so it fits the screen and follows your font settings' },
              ]} />
              <p className="typo-hint">
                {pdfView === 'flow'
                  ? 'The text is rebuilt to fit your screen. Switch back to original pages for tables, equations or complex layouts.'
                  : 'Flowing text fits the words to your screen, like an ebook, so there is no zooming or panning.'}
              </p>
            </>
          )}
          <div className="themes">
            {THEMES.map(t => (
              <button key={t.id} className={`theme-swatch ${s.theme === t.id ? 'on' : ''}`} onClick={() => s.set({ theme: t.id })}
                style={{ background: t.bg, color: t.fg, borderColor: s.theme === t.id ? undefined : t.border }} title={t.name} aria-label={`${t.name} theme`}>
                <span className="theme-aa">Aa</span>
                <span className="theme-name">{t.name}</span>
              </button>
            ))}
          </div>
          <Slider label="Brightness" min={0.35} max={1} step={0.01} value={s.brightness} onChange={v => s.set({ brightness: v })}
            format={v => `${Math.round(v * 100)}%`} minLabel={<Sun size={13} />} maxLabel={<Sun size={18} />} />

          {kind === 'reflowable' ? (
            <>
              <div className="typo-section">Font</div>
              <div className="font-grid">
                {FONTS.map(f => (
                  <button key={f.id} className={`font-card ${s.font === f.id ? 'on' : ''}`} onClick={() => s.set({ font: f.id })}
                    style={{ fontFamily: f.family || 'inherit' }} title={f.note}>
                    <span className="font-sample">Ag</span>
                    <span className="font-name">{f.name}</span>
                  </button>
                ))}
              </div>
              <div className="size-row">
                <IconButton label="Smaller text" onClick={() => s.set({ fontSize: Math.max(12, s.fontSize - 1) })}><Minus size={16} /></IconButton>
                <Slider min={12} max={40} value={s.fontSize} onChange={v => s.set({ fontSize: v })} label="Size" format={v => `${v}px`} />
                <IconButton label="Larger text" onClick={() => s.set({ fontSize: Math.min(40, s.fontSize + 1) })}><Plus size={16} /></IconButton>
              </div>
              <Slider label="Line spacing" min={1.1} max={2.4} step={0.05} value={s.lineHeight} onChange={v => s.set({ lineHeight: v })} format={v => v.toFixed(2)} />
              <Slider label="Weight" min={300} max={700} step={25} value={s.fontWeight} onChange={v => s.set({ fontWeight: v })} format={v => (v === 400 ? 'Regular' : String(v))} />
              <Slider label="Letter spacing" min={-0.02} max={0.12} step={0.005} value={s.letterSpacing} onChange={v => s.set({ letterSpacing: v })} format={v => (v === 0 ? 'Normal' : `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}%`)} />
              <div className="typo-row">
                <span>Paragraph spacing</span>
                <Segmented value={s.paragraphSpacing} onChange={v => s.set({ paragraphSpacing: v })} options={[
                  { value: -1, label: 'Book' }, { value: 0, label: 'None' }, { value: 0.6, label: 'Some' }, { value: 1.2, label: 'More' },
                ]} />
              </div>
              <div className="typo-row">
                <span>Alignment</span>
                <Segmented value={s.justify ? 1 : 0} onChange={v => s.set({ justify: v === 1 })} options={[
                  { value: 0, label: <AlignLeft size={16} />, title: 'Left aligned' }, { value: 1, label: <AlignJustify size={16} />, title: 'Justified' },
                ]} />
              </div>
              <Switch label="Hyphenation" checked={s.hyphenate} onChange={v => s.set({ hyphenate: v })} />

              <div className="typo-section">Layout</div>
              <div className="typo-row">
                <span>Mode</span>
                <Segmented value={s.flow} onChange={v => s.set({ flow: v })} options={[
                  { value: 'paginated', label: <><FileText size={15} />Pages</> }, { value: 'scrolled', label: <><ScrollText size={15} />Scroll</> },
                ]} />
              </div>
              {s.flow === 'paginated' && (
                <div className="typo-row">
                  <span>Columns</span>
                  <Segmented value={s.columns} onChange={v => s.set({ columns: v })} options={[
                    { value: 1, label: <File size={15} />, title: 'Single column' }, { value: 2, label: <Columns2 size={15} />, title: 'Two columns on wide screens' },
                  ]} />
                </div>
              )}
              <Slider label="Margins" min={0} max={20} step={0.5} value={s.margin} onChange={v => s.set({ margin: v })} format={v => `${v}%`} />
              <Slider label="Line length" min={420} max={1100} step={20} value={s.maxWidth} onChange={v => s.set({ maxWidth: v })} format={v => `${v}px`} />
              {s.flow === 'paginated' && <Switch label="Page turn animation" checked={s.animated} onChange={v => s.set({ animated: v })} />}
              <Switch label="Running header & page numbers" checked={s.runningHeads} onChange={v => s.set({ runningHeads: v })} />
              <div className="typo-row">
                <span>Use theme colors for text</span>
                <Segmented value={s.overrideColors} onChange={v => s.set({ overrideColors: v })} options={[
                  { value: 'auto', label: 'Dark only' }, { value: 'always', label: 'Always' }, { value: 'never', label: 'Never' },
                ]} />
              </div>
            </>
          ) : (
            <>
              <div className="typo-section">Zoom</div>
              <div className="typo-row">
                <span>Fit</span>
                <div className="zoom-btns">
                  <IconButton label="Zoom out" onClick={() => onZoom?.('out')}><Minus size={16} /></IconButton>
                  <span className="zoom-value">{zoomLabel}</span>
                  <IconButton label="Zoom in" onClick={() => onZoom?.('in')}><Plus size={16} /></IconButton>
                </div>
              </div>
              <Segmented className="view-toggle" value={ZOOM_FITS.some(z => z.value === zoomMode) ? zoomMode! : ''} onChange={v => {
                const fit = ZOOM_FITS.find(z => z.value === v)!
                // also the starting zoom for PDFs opened for the first time
                s.set({ pdfZoom: v })
                onZoom?.(fit.action)
              }} options={ZOOM_FITS.map(z => ({ value: z.value, label: z.label, title: z.title }))} />
              <p className="typo-hint">Pinch to zoom, or double-tap a column to zoom into it. Each PDF keeps its zoom and position.</p>

              <div className="typo-section">Pages</div>
              <div className="typo-row">
                <span>Scrolling</span>
                <Segmented value={s.pdfScroll} onChange={v => s.set({ pdfScroll: v })} options={[
                  { value: 'continuous', label: <><ScrollText size={15} />Continuous</> }, { value: 'paged', label: <><FileText size={15} />Page by page</> },
                ]} />
              </div>
              <div className="typo-row">
                <span>Spread</span>
                <Segmented value={s.pdfSpread} onChange={v => s.set({ pdfSpread: v })} options={[
                  { value: 'none', label: <File size={15} />, title: 'Single pages' }, { value: 'odd', label: <Columns2 size={15} />, title: 'Two-page spread' },
                ]} />
              </div>
              <Switch label="Tint pages with theme" hint="Recolors pages to match Sepia, Night and other themes" checked={s.pdfThemed} onChange={v => s.set({ pdfThemed: v })} />
            </>
          )}
        </div>
      </div>
    </>
  )
}
