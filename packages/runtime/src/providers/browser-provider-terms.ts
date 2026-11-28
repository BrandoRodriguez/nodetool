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

import { factoryBrowserProvider, formatManualStepMessage, type ProviderAccessMode } from "@nodetool-ai/protocol";
import { getRegisteredProvider } from "./provider-registry.js";

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
 * Local engines, by id: the fallback for a provider not registered in this
 * process. A registered provider is classified by where its registration says
 * inference runs.
 */
const LOCAL_PROVIDERS = new Set([
  "ollama",
  "lmstudio",
  "llama_cpp",
  "node_llama_cpp",
  "stable_diffusion_cpp",
  "wangp",
  "whisper_cpp",
  "whisper_cpp_server",
  "vllm",
  "huggingface",
  "transformers_js"
]);

/**
 * How a provider is reached here: a site driven by hand or by program, an
 * official API, or a local model. Browser providers depend on the terms
 * policy; the others follow their registration (`local_service` and
 * `in_process` run on this machine).
 */
export function providerAccessMode(providerId: string, env: NodeJS.ProcessEnv = process.env): ProviderAccessMode {
  if (BROWSER_PROVIDER_TERMS[providerId] || factoryBrowserProvider(providerId)) {
    return automationAllowed(providerId, env) ? "browser_automated" : "browser_assisted";
  }
  const access = getRegisteredProvider(providerId)?.metadata.access;
  if (access === "local_service" || access === "in_process") return "local";
  if (access === "remote_api") return "api";
  return LOCAL_PROVIDERS.has(providerId) ? "local" : "api";
}

/**
 * A browser provider whose site terms have not been reviewed, while the terms
 * policy is on. Nothing was sent to the site.
 */
export class ProviderTermsUnreviewedError extends Error {
  readonly providerId: string;

  constructor(providerId: string, name: string) {
    super(
      `${name} is not available while the provider terms policy is on: its site's terms have not been reviewed ` +
        "for automated use. Nothing was sent. Use ChatGPT in assisted mode, an official API, or a local model."
    );
    this.name = "ProviderTermsUnreviewedError";
    this.providerId = providerId;
  }
}

/** Throws for a browser provider the terms policy does not allow to run here. */
export function assertBrowserProviderAllowed(providerId: string, env: NodeJS.ProcessEnv = process.env): void {
  if (!enforceProviderTerms(env)) return;
  const entry = factoryBrowserProvider(providerId);
  if (entry && entry.integration !== "available") throw new ProviderTermsUnreviewedError(providerId, entry.name);
}

/**
 * The provider stopped before sending anything: this step is the user's.
 * `prompt` is exactly what the user should give the site. The message uses
 * the shared manual-step format, so every surface puts the shot in
 * `awaiting_manual_result`.
 */
export class ManualGenerationRequiredError extends Error {
  readonly providerId: string;
  readonly prompt: string;

  constructor(providerId: string, prompt: string, steps: string[], openUrl?: string) {
    super(formatManualStepMessage({ provider: providerId, prompt, steps, openUrl }));
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
