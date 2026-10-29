/**
 * Prefixes a run's prompt with who the agent works for. Agents have no way to learn the user's GitHub login from their
 * tools, so without this "my repo" reads as a project name to look up on the web.
 */
export const withUserContext = (login: string, prompt: string): string =>
  [
    `The user is signed in to Kestrel as GitHub user \`${login}\`.`,
    `When they say "my repo", "my project" or similar without naming an owner, they mean a repository owned by \`${login}\`.`,
    `If the thread already has that repository checked out, use that checkout. Otherwise check it out with repo_checkout as \`${login}/<name>\`.`,
    "If that repository does not exist, ask the user which one they mean. Do not web-search for a project with that name.",
    "",
    prompt,
  ].join("\n")
