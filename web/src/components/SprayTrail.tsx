import { useEffect, useRef } from 'react'

/**
 * Spray-paint cursor trail.
 *
 * A full-viewport canvas overlay that renders small colored dots scattered
 * around the cursor as it moves, fading each dot out over ~500ms. Emulates
 * a spray-can: a rainbow of hues cycles over time so a fast-moving cursor
 * leaves a streak of varied colour.
 *
 * Pointer-events none so it never intercepts a click. Mounted once by the
 * app layout so every route inherits it. Disabled via CSS on touch-only
 * devices (no hover) and for users with prefers-reduced-motion.
 */
export function SprayTrail() {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Respect reduced-motion: bail out of the animation entirely. The CSS
    // also hides the canvas, so this is belt-and-braces.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    // Skip on touch-only devices (no hover): matchMedia('(hover: none)') is
    // true when the primary pointer can't hover. Saves frame budget on
    // phones where the trail would be invisible anyway.
    if (window.matchMedia('(hover: none)').matches) return

    type Dot = {
      x: number
      y: number
      r: number
      age: number
      life: number
      hue: number
    }
    const dots: Dot[] = []
    let lastEmit = 0

    function resize() {
      if (!canvas) return
      // Backing store at 1×, not devicePixelRatio. The trail is soft
      // decoration (fuzzy colored dots), not text or vector art — the
      // extra resolution costs 4× GPU texture memory (≈ 60–80 MB on a
      // Retina viewport) for no perceptible quality gain. Dots at native
      // resolution look the same to the eye once they start fading out.
      canvas.width = window.innerWidth
      canvas.height = window.innerHeight
      canvas.style.width = `${window.innerWidth}px`
      canvas.style.height = `${window.innerHeight}px`
      ctx!.setTransform(1, 0, 0, 1, 0, 0)
    }
    resize()
    window.addEventListener('resize', resize)

    function onPointerMove(e: PointerEvent) {
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return
      // Skip emitting dots while the cursor is over the graffiti canvas
      // itself. The trail is meant to decorate the chrome; landing
      // spray-paint dots *on top of the canvas* creates a visual collision
      // with the painted pixels and tricks users into thinking the hover
      // tooltip is reading their own trail. Keep the chrome fun, keep the
      // canvas sacred.
      const t = e.target as Element | null
      if (t && typeof t.closest === 'function' && t.closest('.tagwall-canvas')) return
      const now = performance.now()
      if (now - lastEmit < 15) return
      lastEmit = now
      const count = 3 + Math.floor(Math.random() * 3)
      const hue = (now / 18) % 360
      for (let i = 0; i < count; i++) {
        dots.push({
          x: e.clientX + (Math.random() - 0.5) * 14,
          y: e.clientY + (Math.random() - 0.5) * 14,
          r: 1 + Math.random() * 2.5,
          age: 0,
          life: 380 + Math.random() * 220,
          hue,
        })
      }
      if (dots.length > 600) dots.splice(0, dots.length - 600)
      // Kick the rAF loop back on if it paused while the cursor was
      // stationary.
      start()
    }
    window.addEventListener('pointermove', onPointerMove, { passive: true })

    // Animation state: only tick rAF while dots are on screen. Running
    // the loop forever kept the compositor + GPU busy even with zero
    // dots, which on Retina viewports was 60–80 MB of GPU memory held
    // permanently. Now we pause the loop when dots empties out and
    // resume on the next pointermove that emits one.
    let raf = 0
    let last = performance.now()
    let running = false
    function loop(t: number) {
      const dt = t - last
      last = t
      ctx!.clearRect(0, 0, window.innerWidth, window.innerHeight)
      for (let i = dots.length - 1; i >= 0; i--) {
        const d = dots[i]
        d.age += dt
        if (d.age >= d.life) {
          dots.splice(i, 1)
          continue
        }
        const progress = d.age / d.life
        const alpha = (1 - progress) * 0.75
        ctx!.globalAlpha = alpha
        ctx!.fillStyle = `hsl(${d.hue}, 95%, 62%)`
        ctx!.beginPath()
        ctx!.arc(d.x, d.y, d.r * (1 - progress * 0.4), 0, Math.PI * 2)
        ctx!.fill()
      }
      ctx!.globalAlpha = 1
      if (dots.length === 0) {
        // Stop ticking. Leave the canvas cleared; it'll stay blank
        // until the next dot arrives via pointermove.
        running = false
        raf = 0
        return
      }
      raf = requestAnimationFrame(loop)
    }
    function start() {
      if (running) return
      running = true
      last = performance.now()
      raf = requestAnimationFrame(loop)
    }
    // Don't start the loop on mount; it'll kick in when the first dot
    // emits via pointermove. Idle tab sits with 0 rAF, 0 GPU work.

    return () => {
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onPointerMove)
      cancelAnimationFrame(raf)
    }
  }, [])

  return <canvas ref={canvasRef} className="spray-trail" aria-hidden />
}
