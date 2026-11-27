/**
 * A generation step the provider leaves to the user.
 *
 * Some media providers work through a website whose terms forbid automated
 * use. In assisted mode such a provider sends nothing; it stops with a
 * message that carries the exact prompt and the steps to finish by hand. The
 * message crosses the generation RPC as text, so its shape is fixed here and
 * every surface (the web board, the server render path, agents) reads it the
 * same way and puts the shot in `awaiting_manual_result` instead of `failed`.
 */

/** How a provider is reached. Each one is a different trust and cost model. */
export type ProviderAccessMode =
  /** A signed-in website the user drives by hand; NodeTool prepares and imports. */
  | "browser_assisted"
  /** A signed-in website NodeTool drives itself, where its terms allow it. */
  | "browser_automated"
  /** The provider's official API with a key. May cost money per call. */
  | "api"
  /** A model running on this machine. */
  | "local";

/** What a shot waits for while it is `awaiting_manual_result`. */
export interface ManualResultRequest {
  /** Provider id, e.g. `chatgpt`. */
  provider: string;
  model?: string;
  access_mode: ProviderAccessMode;
  /** What the user is to produce for the shot. */
  kind: "keyframe" | "clip";
  /** Exactly what to give the provider. */
  prompt: string;
  /** The steps, in order, as plain sentences. */
  steps: string[];
  /** Where the provider's site is, for opening it when no tab can be shown. */
  open_url?: string;
  /** ISO time the request was made. */
  requested_at: string;
}

const MARKER = "[nodetool:manual-step]";
const PROMPT_HEADING = "\nPrompt:\n";

/**
 * The message a provider throws to hand a step to the user. Readable as is,
 * and parsed back by {@link parseManualStepMessage}.
 */
export function formatManualStepMessage(step: {
  provider: string;
  prompt: string;
  steps: string[];
  openUrl?: string;
}): string {
  const header = `${MARKER} provider=${step.provider}${step.openUrl ? ` url=${step.openUrl}` : ""}`;
  return [`Manual step needed. ${step.steps.join(" ")}`, header, `${PROMPT_HEADING.trimStart()}${step.prompt}`].join("\n");
}

/**
 * The manual step inside an error message, or null when the message is an
 * ordinary failure. Tolerates a prefix a caller added in front (for example
 * `text_to_image failed: `).
 */
export function parseManualStepMessage(
  message: string | null | undefined,
  context: { kind: "keyframe" | "clip"; model?: string; now?: Date } = { kind: "keyframe" }
): ManualResultRequest | null {
  if (!message) return null;
  const markerAt = message.indexOf(MARKER);
  if (markerAt < 0) return null;
  const headerEnd = message.indexOf("\n", markerAt);
  const header = message.slice(markerAt, headerEnd < 0 ? undefined : headerEnd);
  const provider = /provider=(\S+)/.exec(header)?.[1];
  if (!provider) return null;
  const url = /url=(https:\/\/\S+)/.exec(header)?.[1];
  const promptAt = message.indexOf(PROMPT_HEADING, markerAt);
  const prompt = promptAt < 0 ? "" : message.slice(promptAt + PROMPT_HEADING.length);
  const intro = message.slice(0, markerAt);
  const stepsText = intro.slice(intro.indexOf("Manual step needed.") + "Manual step needed.".length).trim();
  const steps = stepsText
    .split(/(?<=[.:])\s+(?=[A-Z"])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  return {
    provider,
    ...(context.model ? { model: context.model } : {}),
    access_mode: "browser_assisted",
    kind: context.kind,
    prompt,
    steps,
    ...(url ? { open_url: url } : {}),
    requested_at: (context.now ?? new Date()).toISOString()
  };
}
