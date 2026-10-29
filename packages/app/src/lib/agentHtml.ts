import type { Element, Root } from "hast"
import { defaultSchema, type Options as Schema } from "rehype-sanitize"

/**
 * What agent markdown may carry as raw HTML. Agent text is untrusted (an agent can be steered by a web page or a
 * repository it read), so this is GitHub's allowlist plus inline SVG drawing, and nothing that runs code or styles
 * the page. Removed by omission: script, style, iframe/object/embed, forms, foreignObject and SVG animation
 * (`set`/`animate` can rewrite an href to `javascript:`), every event handler, and `class`. `style` is kept only
 * on elements inside an SVG, where CSS positioning has no effect, so it cannot draw over the app.
 */

/** SVG drawing elements, in the hast tag names parse5 produces (camelCase where SVG is). */
const SVG_TAGS = [
  "svg",
  "g",
  "defs",
  "symbol",
  "use",
  "title",
  "desc",
  "path",
  "rect",
  "circle",
  "ellipse",
  "line",
  "polyline",
  "polygon",
  "text",
  "tspan",
  "textPath",
  "image",
  "marker",
  "pattern",
  "clipPath",
  "mask",
  "linearGradient",
  "radialGradient",
  "stop",
  "filter",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
]

/** SVG presentation and geometry attributes, as hast property names. */
const SVG_PROPS = [
  "xmlns",
  "xmlnsXLink",
  "version",
  "viewBox",
  "preserveAspectRatio",
  "width",
  "height",
  "x",
  "y",
  "x1",
  "x2",
  "y1",
  "y2",
  "cx",
  "cy",
  "r",
  "rx",
  "ry",
  "fx",
  "fy",
  "dx",
  "dy",
  "d",
  "points",
  "pathLength",
  "transform",
  "fill",
  "fillOpacity",
  "fillRule",
  "clipRule",
  "stroke",
  "strokeWidth",
  "strokeOpacity",
  "strokeLinecap",
  "strokeLinejoin",
  "strokeMiterlimit",
  "strokeDasharray",
  "strokeDashoffset",
  "opacity",
  "color",
  "visibility",
  "display",
  "clipPath",
  "mask",
  "filter",
  "markerStart",
  "markerMid",
  "markerEnd",
  "markerWidth",
  "markerHeight",
  "markerUnits",
  "refX",
  "refY",
  "orient",
  "patternUnits",
  "patternContentUnits",
  "patternTransform",
  "gradientUnits",
  "gradientTransform",
  "spreadMethod",
  "offset",
  "stopColor",
  "stopOpacity",
  "clipPathUnits",
  "maskUnits",
  "maskContentUnits",
  "filterUnits",
  "primitiveUnits",
  "fontFamily",
  "fontSize",
  "fontWeight",
  "fontStyle",
  "textAnchor",
  "dominantBaseline",
  "alignmentBaseline",
  "baselineShift",
  "letterSpacing",
  "textDecoration",
  "textLength",
  "lengthAdjust",
  "startOffset",
  "rotate",
  "vectorEffect",
  "shapeRendering",
  "paintOrder",
  "role",
  "ariaHidden",
  "ariaLabel",
  "href",
  "xLinkHref",
  // Filter primitives.
  "in",
  "in2",
  "result",
  "stdDeviation",
  "mode",
  "type",
  "values",
  "operator",
  "k1",
  "k2",
  "k3",
  "k4",
  "radius",
  "floodColor",
  "floodOpacity",
  "tableValues",
  "slope",
  "intercept",
  "amplitude",
  "exponent",
]

export const AGENT_HTML_SCHEMA: Schema = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), ...SVG_TAGS],
  // Removed with their content; other disallowed elements are unwrapped and keep their text.
  strip: [...(defaultSchema.strip ?? []), "style", "foreignObject", "template", "noscript"],
  attributes: {
    ...defaultSchema.attributes,
    ...Object.fromEntries(SVG_TAGS.map((tag) => [tag, tag === "svg" ? SVG_PROPS : [...SVG_PROPS, "style"]])),
  },
  protocols: {
    ...defaultSchema.protocols,
    // `href` on SVG `use`/`image`/`a` and its legacy xlink form: same-page fragments, http(s) and mailto only.
    xLinkHref: ["http", "https", "mailto"],
  },
}

/** Properties whose value may hold `url(#id)` references to other SVG elements. */
const URL_REF = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/g

/**
 * Sanitizing prefixes every `id` (so agent markup cannot clobber page globals or collide across messages) but
 * leaves the references to them alone. This points `#id` hrefs and `url(#id)` paint, clip, mask, filter and marker
 * references at the prefixed ids, so gradients, `<use>`, markers and footnote links keep working. A reference
 * whose target is not in the same message is left as it is.
 */
export function rehypeScopeIdRefs(prefix: string) {
  return () => (tree: Root) => {
    const ids = new Set<string>()
    const elements: Element[] = []
    const walk = (node: Root | Element) => {
      for (const child of node.children) {
        if (child.type !== "element") continue
        elements.push(child)
        if (typeof child.properties.id === "string") ids.add(child.properties.id)
        walk(child)
      }
    }
    walk(tree)
    if (ids.size === 0) return
    const scoped = (id: string) => (ids.has(prefix + id) ? prefix + id : null)
    for (const element of elements) {
      for (const [key, value] of Object.entries(element.properties)) {
        if (typeof value !== "string") continue
        if ((key === "href" || key === "xLinkHref") && value.startsWith("#")) {
          const target = scoped(value.slice(1))
          if (target !== null) element.properties[key] = `#${target}`
        } else if (value.includes("url(")) {
          element.properties[key] = value.replace(URL_REF, (match, _quote: string, id: string) => {
            const target = scoped(id)
            return target === null ? match : `url(#${target})`
          })
        }
      }
    }
  }
}
