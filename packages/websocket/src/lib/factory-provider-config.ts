/**
 * Reading and writing the Provider Manager's settings row. The rules (parse,
 * validate, apply, enablement) live in the runtime, shared with
 * `nodetool run`; this file only touches the database.
 */
import { Setting } from "@nodetool-ai/models";
import {
  FACTORY_PROVIDER_SETTING_KEY,
  applyFactoryProviderConfig,
  applySavedFactoryProviderConfig,
  currentFactoryProviderConfig,
  factoryProviderConfigSchema,
  parseFactoryProviderConfig,
  providerManagerEnabled,
  type FactoryProviderConfig
} from "@nodetool-ai/runtime";

export {
  FACTORY_PROVIDER_SETTING_KEY,
  applyFactoryProviderConfig,
  currentFactoryProviderConfig,
  parseFactoryProviderConfig,
  providerManagerEnabled,
  type FactoryProviderConfig
};

/** Read the saved configuration for `userId` and apply it (when enabled). */
export async function loadFactoryProviderConfig(userId: string): Promise<FactoryProviderConfig> {
  await applySavedFactoryProviderConfig(async () => (await Setting.find(userId, FACTORY_PROVIDER_SETTING_KEY))?.value);
  return currentFactoryProviderConfig();
}

/** Save and apply `config` for `userId`. */
export async function saveFactoryProviderConfig(
  userId: string,
  config: FactoryProviderConfig
): Promise<FactoryProviderConfig> {
  const valid = factoryProviderConfigSchema.parse(config);
  await Setting.upsert({
    userId,
    key: FACTORY_PROVIDER_SETTING_KEY,
    value: JSON.stringify(valid),
    description: "AI Content Factory Provider Manager"
  });
  applyFactoryProviderConfig(valid);
  return valid;
}
