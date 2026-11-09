import { BrowserWindow, Menu, app, dialog, shell, type MenuItemConstructorOptions } from "electron"
import { autoUpdater } from "electron-updater"
import { randomBytes } from "node:crypto"
import { join, resolve } from "node:path"
import { CALLBACK_SCHEME, callbackPath, loginUrl, safeLocalPath, type CallbackPath } from "./auth"
import { acceptCallback } from "./handoff"
import { createSerialQueue } from "./queue"
import { startDesktopServer, type DesktopServer } from "./server"
import { SessionStore } from "./session"

const CONTROL_URL = (process.env.KESTREL_CONTROL_URL ?? "https://app.kestrel-agent.com").replace(/\/+$/, "")
const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000

let window: BrowserWindow | null = null
let server: DesktopServer | null = null
let store: SessionStore | null = null
let updateTimer: NodeJS.Timeout | null = null
let pendingCallback: string | null = null
let loginReturnPath: CallbackPath = "/auth/desktop-callback"

const appDist = (): string =>
  app.isPackaged ? join(process.resourcesPath, "app-dist") : join(app.getAppPath(), "..", "app", "dist")

const registerProtocol = (mobileFallback: boolean): void => {
  if (process.defaultApp && process.argv[1] !== undefined) {
    app.setAsDefaultProtocolClient(CALLBACK_SCHEME, process.execPath, [resolve(process.argv[1])])
    if (mobileFallback) app.setAsDefaultProtocolClient("kestrel", process.execPath, [resolve(process.argv[1])])
  } else {
    app.setAsDefaultProtocolClient(CALLBACK_SCHEME)
    if (mobileFallback) app.setAsDefaultProtocolClient("kestrel")
  }
}

const focusWindow = (): void => {
  if (window === null) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/** The window may only stay on the local app; everything else opens in the user's browser. */
const wireNavigation = (contents: BrowserWindow["webContents"]): void => {
  const navigate = (event: Electron.Event, value: string): void => {
    const local = server?.origin
    if (local !== undefined && value.startsWith(local)) {
      const target = new URL(value)
      if (target.pathname === "/auth/github/login") {
        event.preventDefault()
        server?.setPendingReturn(safeLocalPath(target.searchParams.get("return")))
        const nonce = randomBytes(24).toString("base64url")
        server?.setPendingNonce(nonce)
        void shell.openExternal(loginUrl(CONTROL_URL, loginReturnPath, nonce))
      }
      return
    }
    event.preventDefault()
    if (value.startsWith("https://") || value.startsWith("http://")) void shell.openExternal(value)
  }
  contents.on("will-navigate", navigate)
  contents.on("will-redirect", navigate)
  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url)
    return { action: "deny" }
  })
}

const createWindow = async (): Promise<void> => {
  if (server === null) throw new Error("desktop server is not running")
  window = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: "#0e1014",
    title: "Kestrel",
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  window.once("ready-to-show", () => window?.show())
  window.on("closed", () => {
    window = null
  })
  wireNavigation(window.webContents)
  await window.loadURL(`${server.origin}${server.bootstrapPath}`)
}

/**
 * Sign-in callbacks and sign-out share one queue: the nonce is single-use, and both write the session file and the
 * proxy's in-memory copy, so overlapping them could roll one back with the other.
 */
const enqueue = createSerialQueue((error: unknown) => {
  console.error("desktop auth task failed:", error instanceof Error ? error.message : String(error))
})

const handleCallback = (value: string): Promise<void> => enqueue(() => processCallback(value))

const processCallback = async (value: string): Promise<void> => {
  if (server === null || store === null) {
    pendingCallback = value
    return
  }
  const desktop = server
  const sessionStore = store
  const outcome = await acceptCallback(value, {
    pendingNonce: () => desktop.pendingNonce(),
    claimPendingNonce: (nonce) => desktop.claimPendingNonce(nonce),
    readSession: () => sessionStore.get(),
    storeSession: (session) => sessionStore.set(session),
    clearSession: () => sessionStore.clear(),
  })
  if (outcome._tag !== "signed-in") return
  // The session reached the file before the proxy learned it: memory never claims a sign-in the disk lacks.
  desktop.setSession(outcome.session)
  const path = desktop.takePendingReturn()
  if (window === null) await createWindow()
  focusWindow()
  await window?.loadURL(`${desktop.origin}${path}`)
}

