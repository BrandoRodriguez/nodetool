/**
 * What each browser-driven provider's terms allow, and the errors a provider
 * raises when it stops for the user.
 *
 * With `NODETOOL_BROWSER_PROVIDER_POLICY=terms`, a provider whose terms do not
 * allow automated submission or retrieval never sends a request or reads a
 * result from its site. It shows the user the signed-in tab and stops with a
 * {@link ManualGenerationRequiredError} that carries the exact prompt and the
 * steps to finish by hand, plus the provider's sanctioned programmatic route.
 * Without the variable, providers behave as they always have.
 */

export interface BrowserProviderTerms {
  providerId: string;
  host: string;
  /** The terms allow sending a request to the site by program. */
  automatedSubmission: boolean;
  /** The terms allow reading a result back from the site by program. */
  automatedRetrieval: boolean;
  /** Where the user can read the terms this entry summarizes. */
  termsUrl: string;
  /** The programmatic route the provider does sanction, when there is one. */
  sanctionedAlternative: string;
}

/**
 * OpenAI's Terms of Use list among prohibited uses automatically or
 * programmatically extracting data or Output from its services; the API is
 * the programmatic route.
 */
export const BROWSER_PROVIDER_TERMS: Readonly<Record<string, BrowserProviderTerms>> = {
  chatgpt: {
    providerId: "chatgpt",
    host: "chatgpt.com",
    automatedSubmission: false,
    automatedRetrieval: false,
    termsUrl: "https://openai.com/policies/terms-of-use/",
    sanctionedAlternative: "the OpenAI provider (API key, gpt-image models)"
  }
};

/** Whether provider terms are enforced in this process. */
export function enforceProviderTerms(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["NODETOOL_BROWSER_PROVIDER_POLICY"]?.trim() === "terms";
}

/** True when the provider may be driven by program here. */
export function automationAllowed(providerId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!enforceProviderTerms(env)) return true;
  const terms = BROWSER_PROVIDER_TERMS[providerId];
  // A provider with no entry has not been reviewed; enforcing means refusing it.
  return terms !== undefined && terms.automatedSubmission && terms.automatedRetrieval;
}

/**
 * The provider stopped before sending anything: this step is the user's.
 * `prompt` is exactly what the user should give the site.
 */
export class ManualGenerationRequiredError extends Error {
  readonly providerId: string;
  readonly prompt: string;

  constructor(providerId: string, prompt: string, steps: string[]) {
    super(["Manual step needed. " + steps.join(" "), "", "Prompt:", prompt].join("\n"));
    this.name = "ManualGenerationRequiredError";
    this.providerId = providerId;
    this.prompt = prompt;
  }
}

/**
 * The site answered HTTP 429. Nothing more is sent to it before `retryAt`,
 * and the operation is not repeated in another conversation.
 */
export class ProviderRateLimitedError extends Error {
  readonly providerId: string;
  readonly retryAt: number;

  constructor(providerId: string, retryAt: number) {
    const seconds = Math.max(0, Math.ceil((retryAt - Date.now()) / 1000));
    super(`${providerId} answered HTTP 429 (too many requests). Wait ${seconds} s before trying again; nothing was resent.`);
    this.name = "ProviderRateLimitedError";
    this.providerId = providerId;
    this.retryAt = retryAt;
  }
}

/** Default wait after a 429 that names no Retry-After. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;

/** Retry-After as milliseconds: delay-seconds or an HTTP-date. Null when absent or unparseable. */
export function retryAfterMs(raw: string | null | undefined, now = Date.now()): number | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const at = Date.parse(trimmed);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/** Per-provider 429 cooldowns, so every call path honours one block. */
export class ProviderCooldowns {
  private readonly until = new Map<string, number>();

  block(providerId: string, retryAfter: string | null | undefined, now = Date.now()): ProviderRateLimitedError {
    const wait = retryAfterMs(retryAfter, now) ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS;
    const at = Math.max(this.until.get(providerId) ?? 0, now + wait);
    this.until.set(providerId, at);
    return new ProviderRateLimitedError(providerId, at);
  }

  /** Throws while the provider is cooling down. */
  assertReady(providerId: string, now = Date.now()): void {
    const at = this.until.get(providerId);
    if (at !== undefined && at > now) throw new ProviderRateLimitedError(providerId, at);
  }

  clear(): void {
    this.until.clear();
  }
}
