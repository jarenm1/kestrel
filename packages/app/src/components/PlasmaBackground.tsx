import { useEffect, useRef } from "react"

/** Frame interval: 15 fps is plenty for a slow background and keeps the main thread mostly idle. */
const FRAME_MS = 66
/** Plasma scale: radians per dot. */
const SCALE = 0.035
/** Braille cell: 2 dots wide, 4 tall. Bit for the dot at (column, row), per the Unicode braille block. */
const DOT_BITS = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]
/** 4×4 ordered-dither thresholds: the plasma's brightness becomes dot density, so it reads as a gradient. */
const BAYER = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
].map((row) => row.map((v) => (v + 0.5) / 16))
const BRAILLE = Array.from({ length: 256 }, (_, bits) => String.fromCharCode(0x2800 + bits))

/**
 * The plasma from dotmax's demo, drawn as braille text: each character is a 2×4 grid of dots switched on by
 * ordered dithering, so brightness shows as dot density. Greyscale, slow, and still when reduced motion is on.
 */
export function PlasmaBackground({ className }: { className?: string }) {
  const screenRef = useRef<HTMLPreElement>(null)
  const probeRef = useRef<HTMLSpanElement>(null)

  useEffect(() => {
    const screen = screenRef.current
    const probe = probeRef.current
    if (!screen || !probe) return
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches
    let cols = 0
    let rows = 0
    let frame = 0
    let last = -Infinity

    const measure = () => {
      const cell = probe.getBoundingClientRect()
      const box = screen.getBoundingClientRect()
      // The probe holds 10 characters, so its width averages out sub-pixel glyph widths.
      cols = Math.ceil(box.width / (cell.width / 10)) + 1
      rows = Math.ceil(box.height / cell.height) + 1
    }

    const draw = (time: number) => {
      const t = time / 4000
      const width = cols * 2
      const height = rows * 4
      // Classic sum-of-sines plasma: sin(u+t) + sin((v+t)/2) + sin((u+v+t)/2) + a moving radial ripple.
      // The first three terms are separable (the third via the sine sum identity), so they cost O(width + height)
      // sines per frame; the radial term is sampled once per character. Together: about 10× fewer sines.
      const xWave = new Float32Array(width)
      const xHalfSin = new Float32Array(width)
      const xHalfCos = new Float32Array(width)
      for (let x = 0; x < width; x++) {
        const u = x * SCALE
        xWave[x] = Math.sin(u + t)
        xHalfSin[x] = Math.sin(u / 2)
        xHalfCos[x] = Math.cos(u / 2)
      }
      const yHalfSin = new Float32Array(height)
      const yHalfCos = new Float32Array(height)
      for (let y = 0; y < height; y++) {
        const half = (y * SCALE + t) / 2
        yHalfSin[y] = Math.sin(half)
        yHalfCos[y] = Math.cos(half)
      }
      const centreX = 2.5 + Math.sin(t * 0.3) * 1.5
      const centreY = 1.5 - Math.cos(t * 0.25) * 1.2

      const lines: string[] = []
      for (let r = 0; r < rows; r++) {
        let line = ""
        const dyc = (r * 4 + 2) * SCALE - centreY
        for (let c = 0; c < cols; c++) {
          const dxc = (c * 2 + 1) * SCALE - centreX
          const ripple = Math.sin(Math.sqrt(dxc * dxc + dyc * dyc + 1) + t * 0.8)
          let bits = 0
          for (let dy = 0; dy < 4; dy++) {
            const y = r * 4 + dy
            for (let dx = 0; dx < 2; dx++) {
              const x = c * 2 + dx
              const sum =
                xWave[x]! + yHalfSin[y]! + xHalfSin[x]! * yHalfCos[y]! + xHalfCos[x]! * yHalfSin[y]! + ripple
              if ((sum + 4) / 8 > BAYER[y & 3]![x & 3]!) bits |= DOT_BITS[dy]![dx]!
            }
          }
          line += BRAILLE[bits]
        }
        lines.push(line)
      }
      screen.textContent = lines.join("\n")
    }

    const tick = (time: number) => {
      frame = requestAnimationFrame(tick)
      if (time - last < FRAME_MS) return
      last = time
      draw(time)
    }

    measure()
    const observer = new ResizeObserver(() => {
      measure()
      if (reducedMotion) draw(0)
    })
    observer.observe(screen)
    if (reducedMotion) draw(0)
    else frame = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  return (
    <div aria-hidden className={className}>
      <pre
        ref={screenRef}
        className="m-0 size-full overflow-hidden font-mono text-[12px] leading-[1.1] whitespace-pre text-white/30 select-none"
      />
      <span ref={probeRef} className="invisible absolute font-mono text-[12px] leading-[1.1] whitespace-pre">
        ⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿
      </span>
    </div>
  )
}
