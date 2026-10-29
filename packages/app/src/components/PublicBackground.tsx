import { useEffect, useState } from "react"
import { GrainGradient } from "@paper-design/shaders-react"
import { cn } from "@/lib/utils"

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * Greyscale grain gradient (Paper Shaders) behind the top of the public pages. It is loaded lazily by
 * `PublicShell`, so the WebGL shader code stays out of the app's bundle, and fades in once it has drawn
 * instead of popping in.
 */
export default function PublicBackground() {
  const [shown, setShown] = useState(false)
  useEffect(() => {
    // Two frames: the shader's first draw lands before the fade starts.
    let id = requestAnimationFrame(() => (id = requestAnimationFrame(() => setShown(true))))
    return () => cancelAnimationFrame(id)
  }, [])

  return (
    <GrainGradient
      className={cn(
        "size-full transition-opacity duration-[1500ms] ease-out motion-reduce:duration-0",
        shown ? "opacity-100" : "opacity-0",
      )}
      colorBack="#0a0a0b"
      // Small steps between neighbouring greys, full softness and little distortion: one continuous gradient
      // rather than distinct shapes.
      colors={["#141417", "#24242a", "#36363d", "#4a4a52"]}
      shape="corners"
      softness={1}
      intensity={0.16}
      noise={0.3}
      speed={REDUCED_MOTION ? 0 : 0.45}
      // A soft background needs nowhere near full resolution; this keeps the GPU cost low on big screens.
      maxPixelCount={1920 * 1080}
    />
  )
}
