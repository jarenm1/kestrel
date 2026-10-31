/**
 * HiDPI factor of the task desktop. The 2560x1440 display is usually watched in a small pane, so apps drawn at 1x
 * end up unreadable; at 2x they lay out on a 1280x720 logical screen and stay sharp when the viewer is fullscreen.
 */
export const DESKTOP_SCALE = 2

/**
 * Environment that makes desktop apps draw at DESKTOP_SCALE: GTK (and Firefox), Qt, the X cursor. The sandbox's
 * xterm wrapper sizes its font from GDK_SCALE. Blender and Wine keep their own UI scale settings.
 */
export const desktopScaleEnv: Readonly<Record<string, string>> = {
  GDK_SCALE: String(DESKTOP_SCALE),
  QT_SCALE_FACTOR: String(DESKTOP_SCALE),
  XCURSOR_SIZE: String(24 * DESKTOP_SCALE),
}
