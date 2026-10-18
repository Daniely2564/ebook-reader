import { useEffect, useRef } from 'react'

// A stack of "back" handlers so the Android back button (and Escape) closes
// the top-most popup/panel first, then leaves the reader.
const stack: { current: () => void }[] = []

export const useBackHandler = (handler: () => void, active = true) => {
  const ref = useRef(handler)
  ref.current = handler
  useEffect(() => {
    if (!active) return
    const entry = { get current() { return ref.current } }
    stack.push(entry)
    return () => {
      const i = stack.lastIndexOf(entry)
      if (i >= 0) stack.splice(i, 1)
    }
  }, [active])
}

/** Runs the top-most back handler; returns false if there was none. */
export const runBack = () => {
  const top = stack[stack.length - 1]
  if (!top) return false
  top.current()
  return true
}
