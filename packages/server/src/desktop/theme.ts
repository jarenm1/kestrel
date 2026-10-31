import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DESKTOP_SCALE } from "./scale"

/** The app's palette (packages/app/src/styles.css), so the desktop's window chrome matches the UI around it. */
const COLOR = {
  background: "#0a0a0b",
  card: "#141416",
  muted: "#1c1c1f",
  accent: "#242428",
  pressed: "#2e2e33",
  border: "#2a2a2e",
  foreground: "#ededef",
  mutedForeground: "#8b8b93",
  disabled: "#4a4a52",
  primary: "#f5f5f6",
} as const

/** Physical pixels for `n` logical ones. */
const px = (n: number) => n * DESKTOP_SCALE

/** Side of the title bar button glyphs, in physical pixels. */
const GLYPH = px(7)

/** An X bitmap of GLYPH x GLYPH; openbox draws button glyphs from these masks in the theme's image colors. */
const xbm = (name: string, on: (x: number, y: number) => boolean): string => {
  const bytes: string[] = []
  for (let y = 0; y < GLYPH; y++) {
    for (let start = 0; start < GLYPH; start += 8) {
      let byte = 0
      for (let bit = 0; bit < 8 && start + bit < GLYPH; bit++) if (on(start + bit, y)) byte |= 1 << bit
      bytes.push(`0x${byte.toString(16).padStart(2, "0")}`)
    }
  }
  return `#define ${name}_width ${GLYPH}\n#define ${name}_height ${GLYPH}\nstatic unsigned char ${name}_bits[] = {\n  ${bytes.join(", ")} };\n`
}

const STROKE = DESKTOP_SCALE
const last = GLYPH - 1
const inRect = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) =>
  x >= x0 && x <= x1 && y >= y0 && y <= y1
const onOutline = (x: number, y: number, x0: number, y0: number, x1: number, y1: number) =>
  inRect(x, y, x0, y0, x1, y1) && !inRect(x, y, x0 + STROKE, y0 + STROKE, x1 - STROKE, y1 - STROKE)
/** The restore glyph's two squares are offset by this much. */
const OFFSET = Math.round(GLYPH / 4)

/** Button glyphs by openbox mask file name; masks missing here fall back to openbox's built-in ones. */
const GLYPHS: Record<string, (x: number, y: number) => boolean> = {
  close: (x, y) => Math.abs(x - y) <= STROKE / 2 || Math.abs(x + y - last) <= STROKE / 2,
  max: (x, y) => onOutline(x, y, 0, 0, last, last),
  max_toggled: (x, y) =>
    onOutline(x, y, 0, OFFSET, last - OFFSET, last) ||
    (onOutline(x, y, OFFSET, 0, last, last - OFFSET) && !inRect(x, y, 0, OFFSET, last - OFFSET, last)),
  iconify: (_x, y) => y > last - STROKE,
  // Submenu arrow: a right-pointing triangle in the middle half.
  bullet: (x, y) => {
    const half = GLYPH / 2
    const dx = x - GLYPH / 4
    return dx >= 0 && dx < half && Math.abs(y - last / 2) <= half - 1 - dx
  },
}

/**
 * The themerc: flat chrome in the app's colors. Openbox draws no rounded corners or shadows, so the style comes
 * from the palette, a 1-logical-pixel border and the title bar spacing.
 */
