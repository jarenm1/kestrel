import { randomBytes } from "node:crypto"
import { createReadStream } from "node:fs"
import { stat } from "node:fs/promises"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { extname, join, resolve, sep } from "node:path"
import { createProxyServer } from "http-proxy"
import { loginUrl, safeLocalPath, type CallbackPath } from "./auth"

/** Paths the app uses against the control plane; everything else is a static asset. */
const PROXY_PREFIXES = ["/api", "/auth", "/_preview", "/box"]
const WS_PREFIXES = ["/api", "/_preview"]
const COOKIE = "kestrel_desktop"

const MIME: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webmanifest": "application/manifest+json",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
}

export interface DesktopServerOptions {
  /** `packages/app/dist` */
  readonly appDist: string
  readonly controlUrl: string
  /** Which control-plane route completes sign-in; see `callbackPath` in `auth.ts`. */
  readonly callbackPath: CallbackPath
  readonly getSession: () => Promise<string | null>
  readonly clearSession: () => Promise<void>
}

export interface DesktopServer {
  /** `http://127.0.0.1:<port>`; the renderer's origin. */
  readonly origin: string
  /** One-time path the renderer must load first; it plants the local cookie. */
  readonly bootstrapPath: string
  close(): Promise<void>
  setSession(id: string | null): void
  setPendingReturn(path: string): void
  takePendingReturn(): string
  /** Sets the one-time sign-in nonce before redirecting to GitHub. */
  setPendingNonce(nonce: string): void
  /** One-time sign-in nonce the desktop app set before redirecting to GitHub; null once taken or cleared. */
  takePendingNonce(): string | null
}

const cookie = (header: string | undefined, name: string): string | null => {
  if (header === undefined) return null
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=")
    if (key === name) return rest.join("=")
  }
  return null
}

const under = (path: string, prefixes: readonly string[]): boolean =>
  prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))

/** A preview document's root-relative asset requests carry the preview page as their Referer. */
const isPreviewReferer = (referer: string | undefined): boolean => referer !== undefined && referer.includes("/_preview/")

const send = (res: ServerResponse, status: number, body: string, type = "text/plain; charset=utf-8"): void => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" })
  res.end(body)
}

const serveFile = (res: ServerResponse, file: string, cache: "immutable" | "no-cache"): void => {
  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": cache === "immutable" ? "public, max-age=31536000, immutable" : "no-cache",
    "x-content-type-options": "nosniff",
  })
  createReadStream(file).pipe(res)
}

/**
 * Serves the built SPA on loopback and proxies the control-plane paths to the Worker.
 *
 * The app is same-origin with this server, so its existing cookie-based client works unchanged. The Worker never sees
 * the renderer's origin: the proxy attaches the stored session cookie. A random per-launch cookie keeps other local
 * processes from using the proxy.
 */
export const startDesktopServer = async (options: DesktopServerOptions): Promise<DesktopServer> => {
  const token = randomBytes(24).toString("base64url")
  const root = resolve(options.appDist)
  const index = join(root, "index.html")
  let session = await options.getSession()
  let pendingReturn = "/"
  let pendingNonce: string | null = null

  const proxy = createProxyServer({ target: options.controlUrl, changeOrigin: true, ws: true, secure: true })
  proxy.on("proxyReq", (proxyReq) => {
    if (session === null) proxyReq.removeHeader("cookie")
    else proxyReq.setHeader("cookie", `session=${session}`)
  })
  proxy.on("proxyReqWs", (proxyReq) => {
    if (session === null) proxyReq.removeHeader("cookie")
    else proxyReq.setHeader("cookie", `session=${session}`)
  })
  proxy.on("proxyRes", (proxyRes, req) => {
    if (req.url?.startsWith("/auth/logout") === true && proxyRes.statusCode === 204) {
      session = null
      void options.clearSession()
    }
  })
  proxy.on("error", (error, _req, res) => {
    if (res instanceof Object && "writeHead" in res && !res.headersSent) {
      send(res as ServerResponse, 502, `control plane unreachable: ${error.message}`)
    }
  })

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")

      if (url.pathname === `/__desktop/${token}`) {
        res.writeHead(302, {
          location: "/",
          "set-cookie": `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`,
        })
        res.end()
        return
      }

      if (cookie(req.headers.cookie, COOKIE) !== token) {
        send(res, 401, "Kestrel desktop: open the app window")
        return
      }

      if (url.pathname === "/auth/github/login") {
        pendingReturn = safeLocalPath(url.searchParams.get("return"))
        pendingNonce = randomBytes(24).toString("base64url")
        res.writeHead(302, {
          location: loginUrl(options.controlUrl, options.callbackPath, pendingNonce),
          "cache-control": "no-store",
        })
        res.end()
        return
      }

      if (under(url.pathname, PROXY_PREFIXES) || isPreviewReferer(req.headers.referer)) {
        proxy.web(req, res)
        return
      }

      let pathname: string
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        send(res, 400, "bad path")
        return
      }
      const candidate = resolve(root, `.${pathname}`)
      if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
        send(res, 404, "not found")
        return
      }
      try {
        const info = await stat(candidate)
        if (info.isFile()) {
          serveFile(res, candidate, pathname.startsWith("/assets/") ? "immutable" : "no-cache")
          return
        }
      } catch {
        // Not a file; fall through to the SPA entry.
      }
      if (extname(pathname) === "" || (req.headers.accept ?? "").includes("text/html")) {
        serveFile(res, index, "no-cache")
        return
      }
      send(res, 404, "not found")
    })()
  })

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    if ((!under(url.pathname, WS_PREFIXES) && !isPreviewReferer(req.headers.referer)) || cookie(req.headers.cookie, COOKIE) !== token) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
      socket.destroy()
      return
    }
    proxy.ws(req, socket, head)
  })

  const { promise, resolve: ready, reject } = Promise.withResolvers<void>()
  server.once("error", reject)
  server.listen(0, "127.0.0.1", () => {
    server.off("error", reject)
    ready()
  })
  await promise
  const address = server.address()
  if (address === null || typeof address === "string") throw new Error("desktop server did not bind a TCP port")
  const origin = `http://127.0.0.1:${address.port}`

  return {
    origin,
    bootstrapPath: `/__desktop/${token}`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          proxy.close()
          done()
        })
        server.closeAllConnections()
      }),
    setSession: (id) => {
      session = id
    },
    setPendingReturn: (path) => {
      pendingReturn = safeLocalPath(path)
    },
    takePendingReturn: () => {
      const path = pendingReturn
      pendingReturn = "/"
      return path
    },
    setPendingNonce: (nonce) => {
      pendingNonce = nonce
    },
    takePendingNonce: () => {
      const nonce = pendingNonce
      pendingNonce = null
      return nonce
    },
  }
}
