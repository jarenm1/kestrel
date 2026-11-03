import type { Element, Root } from "hast"
import { defaultSchema, type Options as Schema } from "rehype-sanitize"

/**
 * What agent markdown may carry as raw HTML. Agent text is untrusted (an agent can be steered by a web page or a
 * repository it read), so this is GitHub's allowlist plus inline SVG drawing, and nothing that runs code or styles
 * the page. Removed by omission: script, style, iframe/object/embed, forms, foreignObject and SVG animation
 * (`set`/`animate` can rewrite an href to `javascript:`), every event handler, and `class`. `style` passes the
 * sanitizer and `rehypeAgentSvg` filters it per declaration: inside an SVG, where CSS positioning has no effect,
 * every declaration that cannot load a resource stays; on HTML only the properties in `HTML_STYLE_PROPS` (colour,
 * type, spacing, borders, in-flow layout), so agent markup cannot draw over the app.
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
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "style"],
    ...Object.fromEntries(SVG_TAGS.map((tag) => [tag, SVG_PROPS])),
  },
  protocols: {
    ...defaultSchema.protocols,
    // `href` on SVG `use`/`image`/`a` and its legacy xlink form: same-page fragments, http(s) and mailto only.
    xLinkHref: ["http", "https", "mailto"],
  },
}

/** `url(#id)`: a reference to an element in the same drawing. */
const URL_REF = /url\(\s*(['"]?)#([^'")\s]+)\1\s*\)/gi
/** CSS functions an SVG value may use: colours and transforms. `url()` is allowed only as a fragment `URL_REF`. */
const SAFE_FUNCTIONS: Readonly<Record<string, true>> = {
  rgb: true,
  rgba: true,
  hsl: true,
  hsla: true,
  matrix: true,
  translate: true,
  scale: true,
  rotate: true,
  skewx: true,
  skewy: true,
  "linear-gradient": true,
  "radial-gradient": true,
  "conic-gradient": true,
}
/**
 * CSS properties an HTML element's `style` may set: they paint and size the element in the flow and never take it
 * out of it. Left out: `position`, `inset`/`top`/…, `z-index`, `transform`, `float`, `overflow`, `content`, and
 * anything that loads a resource. Margins may not be negative, so a block cannot slide over its neighbours.
 */
const HTML_STYLE_PROPS: ReadonlySet<string> = new Set([
  "color",
  "background",
  "background-color",
  "opacity",
  "font",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "font-variant",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-decoration",
  "text-transform",
  "text-shadow",
  "white-space",
  "vertical-align",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-color",
  "border-width",
  "border-style",
  "border-radius",
  "border-collapse",
  "box-shadow",
  "box-sizing",
  "width",
  "min-width",
  "max-width",
  "height",
  "min-height",
  "max-height",
  "display",
  "gap",
  "flex",
  "flex-direction",
  "flex-wrap",
  "align-items",
  "justify-content",
  "grid-template-columns",
])
/** SVG properties that hold text, not CSS: never parsed as a style value. */
const TEXT_PROPS: Readonly<Record<string, true>> = {
  ariaLabel: true,
  ariaHidden: true,
  role: true,
  id: true,
  href: true,
  xLinkHref: true,
}

/**
 * Whether a CSS value (a presentation attribute, or one `style` declaration) can only paint, never fetch. Any
 * function other than a colour or transform is refused, `url()` included unless it names a same-drawing fragment:
 * `url(https://…)`, `image-set("…")` and their kin would load cross-origin while the message renders. Backslashes
 * are refused outright, since CSS escapes (`u\rl(`) would hide a function name from this check.
 */
const safeCssValue = (value: string): boolean => {
  if (value.includes("\\")) return false
  const rest = value.replace(URL_REF, "")
  for (const [, name] of rest.matchAll(/([a-z-]+)\s*\(/gi)) {
    if (SAFE_FUNCTIONS[name!.toLowerCase()] !== true) return false
  }
  return true
}

/**
 * Runs after sanitizing, on agent HTML and SVG:
 * - Keeps only the HTML `style` declarations that `HTML_STYLE_PROPS` allows and `safeCssValue` passes.
 * - Drops every presentation attribute and `style` declaration that could load a resource (`safeCssValue`), and
 *   `<use>` hrefs that leave the drawing. External `<image>` sources stay, like markdown images.
 * - Sanitizing prefixes every `id` (so agent markup cannot clobber page globals or collide across messages) but
 *   leaves references to them alone. This points `#id` hrefs and `url(#id)` paint, clip, mask, filter and marker
 *   references at the prefixed ids, so gradients, `<use>`, markers and footnote links keep working. A reference
 *   whose target is not in the same message is left as it is.
 */
export function rehypeAgentSvg(prefix: string) {
  return () => (tree: Root) => {
    const ids = new Set<string>()
    const elements: Element[] = []
    const walk = (node: Root | Element, inSvg: boolean) => {
      for (const child of node.children) {
        if (child.type !== "element") continue
        elements.push(child)
        if (typeof child.properties.id === "string") ids.add(child.properties.id)
        const childInSvg = inSvg || child.tagName === "svg"
        // An `<svg>` root sits in the page's flow, so its own style follows the HTML rules.
        if (!inSvg) filterHtmlStyle(child)
        if (childInSvg) dropFetchingValues(child)
        walk(child, childInSvg)
      }
    }
    walk(tree, false)
    if (ids.size === 0) return
    const scoped = (id: string) => (ids.has(prefix + id) ? prefix + id : null)
    for (const element of elements) {
      for (const [key, value] of Object.entries(element.properties)) {
        if (typeof value !== "string") continue
        if ((key === "href" || key === "xLinkHref") && value.startsWith("#")) {
          const target = scoped(value.slice(1))
          if (target !== null) element.properties[key] = `#${target}`
        } else if (TEXT_PROPS[key] !== true && /url\(/i.test(value)) {
          element.properties[key] = value.replace(URL_REF, (match, _quote: string, id: string) => {
            const target = scoped(id)
            return target === null ? match : `url(#${target})`
          })
        }
      }
    }
  }
}

function dropFetchingValues(element: Element) {
  const props = element.properties
  for (const [key, value] of Object.entries(props)) {
    if (TEXT_PROPS[key] === true) continue
    // Space- or comma-separated attributes arrive as arrays; their items are checked together.
    if (Array.isArray(value)) {
      if (!safeCssValue(value.join(" "))) delete props[key]
      continue
    }
    if (typeof value !== "string") continue
    if (key === "style") {
      // Each declaration stands or falls alone; a `;` inside a quoted value only splits it into pieces that are
      // each checked, so nothing unchecked survives.
      const kept = value.split(";").filter((declaration) => declaration.trim() !== "" && safeCssValue(declaration))
      if (kept.length === 0) delete props.style
      else props.style = kept.join(";")
    } else if (!safeCssValue(value)) {
      delete props[key]
    }
  }
  for (const key of ["href", "xLinkHref"]) {
    const href = props[key]
    if (element.tagName === "use" && typeof href === "string" && !href.startsWith("#")) delete props[key]
  }
}

function filterHtmlStyle(element: Element) {
  const style = element.properties.style
  if (typeof style !== "string") return
  const kept = style.split(";").filter((declaration) => {
    const colon = declaration.indexOf(":")
    if (colon === -1) return false
    const name = declaration.slice(0, colon).trim().toLowerCase()
    if (!HTML_STYLE_PROPS.has(name) || !safeCssValue(declaration)) return false
    // A negative margin would pull the block over the text around it.
    return !name.startsWith("margin") || !/(^|[\s(,])-/.test(declaration.slice(colon + 1))
  })
  if (kept.length === 0) delete element.properties.style
  else element.properties.style = kept.join(";")
}
