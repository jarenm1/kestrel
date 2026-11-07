import {
  AGENT_MODELS,
  MODEL_PROVIDERS,
  connectedModelProviders,
  modelHarness,
  type AgentModel,
  type Connection,
  type ModelHarness,
  type ModelInfo,
  type ModelProvider,
  type ModelProviderInfo,
} from "@cloudagents/protocol"
import {
  githubReferenceLabel,
  parseGithubReferenceDraft,
  type GithubDraftSegment,
} from "./reference/githubReference"

/** The agent CLI a model's catalog route runs in. */
export type ModelMentionHarness = ModelHarness

/** The picker rail's order, independent of the catalog's provider order. */
const HARNESS_ORDER: readonly ModelMentionHarness[] = ["claude", "codex", "opencode", "antigravity", "devin"]

const HARNESS_NAMES: Record<ModelMentionHarness, string> = {
  claude: "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  antigravity: "Antigravity",
  devin: "Devin",
}

/** One model as a mention: exactly what the harness needs to delegate to it, plus what the menu shows. */
export interface ModelMention {
  readonly id: AgentModel
  readonly provider: ModelProvider
  /** Display name, without a route suffix; the harness and credential are shown beside it. */
  readonly name: string
  /** Provider-qualified id (`anthropic/claude-opus-5`), with any provider prefix already in the id kept once. */
  readonly slug: string
  readonly harness: ModelMentionHarness
  readonly harnessName: string
}

/** Whether an id names an explicit non-default harness route (`base@harness`) rather than a base catalog entry. */
export const isRouteModel = (model: Pick<ModelInfo, "id">): boolean => model.id.includes("@")

/** A route's display name without the catalog's "via <Harness>" suffix; the picker groups by harness already. */
export const modelDisplayName = (model: ModelInfo): string => {
  if (!isRouteModel(model)) return model.name
  const base = AGENT_MODELS.find((candidate) => candidate.id === model.id.slice(0, model.id.lastIndexOf("@")))
  return base?.name ?? model.name
}

/** The harness a model's route runs, with the name the picker and mention chips show. */
export function modelHarnessOf(model: ModelInfo): { readonly harness: ModelMentionHarness; readonly name: string } {
  const harness = modelHarness(model.id) as ModelMentionHarness
  return { harness, name: HARNESS_NAMES[harness] }
}

/** `opencode/big-pickle` is already provider-qualified; `claude-opus-5` gains its provider. */
export const modelMentionOf = (model: ModelInfo): ModelMention => {
  const harness = modelHarnessOf(model)
  return {
    id: model.id,
    provider: model.provider,
    name: modelDisplayName(model),
    slug: model.id.startsWith(`${model.provider}/`) ? model.id : `${model.provider}/${model.id}`,
    harness: harness.harness,
    harnessName: harness.name,
  }
}

/** A connected credential with its models under the actual harness they run (a provider may appear more than once). */
export interface ModelSection {
  readonly provider: ModelProviderInfo
  readonly harness: ModelMentionHarness
  readonly models: readonly ModelInfo[]
}

/**
 * Connections a route may use for its credential. A vendor API key may run its provider's models in another harness;
 * a Claude or ChatGPT subscription is native-only. Every other provider's route uses the connection that unlocks it
 * (the gateway key, or OpenCode Go's saved key).
 */
const routeConnectionIds = (provider: ModelProvider): readonly string[] => {
  if (provider === "anthropic" || provider === "openai") return [provider]
  return MODEL_PROVIDERS.find((candidate) => candidate.id === provider)?.connections ?? []
}

/**
 * Whether a catalog route is offered. Base ids depend on their provider's connection (as before). A route needs the
 * selected box to launch its harness (`modelHarnesses`, absent on boxes too old to route) and a credential that may
 * use it: an API key for Anthropic/OpenAI, never their subscription logins.
 */
