import { X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from 'react'
import { createPortal } from 'react-dom'

type Btn = ButtonHTMLAttributes<HTMLButtonElement>

export const IconButton = ({ label, active, className = '', children, ...rest }: Btn & { label: string; active?: boolean }) => (
  <button type="button" aria-label={label} title={label} aria-pressed={active} className={`icon-btn ${active ? 'active' : ''} ${className}`} {...rest}>
    {children}
  </button>
)

export const Button = ({ variant = 'default', className = '', children, ...rest }: Btn & { variant?: 'default' | 'primary' | 'ghost' | 'danger' }) => (
  <button type="button" className={`btn btn-${variant} ${className}`} {...rest}>{children}</button>
)

export function Segmented<T extends string | number>({ value, options, onChange, className = '' }: {
  value: T
  options: { value: T; label: ReactNode; title?: string }[]
  onChange: (v: T) => void
  className?: string
}) {
  return (
    <div className={`segmented ${className}`} role="radiogroup">
      {options.map(o => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value} title={o.title}
          className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export const Slider = ({ value, min, max, step = 1, onChange, label, format, minLabel, maxLabel }: {
  value: number
  min: number
  max: number
  step?: number
  onChange: (v: number) => void
  label?: string
  format?: (v: number) => string
  minLabel?: ReactNode
  maxLabel?: ReactNode
}) => (
  <div className="slider-row">
    {label && <div className="slider-label"><span>{label}</span><span className="slider-value">{format ? format(value) : value}</span></div>}
    <div className="slider-track">
      {minLabel && <span className="slider-end">{minLabel}</span>}
      <input type="range" min={min} max={max} step={step} value={value} aria-label={label}
        style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
        onChange={e => onChange(Number(e.target.value))} />
      {maxLabel && <span className="slider-end">{maxLabel}</span>}
    </div>
  </div>
)

export const Switch = ({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: ReactNode; hint?: ReactNode }) => (
  <label className="switch-row">
    <span className="switch-text">
      <span>{label}</span>
      {hint && <small>{hint}</small>}
    </span>
    <input type="checkbox" role="switch" checked={checked} onChange={e => onChange(e.target.checked)} />
    <span className="switch" aria-hidden />
  </label>
)

/** Modal dialog that becomes a bottom sheet on phones. */
export const Sheet = ({ open, onClose, title, children, className = '', wide }: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  className?: string
  wide?: boolean
}) => {
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open, onClose])
  if (!open) return null
  return createPortal(
    <div className="sheet-backdrop" onPointerDown={e => e.target === e.currentTarget && onClose()}>
      <div className={`sheet ${wide ? 'wide' : ''} ${className}`} role="dialog" aria-modal="true">
        {title != null && (
          <div className="sheet-head">
            <h2>{title}</h2>
            <IconButton label="Close" onClick={onClose}><X size={20} /></IconButton>
          </div>
        )}
        <div className="sheet-body">{children}</div>
      </div>
    </div>,
    document.body,
  )
}

export interface MenuItem {
  label: string
  icon?: ReactNode
  onSelect: () => void
  danger?: boolean
  disabled?: boolean
}

/** Small dropdown menu anchored to its trigger. */
export const Menu = ({ trigger, items, align = 'end' }: {
  trigger: (props: { onClick: (e: React.MouseEvent) => void; 'aria-expanded': boolean }) => ReactNode
  items: (MenuItem | 'sep')[]
  align?: 'start' | 'end'
}) => {
  const [anchor, setAnchor] = useState<DOMRect | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  useLayoutEffect(() => {
    if (!anchor || !ref.current) return
    const w = ref.current.offsetWidth
    const h = ref.current.offsetHeight
    let left = align === 'end' ? anchor.right - w : anchor.left
    left = Math.max(8, Math.min(left, innerWidth - w - 8))
    let top = anchor.bottom + 6
    if (top + h > innerHeight - 8) top = Math.max(8, anchor.top - h - 6)
    setPos({ left, top })
  }, [anchor, align])
  useEffect(() => {
    if (!anchor) return
    const close = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) setAnchor(null)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setAnchor(null)
    setTimeout(() => document.addEventListener('pointerdown', close), 0)
    window.addEventListener('keydown', onKey)
    window.addEventListener('resize', close)
    return () => {
      document.removeEventListener('pointerdown', close)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', close)
    }
  }, [anchor])
  return (
    <>
      {trigger({
        onClick: e => {
          e.stopPropagation()
          setPos(null)
          setAnchor(anchor ? null : (e.currentTarget as HTMLElement).getBoundingClientRect())
        },
        'aria-expanded': !!anchor,
      })}
      {anchor && createPortal(
        <div ref={ref} className="menu" role="menu" style={pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden' }}>
          {items.map((it, i) => it === 'sep'
            ? <div key={i} className="menu-sep" />
            : (
              <button key={i} role="menuitem" type="button" disabled={it.disabled} className={it.danger ? 'danger' : ''}
                onClick={() => {
                  setAnchor(null)
                  it.onSelect()
                }}>
                {it.icon}<span>{it.label}</span>
              </button>
            ))}
        </div>,
        document.body,
      )}
    </>
  )
}

export const Empty = ({ icon, title, children }: { icon: ReactNode; title: string; children?: ReactNode }) => (
  <div className="empty">
    <div className="empty-icon">{icon}</div>
    <h3>{title}</h3>
    {children}
  </div>
)

export const Spinner = ({ size = 22 }: { size?: number }) => <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />
