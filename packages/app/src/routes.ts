/**
 * Home of the signed-in app (new thread composer); a thread lives at `${APP_HOME}/:taskId`. `/` and `/pricing` are
 * the public pages.
 */
export const APP_HOME = "/c"

export const threadPath = (taskId: string) => `${APP_HOME}/${taskId}`
