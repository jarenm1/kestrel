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
      colors={["#1c1c20", "#3d3d43", "#6e6e76"]}
      shape="blob"
      softness={0.8}
      intensity={0.3}
      noise={0.35}
      speed={REDUCED_MOTION ? 0 : 0.25}
      // A soft background needs nowhere near full resolution; this keeps the GPU cost low on big screens.
      maxPixelCount={1920 * 1080}
    />
  )
}