const themerc = (): string => {
  const lines: Array<[string, string | number]> = [
    ["border.width", px(1)],
    ["padding.width", px(4)],
    ["padding.height", px(3)],
    ["window.handle.width", 0],
    ["window.client.padding.width", 0],
    ["window.client.padding.height", 0],
    ["window.label.text.justify", "left"],
    ["menu.border.width", px(1)],
    ["menu.border.color", COLOR.border],
    ["menu.overlap.x", 0],
    ["menu.overlap.y", 0],
    ["menu.separator.width", px(1)],
    ["menu.separator.padding.width", px(4)],
    ["menu.separator.padding.height", px(2)],
    ["menu.separator.color", COLOR.accent],
    ["menu.title.text.justify", "left"],
    ["osd.border.width", px(1)],
    ["osd.border.color", COLOR.border],
  ]
  const textures: Array<[string, string]> = [
    ["menu.title.bg", COLOR.card],
    ["menu.items.bg", COLOR.card],
    ["menu.items.active.bg", COLOR.accent],
    ["osd.bg", COLOR.card],
    ["osd.hilight.bg", COLOR.primary],
    ["osd.unhilight.bg", COLOR.accent],
  ]
  lines.push(
    ["menu.title.text.color", COLOR.mutedForeground],
    ["menu.items.text.color", COLOR.foreground],
    ["menu.items.disabled.text.color", COLOR.disabled],
    ["menu.items.active.text.color", COLOR.foreground],
    ["osd.label.bg", "parentrelative"],
    ["osd.label.text.color", COLOR.foreground],
  )
  for (const [state, title, border, text, glyph] of [
    ["active", COLOR.card, COLOR.border, COLOR.foreground, COLOR.mutedForeground],
    ["inactive", COLOR.background, COLOR.muted, COLOR.mutedForeground, COLOR.disabled],
  ] as const) {
    const w = `window.${state}`
    textures.push(
      [`${w}.title.bg`, title],
      [`${w}.handle.bg`, title],
      [`${w}.grip.bg`, title],
      [`${w}.button.hover.bg`, COLOR.accent],
      [`${w}.button.pressed.bg`, COLOR.pressed],
      [`${w}.button.toggled.hover.bg`, COLOR.accent],
      [`${w}.button.toggled.pressed.bg`, COLOR.pressed],
    )
    lines.push(
      [`${w}.border.color`, border],
      [`${w}.title.separator.color`, border],
      [`${w}.client.color`, COLOR.background],
      [`${w}.label.bg`, "parentrelative"],
      [`${w}.label.text.color`, text],
      [`${w}.button.unpressed.bg`, "parentrelative"],
      [`${w}.button.disabled.bg`, "parentrelative"],
      [`${w}.button.toggled.unpressed.bg`, "parentrelative"],
      [`${w}.button.unpressed.image.color`, glyph],
      [`${w}.button.toggled.unpressed.image.color`, glyph],
      [`${w}.button.hover.image.color`, COLOR.foreground],
      [`${w}.button.toggled.hover.image.color`, COLOR.foreground],
      [`${w}.button.pressed.image.color`, COLOR.foreground],
      [`${w}.button.toggled.pressed.image.color`, COLOR.foreground],
      [`${w}.button.disabled.image.color`, COLOR.disabled],
    )
  }
  const textureLines = textures.flatMap(([key, color]) => [`${key}: flat solid`, `${key}.color: ${color}`])
  return [...lines.map(([key, value]) => `${key}: ${value}`), ...textureLines, ""].join("\n")
}

const action = (name: string, body = "") => (body ? `<action name="${name}">${body}</action>` : `<action name="${name}"/>`)
const bind = (button: string, event: string, ...actions: string[]) =>
  `<mousebind button="${button}" action="${event}">${actions.join("")}</mousebind>`
const raise = [action("Focus"), action("Raise"), action("Unshade")]
const resize = (context: string, edge: string) =>
  `<context name="${context}">${bind("Left", "Drag", action("Resize", `<edge>${edge}</edge>`))}</context>`

/**
 * Mouse and keyboard bindings, all of them. Openbox only falls back to its defaults when the config has none, and
 * those include the root menu, whose entries run programs on the box outside the task sandbox. Nothing here starts a
 * program: right-clicking the desktop lists the open windows (the way back to an iconified one, as there is no panel).
 */
