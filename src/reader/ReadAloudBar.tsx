import { Pause, Play, SkipBack, SkipForward, Square } from 'lucide-react'
import { IconButton } from '../components/ui'
import type { ReadAloudState } from './read-aloud'

const RATES = [0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2]

export const ReadAloudBar = ({ state, rate, onToggle, onStop, onSkip, onRate }: {
  state: ReadAloudState
  rate: number
  onToggle: () => void
  onStop: () => void
  onSkip: (d: 1 | -1) => void
  onRate: (r: number) => void
}) => (
  <div className="tts-bar" role="toolbar" aria-label="Read aloud">
    <IconButton label="Previous sentence" onClick={() => onSkip(-1)}><SkipBack size={18} /></IconButton>
    <IconButton label={state === 'playing' ? 'Pause' : 'Play'} className="tts-main" onClick={onToggle}>
      {state === 'playing' ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
    </IconButton>
    <IconButton label="Next sentence" onClick={() => onSkip(1)}><SkipForward size={18} /></IconButton>
    <button className="tts-rate" title="Speed" onClick={() => onRate(RATES[(RATES.indexOf(rate) + 1) % RATES.length] ?? 1)}>{rate}×</button>
    <IconButton label="Stop" onClick={onStop}><Square size={16} fill="currentColor" /></IconButton>
  </div>
)
