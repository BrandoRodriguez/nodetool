/**
 * The providers AI Content Factory manages, as the Provider Manager shows
 * them. Hosted APIs and local engines come from the provider registry; this
 * file adds what the registry cannot say about browser-driven sites: their
 * host, which transports can serve them, and whether the integration works
 * yet.
 */

import type { ProviderAccessMode } from "./manual-step.js";

/** The four kinds of output the manager groups capabilities into. */
export type CapabilityGroup = "text" | "image" | "video" | "audio";

export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = ["text", "image", "video", "audio"];

const GROUP_OF: Readonly<Record<string, CapabilityGroup>> = {
  generate_message: "text",
  generate_messages: "text",
  text_to_image: "image",
  image_to_image: "image",
  text_to_video: "video",
  image_to_video: "video",
  reference_to_video: "video",
  video_to_video: "video",
  text_to_speech: "audio",
  automatic_speech_recognition: "audio",
  text_to_music: "audio",
  audio_to_audio: "audio",
  speech_to_speech: "audio"
};

/** Capability names (as providers declare them) grouped into the four kinds, in order. */
export function capabilityGroups(capabilities: readonly string[]): CapabilityGroup[] {
  const found = new Set<CapabilityGroup>();
  for (const capability of capabilities) {
    const group = GROUP_OF[capability];
    if (group) found.add(group);
  }
  return CAPABILITY_GROUPS.filter((group) => found.has(group));
}

/** Capabilities that produce media rather than text or vectors. */
export function isMediaCapability(capability: string): boolean {
  const group = GROUP_OF[capability];
  if (group) return group !== "text";
  return !["generate_message", "generate_messages", "generate_embedding", "rerank"].includes(capability);
}

/**
 * - `available`: works on the transports listed.
 * - `terms_unreviewed`: the site's terms have not been reviewed; while the
 *   terms policy is on, it is not offered and its generations are refused.
 * - `planned`: designed for, not built. Never offered.
 */
export type BrowserIntegrationState = "available" | "terms_unreviewed" | "planned";

export interface FactoryBrowserProvider {
  /** Provider id in the registry (none yet for a planned one). */
  id: string;
  name: string;
  host: string;
  integration: BrowserIntegrationState;
  /** Transports whose provider tabs this provider can use. */
  transports: ReadonlyArray<"extension" | "orca">;
}

export const FACTORY_BROWSER_PROVIDERS: readonly FactoryBrowserProvider[] = [
  { id: "chatgpt", name: "ChatGPT", host: "chatgpt.com", integration: "available", transports: ["extension", "orca"] },
  { id: "gemini_web", name: "Gemini", host: "gemini.google.com", integration: "terms_unreviewed", transports: ["extension"] },
  { id: "google_flow", name: "Google Flow", host: "flow.google.com", integration: "terms_unreviewed", transports: ["extension"] },
  { id: "dreamina", name: "Dreamina", host: "dreamina.capcut.com", integration: "terms_unreviewed", transports: ["extension"] },
  { id: "muse_ai", name: "Muse.ai", host: "muse.ai", integration: "planned", transports: [] }
];

export function factoryBrowserProvider(id: string): FactoryBrowserProvider | undefined {
  return FACTORY_BROWSER_PROVIDERS.find((entry) => entry.id === id);
}

/** One provider as the manager lists it. */
export interface ManagedProvider {
  id: string;
  name: string;
  mode: ProviderAccessMode;
  capabilities: CapabilityGroup[];
  /** Usable now, under the current policy and configuration. */
  available: boolean;
  /** Why not, as a stable code the UI translates. */
  unavailableReason?:
    | "planned"
    | "terms_unreviewed"
    | "not_configured"
    | "transport_unsupported"
    | "paid_disabled"
    | "account_unverified";
  /** What an API provider signs in with: a stored key, or an account this page does not verify. */
  credential?: "api_key" | "account" | "none";
  /** Credentials or connection the provider needs are present. Says nothing of a live session. */
  configured: boolean;
  /** Hosted API that bills per call. */
  paid: boolean;
  /** For a paid provider: the user turned its media generation on. */
  paidEnabled: boolean;
  /** Browser providers only. */
  host?: string;
  transports?: Array<"extension" | "orca">;
  /** The secret the provider reads its key from, for API providers. */
  secretKey?: string | null;
}
