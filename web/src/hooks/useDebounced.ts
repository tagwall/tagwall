import { useEffect, useState } from 'react'

/**
 * Returns a debounced copy of `value` that lags behind by `delayMs`. Updates
 * settle once the source has been stable for the delay, so mouse-driven state
 * doesn't fire a read on every mousemove.
 */
export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delayMs)
    return () => clearTimeout(id)
  }, [value, delayMs])
  return debounced
}
