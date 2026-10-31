import { BOX_USER_HEADER } from "@cloudagents/protocol"

/** Set by the box on requests whose grant is for a dev-login session; a client can never set it. */
export const BOX_DEV_HEADER = "x-kestrel-box-dev"

/** Identity headers only the box sets. Whatever a client sends under these names is discarded before routing. */
export const IDENTITY_HEADERS: readonly string[] = [BOX_USER_HEADER, BOX_DEV_HEADER]
