import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'

/**
 * Shown in the middle of the screen right after a visitor clicks the wall:
 * the three steps to paint, with step 1 already done.
 *
 * It stays open while the file picker is up. Once the image lands on the
 * wall (`imageLoaded`), the dark backdrop fades away so the image is
 * visible, the card glides to the bottom of the screen with step 2 ticked,
 * and after a few seconds (or "got it") it fades out and hands over to the
 * paint panel (`onDone`). Escape or an outside click before that just
 * closes it (`onClose`).
 */

interface Props {
  spot: { x: number; y: number }
  genesisLeft: number | null
  chainName?: string
  imageLoaded: boolean
  onChooseImage: () => void
  onClose: () => void
  onDone: () => void
}

const FADE_MS = 300
const HANDOVER_MS = 4000

export function SpotDialog({ spot, genesisLeft, chainName, imageLoaded, onChooseImage, onClose, onDone }: Props) {
  const [leaving, setLeaving] = useState(false)
  const leavingRef = useRef(false)
  // The parent passes fresh callbacks on every render (it re-renders on
  // mouse moves), so keep the latest in refs. Otherwise the hand-over timer
  // below would restart on every render and never fire while the mouse moves.
  const onCloseRef = useRef(onClose)
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onCloseRef.current = onClose
    onDoneRef.current = onDone
  })
  const close = useCallback(() => onCloseRef.current(), [])
  const done = useCallback(() => onDoneRef.current(), [])

  // Fade out, then tell the parent. Guarded so a timer and a click can't
  // both fire the callback.
  const leave = useCallback((then: () => void) => {
    if (leavingRef.current) return
    leavingRef.current = true
    setLeaving(true)
    window.setTimeout(then, FADE_MS)
  }, [])

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') leave(imageLoaded ? done : close)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [leave, imageLoaded, done, close])

  // Image placed: give the visitor a moment to see it, then hand over.
  useEffect(() => {
    if (!imageLoaded) return
    const id = window.setTimeout(() => leave(done), HANDOVER_MS)
    return () => window.clearTimeout(id)
  }, [imageLoaded, leave, done])

  const backdropClass = `spot-dialog-backdrop${imageLoaded ? ' is-loaded' : ''}${leaving ? ' is-leaving' : ''}`

  return (
    <div
      className={backdropClass}
      onClick={() => !imageLoaded && leave(close)}
      role="dialog"
      aria-modal={!imageLoaded}
      aria-labelledby="spot-dialog-title"
    >
      <div className="spot-dialog" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="spot-dialog-close"
          onClick={() => leave(imageLoaded ? done : close)}
          aria-label="Close"
        >
          ×
        </button>
        <h3 id="spot-dialog-title" className="spot-dialog-title">
          {imageLoaded ? 'looking good' : 'nice spot'}
        </h3>
        <ol className="spot-dialog-steps">
          <li className="is-done">
            <span className="spot-dialog-num">✓</span>
            <span>
              <strong>Pick a spot</strong>
              <span className="spot-dialog-sub">
                ({spot.x}, {spot.y})
              </span>
            </span>
          </li>
          <li className={imageLoaded ? 'is-done' : 'is-current'}>
            <span className="spot-dialog-num">{imageLoaded ? '✓' : '2'}</span>
            <span>
              <strong>Choose an image</strong>
              <span className="spot-dialog-sub">
                {imageLoaded
                  ? "It's on the wall, scaled to fit."
                  : "PNG, JPG or GIF. It's scaled to fit, and you can move or resize it after."}
              </span>
            </span>
          </li>
          <li className={imageLoaded ? 'is-current' : ''}>
            <span className="spot-dialog-num">3</span>
            <span>
              <strong>Paint</strong>
              <span className="spot-dialog-sub">
                {imageLoaded
                  ? 'Drag it to fine-tune, then connect your wallet and paint from the panel.'
                  : 'Connect your wallet and confirm. You see the price before you sign.'}
              </span>
            </span>
          </li>
        </ol>
        {!imageLoaded && genesisLeft != null && (
          <p className="spot-dialog-genesis">
            <Link to="/founders">
              {genesisLeft} genesis spots left{chainName ? ` on ${chainName}` : ''}. One pixel is enough.
            </Link>
          </p>
        )}
        <div className="spot-dialog-actions">
          {imageLoaded ? (
            <button type="button" className="spot-dialog-primary" onClick={() => leave(done)}>
              got it
            </button>
          ) : (
            <>
              <button type="button" className="spot-dialog-primary" onClick={onChooseImage}>
                choose an image
              </button>
              <button type="button" className="link-btn" onClick={() => leave(close)}>
                pick another spot
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
