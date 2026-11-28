/**
 * The Provider Manager's saved configuration, as one JSON settings row: the
 * browser transport, the authorized tab per browser provider, and the paid
 * API providers turned on for media. Parsing and applying it lives here so
 * every entry point that runs generations (the server, `nodetool run`) uses
 * the same rules; each caller only reads or writes the row.
 *
 * It is active only inside the AI Content Factory environment
 * (`NODETOOL_PROVIDER_MANAGER=1`, exported by `electron/scripts/factory/dev-env.sh`).
 * Elsewhere nothing is installed and NodeTool behaves as upstream.
 */
import { z } from "zod";
import { SELECTABLE_BROWSER_TRANSPORTS, setSavedBrowserConfig } from "@nodetool-ai/browser";
import { installPaidMediaPolicy } from "./provider-policy.js";

export const FACTORY_PROVIDER_SETTING_KEY = "FACTORY_PROVIDER_MANAGER";

/** Whether this process runs in the AI Content Factory environment. */
export function providerManagerEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["NODETOOL_PROVIDER_MANAGER"]?.trim() === "1";
}

export const factoryProviderConfigSchema = z.object({
  transport: z.enum(SELECTABLE_BROWSER_TRANSPORTS).optional(),
  providerTabs: z
    .record(z.string().regex(/^[a-z0-9_]{1,64}$/), z.string().regex(/^[A-Za-z0-9-]{1,128}$/))
    .default({}),
  paidMediaEnabled: z.array(z.string().regex(/^[a-z0-9_-]{1,64}$/)).default([])
});

export type FactoryProviderConfig = z.infer<typeof factoryProviderConfigSchema>;

const empty = (): FactoryProviderConfig => ({ providerTabs: {}, paidMediaEnabled: [] });

let current: FactoryProviderConfig = empty();

/** A saved value read back; anything malformed falls back to the safe default. */
export function parseFactoryProviderConfig(raw: string | null | undefined): FactoryProviderConfig {
  if (!raw) return empty();
  try {
    const parsed = factoryProviderConfigSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : empty();
  } catch {
    return empty();
  }
}

/**
 * Make `config` the one in effect for this process: the browser package
 * (agents, storyboard and workflow providers read it there) and the
 * paid-media admission. Paid media is off until a provider is turned on,
 * with or without a saved row.
 */
export function applyFactoryProviderConfig(config: FactoryProviderConfig): void {
  current = config;
  setSavedBrowserConfig({
    ...(config.transport ? { transport: config.transport } : {}),
    providerTabs: config.providerTabs
  });
  installPaidMediaPolicy(config.paidMediaEnabled);
}

export function currentFactoryProviderConfig(): FactoryProviderConfig {
  return {
    ...(current.transport ? { transport: current.transport } : {}),
    providerTabs: { ...current.providerTabs },
    paidMediaEnabled: [...current.paidMediaEnabled]
  };
}

/**
 * Apply the saved row for this process when the Provider Manager is enabled.
 * `readRow` answers the row's raw value; a failed read keeps paid media off.
 * Answers whether anything was applied.
 */
export async function applySavedFactoryProviderConfig(
  readRow: () => Promise<string | null | undefined>,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!providerManagerEnabled(env)) return false;
  const raw = await readRow().catch(() => null);
  applyFactoryProviderConfig(parseFactoryProviderConfig(raw));
  return true;
}