const bindings = (): string => `<mouse>
    <dragThreshold>${px(2)}</dragThreshold>
    <doubleClickTime>400</doubleClickTime>
    <screenEdgeWarpTime>0</screenEdgeWarpTime>
    <context name="Frame">
      ${bind("A-Left", "Press", action("Focus"), action("Raise"))}
      ${bind("A-Left", "Drag", action("Move"))}
      ${bind("A-Right", "Press", ...raise)}
      ${bind("A-Right", "Drag", action("Resize"))}
    </context>
    <context name="Titlebar">
      ${bind("Left", "Drag", action("Move"))}
      ${bind("Left", "DoubleClick", action("ToggleMaximize"))}
    </context>
    <context name="Titlebar Top Right Bottom Left TLCorner TRCorner BRCorner BLCorner">
      ${bind("Left", "Press", ...raise)}
      ${bind("Right", "Press", ...raise, action("ShowMenu", "<menu>client-menu</menu>"))}
    </context>
    ${resize("Top", "top")}
    ${resize("Left", "left")}
    ${resize("Right", "right")}
    ${resize("Bottom", "bottom")}
    ${resize("TLCorner", "topleft")}
    ${resize("TRCorner", "topright")}
    ${resize("BLCorner", "bottomleft")}
    ${resize("BRCorner", "bottomright")}
    <context name="Client">
      ${bind("Left", "Press", action("Focus"), action("Raise"))}
      ${bind("Middle", "Press", action("Focus"), action("Raise"))}
      ${bind("Right", "Press", action("Focus"), action("Raise"))}
    </context>
    <context name="Iconify">
      ${bind("Left", "Press", ...raise)}
      ${bind("Left", "Click", action("Iconify"))}
    </context>
    <context name="Maximize">
      ${bind("Left", "Press", ...raise)}
      ${bind("Left", "Click", action("ToggleMaximize"))}
    </context>
    <context name="Close">
      ${bind("Left", "Press", ...raise)}
      ${bind("Left", "Click", action("Close"))}
    </context>
    <context name="Root">
      ${bind("Right", "Press", action("ShowMenu", "<menu>client-list-combined-menu</menu>"))}
    </context>
  </mouse>
  <keyboard>
    <chainQuitKey>C-g</chainQuitKey>
    <keybind key="A-Tab">${action("NextWindow")}</keybind>
    <keybind key="A-S-Tab">${action("PreviousWindow")}</keybind>
    <keybind key="A-F4">${action("Close")}</keybind>
  </keyboard>`

/** rc.xml: the Kestrel theme at `themeDir`, fonts at DESKTOP_SCALE, one desktop, and the bindings above. */
const rcXml = (themeDir: string, menuFile: string): string => {
  const font = (place: string, size: number, weight = "normal") =>
    `<font place="${place}"><name>sans</name><size>${px(size)}</size><weight>${weight}</weight></font>`
  return `<?xml version="1.0" encoding="UTF-8"?>
<openbox_config xmlns="http://openbox.org/3.4/rc">
  <theme>
    <name>${themeDir}</name>
    <titleLayout>LIMC</titleLayout>
    <keepBorder>yes</keepBorder>
    <animateIconify>no</animateIconify>
    ${font("ActiveWindow", 8, "bold")}
    ${font("InactiveWindow", 8, "bold")}
    ${font("MenuHeader", 9, "bold")}
    ${font("MenuItem", 9)}
    ${font("ActiveOnScreenDisplay", 9)}
    ${font("InactiveOnScreenDisplay", 9)}
  </theme>
  <placement>
    <policy>Smart</policy>
    <center>yes</center>
  </placement>
  <desktops>
    <number>1</number>
    <popupTime>0</popupTime>
  </desktops>
  <menu>
    <file>${menuFile}</file>
    <manageDesktops>no</manageDesktops>
  </menu>
  ${bindings()}
</openbox_config>
`
}

/**
 * Writes the openbox config into `dir`: rc.xml, an empty menu file (openbox's stock menu.xml launches programs
 * outside the sandbox) and the Kestrel theme, which openbox loads by absolute path. Returns rc.xml's path.
 */
export const writeOpenboxConfig = (dir: string): string => {
  const theme = join(dir, "theme", "openbox-3")
  mkdirSync(theme, { recursive: true })
  writeFileSync(join(theme, "themerc"), themerc())
  for (const [name, on] of Object.entries(GLYPHS)) writeFileSync(join(theme, `${name}.xbm`), xbm(name, on))
  const menu = join(dir, "menu.xml")
  writeFileSync(menu, `<?xml version="1.0" encoding="UTF-8"?>\n<openbox_menu xmlns="http://openbox.org/3.4/menu"/>\n`)
  const rc = join(dir, "rc.xml")
  writeFileSync(rc, rcXml(join(dir, "theme"), menu))
  return rc
}
