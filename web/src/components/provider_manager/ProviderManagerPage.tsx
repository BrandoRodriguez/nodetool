/**
 * Provider Manager (AI Content Factory): the transport, the browser
 * providers and their authorized tabs, the official APIs and the local
 * engines, in one page.
 *
 * Statuses are kept apart on purpose: transport connected, provider
 * configured, tab authorized, and a browser session's sign-in, which is never
 * claimed because checking it would mean reading the signed-in page.
 */
import React, { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { CapabilityGroup } from "@nodetool-ai/protocol";
import {
  AlertBanner,
  AutoGrid,
  Box,
  Caption,
  Card,
  Chip,
  ConfirmDialog,
  EditorButton,
  EmptyState,
  FlexColumn,
  FlexRow,
  LabeledSwitch,
  PageHeader,
  RefreshButton,
  SearchInput,
  SectionHeader,
  StatusDot,
  Text,
  TextInput,
  ToggleGroup,
  ToggleOption,
  Tooltip,
  BORDER_RADIUS,
  SPACING
} from "../ui_primitives";
import { getSpacingPx } from "../ui_primitives";
import { getProviderIconUrl } from "../model_menu/ProviderList";
import {
  useAuthorizeProviderTab,
  useOpenProviderSignInTab,
  useProviderManagerOverview,
  useProviderManagerStatus,
  useRevokeProviderTab,
  useSetBrowserTransport,
  useSetPaidMedia,
  type ManagedProviderRow,
  type ProviderManagerStatus
} from "../../serverState/useProviderManager";
import { useLocalProviderInstalls } from "../../hooks/useLocalProviderInstalls";
import { useOllamaStatus } from "../../serverState/useOllamaStatus";
import { openPageTab, openSettingsTab } from "../workspace/openPageTab";
import { openProviderForManualStep } from "../storyboard/ShotManualResultPanel";

type Transport = "local" | "extension" | "orca";
type Tone = "success" | "warning" | "error" | "neutral" | "info";

const K = "providerManager";

const errorText = (error: unknown): string | null =>
  error instanceof Error ? error.message : error ? String(error) : null;

/** One labelled status: a dot and a short word. */
const StatusLine = memo(function StatusLine({ label, value, tone }: { label: string; value: string; tone: Tone }) {
  return (
    <FlexRow gap={SPACING.xs} align="center" sx={{ minWidth: 0 }}>
      <StatusDot tone={tone} size="small" />
      <Caption size="smaller" color="secondary">
        {label}
      </Caption>
      <Caption size="smaller" sx={{ whiteSpace: "nowrap" }}>
        {value}
      </Caption>
    </FlexRow>
  );
});

const ProviderIcon = memo(function ProviderIcon({ id, name }: { id: string; name: string }) {
  const url = getProviderIconUrl(id === "chatgpt" ? "openai" : id === "gemini_web" ? "gemini" : id);
  return (
    <Box
      aria-hidden
      sx={(theme) => ({
        width: 28,
        height: 28,
        flexShrink: 0,
        borderRadius: BORDER_RADIUS.sm,
        display: "grid",
        placeItems: "center",
        backgroundColor: theme.vars.palette.action.hover
      })}
    >
      {url ? (
        <img src={url} alt="" width={18} height={18} style={{ display: "block" }} />
      ) : (
        <Text size="small" weight={600}>
          {name.slice(0, 1)}
        </Text>
      )}
    </Box>
  );
});

const CapabilityChips = memo(function CapabilityChips({
  capabilities,
  planned = false
}: {
  capabilities: CapabilityGroup[];
  planned?: boolean;
}) {
  const { t } = useTranslation();
  if (capabilities.length === 0) {
    return (
      <Caption size="smaller" color="secondary">
        {t(planned ? `${K}.capability.tbd` : `${K}.capability.other`)}
      </Caption>
    );
  }
  return (
    <FlexRow gap={SPACING.micro} wrap>
      {capabilities.map((capability) => (
        <Chip key={capability} compact size="small" variant="outlined" label={t(`${K}.capability.${capability}`)} />
      ))}
    </FlexRow>
  );
});

// ── Transport ────────────────────────────────────────────────────────────────

const TransportCard = memo(function TransportCard({
  selected,
  source,
  options,
  status
}: {
  selected: string;
  source: "saved" | "environment" | "default";
  options: Array<{ id: Transport; selectable: boolean; reason?: string }>;
  status: ProviderManagerStatus | undefined;
}) {
  const { t } = useTranslation();
  const setTransport = useSetBrowserTransport();
  const busy = Boolean(status && (status.activeOperations > 0 || status.agentSessionOpen));
  const connected = (id: Transport): boolean | undefined => status?.transports[id].connected;
  const handleChange = useCallback(
    (_event: React.MouseEvent<HTMLElement>, value: Transport | null) => {
      if (value && value !== selected) setTransport.mutate({ transport: value });
    },
    [selected, setTransport]
  );
  const detail = status && (selected === "extension" || selected === "orca") ? status.transports[selected].detail : undefined;
  return (
    <Card variant="outlined" padding="normal">
      <FlexColumn gap={SPACING.sm}>
        <FlexRow justify="space-between" align="center" wrap gap={SPACING.sm}>
          <FlexColumn gap={SPACING.micro} sx={{ minWidth: 0 }}>
            <Text weight={600}>{t(`${K}.transport.title`)}</Text>
            <Caption size="smaller" color="secondary">
              {t(`${K}.transport.source.${source}`)}
            </Caption>
          </FlexColumn>
          <ToggleGroup
            exclusive
            compact
            size="small"
            value={selected}
            onChange={handleChange}
            aria-label={t(`${K}.transport.title`)}
          >
            {options.map((option) => {
              const live = connected(option.id);
              const disabled = !option.selectable || busy || setTransport.isPending;
              const label = (
                <FlexRow gap={SPACING.xs} align="center">
                  <StatusDot tone={live === undefined ? "neutral" : live ? "success" : "error"} size="small" />
                  {t(`${K}.transport.option.${option.id}`)}
                </FlexRow>
              );
              return (
                <ToggleOption key={option.id} value={option.id} disabled={disabled}>
                  {option.reason ? (
                    <Tooltip title={t(`${K}.transport.reason.${option.reason}`)}>
                      <span>{label}</span>
                    </Tooltip>
                  ) : (
                    label
                  )}
                </ToggleOption>
              );
            })}
          </ToggleGroup>
        </FlexRow>
        <Caption size="smaller" color="secondary">
          {t(`${K}.transport.help.${selected === "orca" ? "orca" : selected === "extension" ? "extension" : "local"}`)}
        </Caption>
        {busy && (
          <AlertBanner severity="info" compact>
            {t(`${K}.transport.busy`, { count: status?.activeOperations ?? 0 })}
          </AlertBanner>
        )}
        {detail && (
          <AlertBanner severity="warning" compact>
            {detail}
          </AlertBanner>
        )}
        {setTransport.error && (
          <AlertBanner severity="error" compact>
            {errorText(setTransport.error)}
          </AlertBanner>
        )}
      </FlexColumn>
    </Card>
  );
});

// ── Browser providers ────────────────────────────────────────────────────────

const BrowserProviderCard = memo(function BrowserProviderCard({
  provider,
  transport,
  status
}: {
  provider: ManagedProviderRow;
  transport: string;
  status: ProviderManagerStatus | undefined;
}) {
  const { t } = useTranslation();
  const openSignIn = useOpenProviderSignInTab();
  const authorize = useAuthorizeProviderTab();
  const revoke = useRevokeProviderTab();
  const [pageId, setPageId] = useState("");
  const onOrca = transport === "orca";
  const providerTransport = onOrca ? "orca" : "extension";
  const transportConnected = status?.transports[providerTransport].connected;
  const tab = status?.tabs[provider.id];
  const usesOrcaTabs = onOrca && (provider.transports ?? []).includes("orca");
  const planned = provider.unavailableReason === "planned";

  const tabState: { value: string; tone: Tone } = !onOrca
    ? { value: t(`${K}.status.tabByExtension`), tone: transportConnected ? "info" : "neutral" }
    : !tab
      ? { value: t(`${K}.status.tabNone`), tone: "neutral" }
      : tab.exists && tab.onHost
        ? { value: t(`${K}.status.tabReady`), tone: "success" }
        : { value: t(`${K}.status.tabMissing`), tone: "error" };

  const busy = openSignIn.isPending || authorize.isPending || revoke.isPending;
  const error = errorText(openSignIn.error ?? authorize.error ?? revoke.error);

  return (
    <Card
      variant="outlined"
      padding="normal"
      data-testid={`provider-card-${provider.id}`}
      sx={{ opacity: provider.available ? 1 : 0.72, height: "100%" }}
    >
      <FlexColumn gap={SPACING.sm} sx={{ height: "100%" }}>
        <FlexRow gap={SPACING.sm} align="center" sx={{ minWidth: 0 }}>
          <ProviderIcon id={provider.id} name={provider.name} />
          <FlexColumn sx={{ minWidth: 0, flex: 1 }}>
            <Text weight={600} truncate>
              {provider.name}
            </Text>
            <Caption size="smaller" color="secondary" sx={{ overflow: "hidden", textOverflow: "ellipsis" }}>
              {provider.host}
            </Caption>
          </FlexColumn>
          <Chip
            compact
            size="small"
            color={provider.available ? "success" : planned ? "default" : "warning"}
            label={
              provider.available
                ? t(`${K}.mode.${provider.mode}`)
                : t(`${K}.reason.${provider.unavailableReason ?? "planned"}`)
            }
          />
        </FlexRow>
        <CapabilityChips capabilities={provider.capabilities} planned={planned} />
        {provider.available && (
          <FlexColumn gap={SPACING.micro}>
            <StatusLine
              label={t(`${K}.status.transport`)}
              value={
                transportConnected === undefined
                  ? "…"
                  : transportConnected
                    ? t(`${K}.status.connected`)
                    : t(`${K}.status.disconnected`)
              }
              tone={transportConnected === undefined ? "neutral" : transportConnected ? "success" : "error"}
            />
            <StatusLine
              label={t(`${K}.status.configured`)}
              value={provider.configured ? t(`${K}.status.yes`) : t(`${K}.status.no`)}
              tone={provider.configured ? "success" : "neutral"}
            />
            <StatusLine label={t(`${K}.status.tab`)} value={tabState.value} tone={tabState.tone} />
            <StatusLine label={t(`${K}.status.session`)} value={t(`${K}.status.unverifiable`)} tone="neutral" />
          </FlexColumn>
        )}
        {provider.unavailableReason && (
          <Caption size="smaller" color="secondary">
            {t(`${K}.reasonHelp.${provider.unavailableReason}`)}
          </Caption>
        )}
        {tab?.detail && onOrca && !(tab.exists && tab.onHost) && (
          <Caption size="smaller" color="warning">
            {tab.detail}
          </Caption>
        )}
        <Box sx={{ flex: 1 }} />
        {provider.available && usesOrcaTabs && (
          <FlexColumn gap={SPACING.xs}>
            <FlexRow gap={SPACING.xs} wrap>
              <EditorButton
                variant="outlined"
                disabled={busy}
                onClick={() => openSignIn.mutate({ provider: provider.id })}
              >
                {tab ? t(`${K}.actions.newSignInTab`) : t(`${K}.actions.openSignInTab`)}
              </EditorButton>
              {tab && (
                <>
                  <EditorButton
                    variant="text"
                    disabled={busy}
                    onClick={() =>
                      void openProviderForManualStep({
                        provider: provider.id,
                        access_mode: "browser_assisted",
                        kind: "keyframe",
                        prompt: "",
                        steps: [],
                        open_url: `https://${provider.host}/`,
                        requested_at: new Date().toISOString()
                      })
                    }
                  >
                    {t(`${K}.actions.showTab`)}
                  </EditorButton>
                  <EditorButton variant="text" disabled={busy} onClick={() => revoke.mutate({ provider: provider.id })}>
                    {t(`${K}.actions.revoke`)}
                  </EditorButton>
                </>
              )}
            </FlexRow>
            <FlexRow gap={SPACING.xs} align="center">
              <TextInput
                compact
                size="small"
                value={pageId}
                onChange={(event) => setPageId(event.target.value.trim())}
                placeholder={t(`${K}.actions.pageIdPlaceholder`)}
                inputProps={{ "aria-label": t(`${K}.actions.pageIdPlaceholder`) }}
                sx={{ flex: 1, minWidth: 0 }}
              />
              <EditorButton
                variant="outlined"
                disabled={busy || pageId.length === 0}
                onClick={() => authorize.mutate({ provider: provider.id, pageId }, { onSuccess: () => setPageId("") })}
              >
                {t(`${K}.actions.authorize`)}
              </EditorButton>
            </FlexRow>
          </FlexColumn>
        )}
        {error && (
          <AlertBanner severity="error" compact>
            {error}
          </AlertBanner>
        )}
      </FlexColumn>
    </Card>
  );
});

// ── Official APIs ────────────────────────────────────────────────────────────

const ApiProviderRow = memo(function ApiProviderRow({
  provider,
  onRequestEnable
}: {
  provider: ManagedProviderRow;
  onRequestEnable: (provider: ManagedProviderRow) => void;
}) {
  const { t } = useTranslation();
  const setPaid = useSetPaidMedia();
  const mediaCapable = provider.capabilities.some((capability) => capability !== "text");
  return (
    <FlexRow
      gap={SPACING.sm}
      align="center"
      wrap
      sx={(theme) => ({
        py: SPACING.sm,
        borderBottom: `1px solid ${theme.vars.palette.divider}`,
        "&:last-of-type": { borderBottom: "none" }
      })}
    >
      <FlexRow gap={SPACING.sm} align="center" sx={{ flex: "1 1 220px", minWidth: 0 }}>
        <ProviderIcon id={provider.id} name={provider.name} />
        <FlexColumn sx={{ minWidth: 0 }}>
          <Text size="small" weight={600} truncate>
            {provider.name}
          </Text>
          <FlexRow gap={SPACING.xs} align="center">
            <StatusDot tone={provider.configured ? "success" : "neutral"} size="small" />
            <Caption size="smaller" color="secondary">
              {provider.credential === "account"
                ? t(`${K}.api.account`)
                : provider.configured
                  ? t(`${K}.api.keySaved`)
                  : t(`${K}.api.noKey`)}
            </Caption>
          </FlexRow>
        </FlexColumn>
      </FlexRow>
      <Box sx={{ flex: "1 1 180px", minWidth: 0 }}>
        <CapabilityChips capabilities={provider.capabilities} />
      </Box>
      <FlexRow gap={SPACING.sm} align="center" sx={{ flex: "0 0 auto" }}>
        {!provider.configured && (
          <EditorButton variant="text" onClick={() => openSettingsTab("providers")}>
            {provider.credential === "account" ? t(`${K}.api.manageAccount`) : t(`${K}.api.addKey`)}
          </EditorButton>
        )}
        {mediaCapable && (
          <LabeledSwitch
            size="small"
            label={t(`${K}.api.paidMedia`)}
            checked={provider.paidEnabled}
            disabled={setPaid.isPending}
            onChange={(checked) =>
              checked ? onRequestEnable(provider) : setPaid.mutate({ provider: provider.id, enabled: false })
            }
          />
        )}
      </FlexRow>
    </FlexRow>
  );
});

// ── Local engines ────────────────────────────────────────────────────────────

const LocalProviderRow = memo(function LocalProviderRow({
  provider,
  installStatus,
  ollama
}: {
  provider: ManagedProviderRow;
  installStatus?: "installed" | "missing" | "installing";
  ollama?: "connected" | "unreachable" | "unavailable";
}) {
  const { t } = useTranslation();
  const service: { value: string; tone: Tone } =
    provider.id === "ollama" && ollama
      ? { value: t(`${K}.local.ollama.${ollama}`), tone: ollama === "connected" ? "success" : "neutral" }
      : installStatus
        ? { value: t(`${K}.local.install.${installStatus}`), tone: installStatus === "installed" ? "success" : "neutral" }
        : provider.configured
          ? { value: t(`${K}.local.configured`), tone: "success" }
          : { value: t(`${K}.local.notConfigured`), tone: "neutral" };
  return (
    <FlexRow
      gap={SPACING.sm}
      align="center"
      wrap
      sx={(theme) => ({
        py: SPACING.sm,
        borderBottom: `1px solid ${theme.vars.palette.divider}`,
        "&:last-of-type": { borderBottom: "none" }
      })}
    >
      <FlexRow gap={SPACING.sm} align="center" sx={{ flex: "1 1 220px", minWidth: 0 }}>
        <ProviderIcon id={provider.id} name={provider.name} />
        <FlexColumn sx={{ minWidth: 0 }}>
          <Text size="small" weight={600} truncate>
            {provider.name}
          </Text>
          <FlexRow gap={SPACING.xs} align="center">
            <StatusDot tone={service.tone} size="small" />
            <Caption size="smaller" color="secondary">
              {service.value}
            </Caption>
          </FlexRow>
        </FlexColumn>
      </FlexRow>
      <Box sx={{ flex: "1 1 180px", minWidth: 0 }}>
        <CapabilityChips capabilities={provider.capabilities} />
      </Box>
    </FlexRow>
  );
});

// ── Page ─────────────────────────────────────────────────────────────────────

const ProviderManagerPage: React.FC = () => {
  const { t } = useTranslation();
  const overview = useProviderManagerOverview();
  const status = useProviderManagerStatus();
  const setPaid = useSetPaidMedia();
  const installs = useLocalProviderInstalls();
  const ollama = useOllamaStatus();
  const [query, setQuery] = useState("");
  const [configuredOnly, setConfiguredOnly] = useState(false);
  const [confirmPaid, setConfirmPaid] = useState<ManagedProviderRow | null>(null);

  const providers = overview.data?.providers ?? [];
  const browser = providers.filter((p) => p.mode === "browser_assisted" || p.mode === "browser_automated");
  const local = providers.filter((p) => p.mode === "local");
  const api = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return providers
      .filter((p) => p.mode === "api")
      .filter((p) => !configuredOnly || p.configured)
      .filter((p) => !needle || p.name.toLowerCase().includes(needle) || p.id.includes(needle));
  }, [providers, query, configuredOnly]);
  const paidOn = providers.filter((p) => p.paidEnabled).length;

  const refresh = useCallback(() => {
    void overview.refetch();
    void status.refetch();
  }, [overview, status]);

  if (overview.isError) {
    return (
      <Box sx={{ p: SPACING.xl }}>
        <EmptyState variant="error" title={t(`${K}.loadFailed`)} description={errorText(overview.error) ?? undefined} />
      </Box>
    );
  }

  return (
    <Box
      sx={{
        maxWidth: 1180,
        mx: "auto",
        width: "100%",
        px: { xs: SPACING.md, sm: SPACING.xl },
        py: SPACING.xl,
        display: "flex",
        flexDirection: "column",
        gap: getSpacingPx(SPACING.xl)
      }}
    >
      <PageHeader
        variant="plain"
        title={t(`${K}.title`)}
        subtitle={t(`${K}.subtitle`)}
        actions={
          <RefreshButton
            tooltip={t(`${K}.refresh`)}
            isLoading={overview.isFetching || status.isFetching}
            onClick={refresh}
          />
        }
      />

      <FlexRow gap={SPACING.xs} wrap>
        <Chip
          compact
          size="small"
          color={overview.data?.policy.terms ? "success" : "warning"}
          label={overview.data?.policy.terms ? t(`${K}.policy.termsOn`) : t(`${K}.policy.termsOff`)}
        />
        <Chip
          compact
          size="small"
          color={paidOn === 0 ? "success" : "warning"}
          label={paidOn === 0 ? t(`${K}.policy.paidOff`) : t(`${K}.policy.paidOn`, { count: paidOn })}
        />
      </FlexRow>

      {overview.data && (
        <TransportCard
          selected={overview.data.transport.selected}
          source={overview.data.transport.source}
          options={overview.data.transport.options}
          status={status.data}
        />
      )}

      <FlexColumn gap={SPACING.sm} component="section" aria-labelledby="pm-browser">
        <SectionHeader title={t(`${K}.sections.browser`)} subtitle={t(`${K}.sections.browserHelp`)} count={browser.length} />
        <AutoGrid minItemWidth={280} gap={SPACING.md}>
          {browser.map((provider) => (
            <BrowserProviderCard
              key={provider.id}
              provider={provider}
              transport={overview.data?.transport.selected ?? "local"}
              status={status.data}
            />
          ))}
        </AutoGrid>
      </FlexColumn>

      <FlexColumn gap={SPACING.sm} component="section">
        <SectionHeader
          title={t(`${K}.sections.api`)}
          subtitle={t(`${K}.sections.apiHelp`)}
          count={api.length}
          action={
            <FlexRow gap={SPACING.sm} align="center" wrap>
              <LabeledSwitch
                size="small"
                label={t(`${K}.api.configuredOnly`)}
                checked={configuredOnly}
                onChange={setConfiguredOnly}
              />
              <SearchInput
                size="small"
                value={query}
                onChange={setQuery}
                placeholder={t(`${K}.api.search`)}
                ariaLabel={t(`${K}.api.search`)}
              />
            </FlexRow>
          }
        />
        <Card variant="outlined" padding="compact">
          {api.length === 0 ? (
            <EmptyState variant="no-results" size="small" title={t(`${K}.api.empty`)} />
          ) : (
            api.map((provider) => (
              <ApiProviderRow key={provider.id} provider={provider} onRequestEnable={setConfirmPaid} />
            ))
          )}
        </Card>
      </FlexColumn>

      <FlexColumn gap={SPACING.sm} component="section">
        <SectionHeader
          title={t(`${K}.sections.local`)}
          subtitle={t(`${K}.sections.localHelp`)}
          count={local.length}
          action={
            <EditorButton variant="outlined" onClick={() => openPageTab("models")}>
              {t(`${K}.local.manage`)}
            </EditorButton>
          }
        />
        <Card variant="outlined" padding="compact">
          {local.map((provider) => (
            <LocalProviderRow
              key={provider.id}
              provider={provider}
              installStatus={installs.get(provider.id)?.status}
              ollama={provider.id === "ollama" ? ollama.data : undefined}
            />
          ))}
        </Card>
      </FlexColumn>

      <ConfirmDialog
        open={confirmPaid !== null}
        onClose={() => setConfirmPaid(null)}
        onConfirm={() => {
          if (confirmPaid) setPaid.mutate({ provider: confirmPaid.id, enabled: true });
          setConfirmPaid(null);
        }}
        title={t(`${K}.api.confirmTitle`, { provider: confirmPaid?.name ?? "" })}
        content={t(`${K}.api.confirmBody`)}
        confirmText={t(`${K}.api.confirm`)}
        cancelText={t(`${K}.api.cancel`)}
      />
    </Box>
  );
};

export default memo(ProviderManagerPage);