const processSignOut = async (): Promise<void> => {
  const id = await store?.get()
  if (id !== null && id !== undefined) {
    await fetch(`${CONTROL_URL}/auth/logout`, { method: "POST", headers: { cookie: `session=${id}` } }).catch(
      () => undefined,
    )
  }
  await store?.clear()
  server?.setSession(null)
  window?.reload()
}

const signOut = (): Promise<void> => enqueue(processSignOut)

const checkForUpdates = async (manual: boolean): Promise<void> => {
  if (!app.isPackaged) {
    if (manual) await dialog.showMessageBox({ message: "Updates are checked in packaged builds." })
    return
  }
  try {
    const result = await autoUpdater.checkForUpdates()
    if (manual && (result === null || result.updateInfo.version === app.getVersion())) {
      await dialog.showMessageBox({ message: `Kestrel Desktop ${app.getVersion()} is up to date.` })
    }
  } catch (error) {
    if (manual) {
      await dialog.showMessageBox({
        type: "error",
        message: "Could not check for updates.",
        detail: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

const installMenu = (): void => {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { label: "Check for Updates…", click: () => void checkForUpdates(true) },
        { label: "Open Web App", click: () => void shell.openExternal(CONTROL_URL) },
        { type: "separator" },
        { label: "Sign Out", click: () => void signOut() },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [{ label: `Kestrel Desktop ${app.getVersion()}`, enabled: false }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

const wireUpdates = (): void => {
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.on("update-downloaded", async (info) => {
    const answer = await dialog.showMessageBox({
      type: "question",
      buttons: ["Restart and install", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: `Kestrel Desktop ${info.version} is ready.`,
      detail: "Restart to install the update.",
    })
    if (answer.response === 0) autoUpdater.quitAndInstall()
  })
  autoUpdater.on("error", (error) => {
    console.error("desktop update failed:", error.message)
  })
}

const start = async (): Promise<void> => {
  loginReturnPath = await callbackPath(CONTROL_URL)
  registerProtocol(loginReturnPath === "/auth/mobile-callback")
  store = new SessionStore()
  server = await startDesktopServer({
    appDist: appDist(),
    controlUrl: CONTROL_URL,
    callbackPath: loginReturnPath,
    getSession: () => store?.get() ?? Promise.resolve(null),
    clearSession: () => store?.clear() ?? Promise.resolve(),
  })
  // `bun run dev:desktop` seeds a session from the local dev stack. Only a loopback HTTP control can use it.
  const devSession = process.env.KESTREL_DESKTOP_DEV_SESSION
  const control = new URL(CONTROL_URL)
  if (
    devSession !== undefined &&
    devSession !== "" &&
    control.protocol === "http:" &&
    (control.hostname === "127.0.0.1" || control.hostname === "localhost")
  ) {
    await store.set(devSession)
    server.setSession(devSession)
  }
  await createWindow()
  installMenu()
  wireUpdates()
  if (app.isPackaged) {
    void checkForUpdates(false)
    updateTimer = setInterval(() => void checkForUpdates(false), UPDATE_INTERVAL_MS)
    updateTimer.unref()
  }
  // A cold launch from kestrel-desktop:// (Windows/Linux) carries the URL in argv; macOS uses open-url, which may
  // arrive before this point.
  const queued = pendingCallback ?? protocolUrl(process.argv)
  pendingCallback = null
  if (queued !== undefined) await handleCallback(queued)
}

const protocolUrl = (argv: readonly string[]): string | undefined =>
  argv.find((arg) => arg.startsWith(`${CALLBACK_SCHEME}://`) || arg.startsWith("kestrel://"))

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on("second-instance", (_event, argv) => {
    const url = protocolUrl(argv)
    if (url !== undefined) void handleCallback(url)
    else focusWindow()
  })
  app.on("open-url", (event, url) => {
    event.preventDefault()
    void handleCallback(url)
  })
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit()
  })
  app.on("activate", () => {
    if (server === null) void start()
    else if (window === null) void createWindow()
    else focusWindow()
  })
  app.on("before-quit", () => {
    if (updateTimer !== null) {
      clearInterval(updateTimer)
      updateTimer = null
    }
    void server?.close()
  })
  void app.whenReady().then(start)
}
