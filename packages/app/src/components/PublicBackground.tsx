import { GrainGradient } from "@paper-design/shaders-react"

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)").matches

/**
 * Greyscale grain gradient (Paper Shaders) behind the top of the public pages. It is loaded lazily by
 * `PublicShell`, so the WebGL shader code stays out of the app's bundle.
 */
export default function PublicBackground() {
  return (
    <GrainGradient
      className="size-full"
      colorBack="#0a0a0b"
      // Small steps between neighbouring greys, full softness and little distortion: one continuous gradient
      // rather than distinct shapes.
      colors={["#141417", "#24242a", "#36363d", "#4a4a52"]}
      shape="corners"
      softness={1}
      intensity={0.12}
      noise={0.3}
      speed={REDUCED_MOTION ? 0 : 0.25}
      // A soft background needs nowhere near full resolution; this keeps the GPU cost low on big screens.
      maxPixelCount={1920 * 1080}
    />
  )
}
