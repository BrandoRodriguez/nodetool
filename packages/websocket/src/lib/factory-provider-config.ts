/**
 * The Provider Manager's saved configuration: the browser transport, the
 * authorized tab per browser provider, and the paid API providers the user
 * turned on for media. One settings row in the app's own database (the
 * isolated environment's, in development) is the single source; loading or
 * saving it applies it to the browser package (agents, storyboard, workflow
 * providers read it there) and to the runtime's generation admission.
 */
import { z } from "zod";
import { Setting } from "@nodetool-ai/models";
import {
  SELECTABLE_BROWSER_TRANSPORTS,
  setSavedBrowserConfig,
  type SelectableBrowserTransport
} from "@nodetool-ai/browser";
import { installPaidMediaPolicy } from "@nodetool-ai/runtime";

export const FACTORY_PROVIDER_SETTING_KEY = "FACTORY_PROVIDER_MANAGER";

const configSchema = z.object({
  transport: z.enum(SELECTABLE_BROWSER_TRANSPORTS).optional(),
  providerTabs: z
    .record(z.string().regex(/^[a-z0-9_]{1,64}$/), z.string().regex(/^[A-Za-z0-9-]{1,128}$/))
    .default({}),
  paidMediaEnabled: z.array(z.string().regex(/^[a-z0-9_-]{1,64}$/)).default([])
});

export type FactoryProviderConfig = z.infer<typeof configSchema>;

const EMPTY: FactoryProviderConfig = { providerTabs: {}, paidMediaEnabled: [] };

let current: FactoryProviderConfig = EMPTY;

/** A saved value read back; anything malformed falls back to the safe default. */
export function parseFactoryProviderConfig(raw: string | null | undefined): FactoryProviderConfig {
  if (!raw) return { ...EMPTY };
  try {
    const parsed = configSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { ...EMPTY };
  } catch {
    return { ...EMPTY };
  }
}

/** Make `config` the one in effect for this process. */
export function applyFactoryProviderConfig(config: FactoryProviderConfig): void {
  current = config;
  setSavedBrowserConfig({
    ...(config.transport ? { transport: config.transport } : {}),
    providerTabs: config.providerTabs
  });
  // Paid media is off until the user turns a provider on, with or without a
  // saved row.
  installPaidMediaPolicy(config.paidMediaEnabled);
}

export function currentFactoryProviderConfig(): FactoryProviderConfig {
  return {
    ...(current.transport ? { transport: current.transport } : {}),
    providerTabs: { ...current.providerTabs },
    paidMediaEnabled: [...current.paidMediaEnabled]
  };
}

/** Read the saved configuration for `userId` and apply it. */
export async function loadFactoryProviderConfig(userId: string): Promise<FactoryProviderConfig> {
  const row = await Setting.find(userId, FACTORY_PROVIDER_SETTING_KEY);
  const config = parseFactoryProviderConfig(row?.value);
  applyFactoryProviderConfig(config);
  return config;
}

/** Save and apply `config` for `userId`. */
export async function saveFactoryProviderConfig(
  userId: string,
  config: FactoryProviderConfig
): Promise<FactoryProviderConfig> {
  const valid = configSchema.parse(config);
  await Setting.upsert({
    userId,
    key: FACTORY_PROVIDER_SETTING_KEY,
    value: JSON.stringify(valid),
    description: "AI Content Factory Provider Manager"
  });
  applyFactoryProviderConfig(valid);
  return valid;
}

export type { SelectableBrowserTransport };