export const modelRouteAvailable = (
  model: ModelInfo,
  connections: readonly Connection[],
  modelHarnesses: readonly ModelMentionHarness[] | undefined,
): boolean => {
  if (!isRouteModel(model)) return true
  const harness = modelHarness(model.id)
  if (modelHarnesses === undefined || !modelHarnesses.some((candidate) => candidate === harness)) return false
  const required = routeConnectionIds(model.provider)
  if (required.length === 0) return false
  if (model.provider === "anthropic" || model.provider === "openai") {
    return connections.some(
      (connection) =>
        connection.provider === model.provider &&
        connection.kind === "apikey" &&
        connection.connected &&
        connection.available !== false,
    )
  }
  return connections.some(
    (connection) =>
      required.includes(connection.provider) && connection.connected && connection.available !== false,
  )
}

/**
 * The connected providers' shown models, split by the harness each model's route runs. `modelHarnesses` is the box's
 * launchable harness list; route entries stay hidden until the box reports the harness and the credential may use it.
 */
export const offeredModelSections = (
  connections: readonly Connection[],
  shown: Readonly<Record<ModelProvider, readonly ModelInfo[]>>,
  modelHarnesses: readonly ModelMentionHarness[] | undefined,
): readonly ModelSection[] => {
  const sections: ModelSection[] = []
  for (const provider of connectedModelProviders(connections)) {
    const models = shown[provider.id].filter((model) => modelRouteAvailable(model, connections, modelHarnesses))
    for (const harness of HARNESS_ORDER) {
      const harnessModels = models.filter((model) => modelHarness(model.id) === harness)
      if (harnessModels.length > 0) sections.push({ provider, harness, models: harnessModels })
    }
  }
  return sections
}

/**
 * Characters a `@` token continues through. Model ids and slugs use letters, digits and these marks; `@` is also the
 * route separator (`base@harness`), so a typed or backspaced route id stays one token. Whitespace and punctuation end
 * the token, so `@claude,` still offers Claude models and an email address never opens the menu.
 */
const MENTION_TOKEN = /[\p{L}\p{N}._/[\]@-]/u

/**
 * The `@query` token under the caret. `start` is the `@`, `end` the token's end even when the caret is inside it (so
 * picking replaces the whole token). The `@` has to begin a word: `me@example.com` and `word@x` are not mentions, and
 * a second `@` immediately after the marker (`@@opus`) is not one either.
 */
export function findModelMentionTrigger(
  text: string,
  caret: number,
): { readonly start: number; readonly end: number; readonly query: string } | undefined {
  if (!Number.isInteger(caret) || caret < 1 || caret > text.length) return undefined
  let start = caret
  while (start > 0) {
    const character = text[start - 1]!
    // The marker itself is not part of the token body; a route's trailing `@harness` is.
    if (character === "@" && (start - 1 === 0 || /\s/.test(text[start - 2]!))) break
    if (!MENTION_TOKEN.test(character)) break
    start--
  }
  // `@` sits immediately before the token; an empty query is the bare `@`.
  const hash = start - 1
  if (hash < 0 || text[hash] !== "@" || text[hash + 1] === "@") return undefined
  let end = caret
  while (end < text.length && MENTION_TOKEN.test(text[end]!)) end++
  return { start: hash, end, query: text.slice(start, end) }
}

/**
 * Models matching every whitespace-separated term of `query`, in the given (picker) order. Terms match the name, id,
 * slug, provider or harness name case-insensitively, so `opus`, `anthropic/claude` and `codex` all find their models.
 */
export function filterMentionModels(models: readonly ModelInfo[], query: string): readonly ModelInfo[] {
  const terms = query.toLowerCase().replace(/^@+/, "").split(/\s+/).filter((term) => term !== "")
  if (terms.length === 0) return models
  return models.filter((model) => {
    const mention = modelMentionOf(model)
    const provider = MODEL_PROVIDERS.find((candidate) => candidate.id === model.provider)
    const haystack = `${mention.name} ${mention.id} ${mention.slug} ${provider?.name ?? model.provider} ${mention.harnessName}`.toLowerCase()
    return terms.every((term) => haystack.includes(term))
  })
}

/**
 * The serialized mention: a normal Markdown link whose label stays readable in the prompt and whose destination names
 * the exact model id, provider and harness. No protocol change is needed; nothing in the message switches models.
 */
export function modelMentionMarkdown(model: ModelInfo): string {
  const mention = modelMentionOf(model)
  return `[@${mention.name}](model:${mention.id}?provider=${mention.provider}&harness=${mention.harness})`
}

