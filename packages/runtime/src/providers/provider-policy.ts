/**
 * Server-side admission for one generation, applied inside the generation
 * envelope every caller goes through (workflows, agents, storyboard, chat,
 * MCP). Two rules:
 *
 * - The browser provider terms policy: a browser provider whose site terms
 *   have not been reviewed is refused while the policy is on.
 * - Paid media off by default: once the server installs the policy, a media
 *   generation (image, video, audio) on a hosted API provider is refused
 *   until the user turns that provider on. Text generation is not affected.
 *
 * As a library, the runtime installs no paid-media policy; the NodeTool
 * server installs it at start-up from the saved configuration.
 */

import { isMediaCapability } from "@nodetool-ai/protocol";
import { assertBrowserProviderAllowed, providerAccessMode } from "./browser-provider-terms.js";

let paidMediaEnabled: ReadonlySet<string> | null = null;

/** Turn the paid-media rule on, allowing only the listed providers. */
export function installPaidMediaPolicy(enabledProviders: readonly string[]): void {
  paidMediaEnabled = new Set(enabledProviders);
}

/** Remove the paid-media rule (tests, or a server that bills elsewhere). */
export function clearPaidMediaPolicy(): void {
  paidMediaEnabled = null;
}

/** The providers allowed to run paid media, or null when the rule is off. */
export function paidMediaPolicy(): ReadonlySet<string> | null {
  return paidMediaEnabled;
}

/** A hosted API: each call may be billed. Browser sites and local engines are not. */
export function isPaidProvider(providerId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  return providerAccessMode(providerId, env) === "api";
}

export class PaidProviderDisabledError extends Error {
  readonly providerId: string;

  constructor(providerId: string) {
    super(
      `Paid media generation with ${providerId} is turned off. Nothing was sent and nothing was billed. ` +
        "Turn it on for this provider in Providers if you accept its cost."
    );
    this.name = "PaidProviderDisabledError";
    this.providerId = providerId;
  }
}

/** Throws when the generation may not run here. Sends nothing. */
export function assertGenerationAllowed(
  request: { provider: string; capability: string },
  env: NodeJS.ProcessEnv = process.env
): void {
  assertBrowserProviderAllowed(request.provider, env);
  if (!paidMediaEnabled) return;
  if (!isMediaCapability(request.capability)) return;
  if (!isPaidProvider(request.provider, env)) return;
  if (!paidMediaEnabled.has(request.provider)) throw new PaidProviderDisabledError(request.provider);
}