/** The `@id` text a model chip returns to when the user backspaces into it, so the menu reopens for that model. */
export function modelMentionTypedText(mention: ModelMention): string {
  return `@${mention.id}`
}

const MODEL_MENTION_MARKDOWN =
  /^\[@([^\]\n]+)\]\(model:([^)?\s]+)\?provider=([^&\s)]+)&harness=(claude|codex|opencode|antigravity|devin)\)$/

const MODEL_MENTION_IN_DRAFT =
  /\[@([^\]\n]+)\]\(model:([^)?\s]+)\?provider=([^&\s)]+)&harness=(claude|codex|opencode|antigravity|devin)\)/g

/** Validates the four fields against the catalog; a link naming an unknown model (or another provider/harness) is text. */
function mentionFromParts(
  label: string,
  id: string,
  provider: string,
  harness: string,
): { readonly model: ModelInfo; readonly mention: ModelMention } | undefined {
  const model = AGENT_MODELS.find((candidate) => candidate.id === id)
  if (model === undefined || model.provider !== provider) return undefined
  const mention = modelMentionOf(model)
  if (mention.harness !== harness || mention.name !== label) return undefined
  return { model, mention }
}

/** Both halves of one serialized model mention, or undefined when the text is anything else. */
export function parseModelMentionMarkdown(
  text: string,
): { readonly model: ModelInfo; readonly mention: ModelMention; readonly markdown: string } | undefined {
  const match = MODEL_MENTION_MARKDOWN.exec(text)
  if (match === null) return undefined
  const parsed = mentionFromParts(match[1]!, match[2]!, match[3]!, match[4]!)
  return parsed === undefined ? undefined : { ...parsed, markdown: text }
}

/** One drafted token: plain text, a GitHub reference chip, or a model mention chip. */
export type ComposerDraftSegment =
  | GithubDraftSegment
  | { readonly type: "model"; readonly markdown: string; readonly model: ModelInfo; readonly mention: ModelMention }

/** Splits model mentions out of plain text, leaving anything that is not an exact catalog token as text. */
function parseModelDraft(text: string): ComposerDraftSegment[] {
  const segments: ComposerDraftSegment[] = []
  let at = 0
  MODEL_MENTION_IN_DRAFT.lastIndex = 0
  for (
    let match = MODEL_MENTION_IN_DRAFT.exec(text);
    match !== null;
    match = MODEL_MENTION_IN_DRAFT.exec(text)
  ) {
    const parsed = mentionFromParts(match[1]!, match[2]!, match[3]!, match[4]!)
    if (parsed === undefined) continue
    if (match.index > at) segments.push({ type: "text", text: text.slice(at, match.index) })
    segments.push({ type: "model", markdown: match[0], model: parsed.model, mention: parsed.mention })
    at = match.index + match[0].length
  }
  if (at < text.length) segments.push({ type: "text", text: text.slice(at) })
  return segments
}

/**
 * Splits a stored draft into text, GitHub reference chips and model mention chips, in reading order. Model parsing
 * runs on the reference parser's text runs, so both token kinds can sit in one draft in any order.
 */
export function parseComposerDraft(markdown: string): ComposerDraftSegment[] {
  const segments: ComposerDraftSegment[] = []
  for (const segment of parseGithubReferenceDraft(markdown)) {
    if (segment.type === "text") segments.push(...parseModelDraft(segment.text))
    else segments.push(segment)
  }
  return segments
}

/** A draft's plain text and chip-masked text, shared by the editor and its parent. */
export function draftTexts(
  markdown: string,
  placeholder = "\uFFFC",
): { readonly plain: string; readonly referenceText: string } {
  let plain = ""
  let referenceText = ""
  for (const segment of parseComposerDraft(markdown)) {
    if (segment.type === "text") {
      plain += segment.text
      referenceText += segment.text
    } else if (segment.type === "reference") {
      const label = githubReferenceLabel(segment.reference.kind, segment.reference.number)
      plain += label
      referenceText += placeholder.repeat(label.length)
    } else {
      plain += segment.mention.name
      referenceText += placeholder.repeat(segment.mention.name.length)
    }
  }
  return { plain, referenceText }
}
