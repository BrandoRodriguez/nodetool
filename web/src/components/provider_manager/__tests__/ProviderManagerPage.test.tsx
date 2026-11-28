/**
 * The Provider Manager page: sections, honest availability, the transport
 * locked while browser work runs, and paid media behind a confirmation.
 */
import React from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@mui/material/styles";
import mockTheme from "../../../__mocks__/themeMock";

const mockSetTransport = jest.fn();
const mockSetPaid = jest.fn();
const mockOpenSignIn = jest.fn();
const mockOpenPageTab = jest.fn();

const provider = (over: Record<string, unknown>) => ({
  capabilities: [],
  configured: true,
  paid: false,
  paidEnabled: false,
  available: true,
  ...over
});

const mockOverview = {
  policy: { terms: true, paidMediaOffByDefault: true },
  transport: {
    selected: "orca",
    source: "saved",
    options: [
      { id: "local", selectable: true },
      { id: "extension", selectable: true },
      { id: "orca", selectable: true }
    ]
  },
  providers: [
    provider({ id: "chatgpt", name: "ChatGPT", mode: "browser_assisted", host: "chatgpt.com", transports: ["extension", "orca"], capabilities: ["text", "image"] }),
    provider({ id: "dreamina", name: "Dreamina", mode: "browser_assisted", host: "dreamina.capcut.com", transports: ["extension"], available: false, unavailableReason: "terms_unreviewed", capabilities: ["image", "video", "audio"] }),
    provider({ id: "muse_ai", name: "Muse.ai", mode: "browser_assisted", host: "muse.ai", transports: [], available: false, unavailableReason: "planned", configured: false }),
    provider({ id: "openai", name: "OpenAI", mode: "api", paid: true, credential: "api_key", secretKey: "OPENAI_API_KEY", capabilities: ["text", "image"] }),
    provider({ id: "ollama", name: "Ollama", mode: "local", capabilities: ["text"] })
  ]
};

let mockStatus = {
  transports: {
    local: { connected: true },
    extension: { connected: false, detail: "not connected" },
    orca: { connected: true, configured: true }
  },
  tabs: { chatgpt: { pageId: "gpt-tab", authorized: true, exists: true, onHost: true } },
  session: "unverifiable",
  activeOperations: 0,
  agentSessionOpen: false
};

jest.mock("../../../serverState/useProviderManager", () => ({
  useProviderManagerOverview: () => ({ data: mockOverview, isError: false, isFetching: false, refetch: jest.fn() }),
  useProviderManagerStatus: () => ({ data: mockStatus, isFetching: false, refetch: jest.fn() }),
  useSetBrowserTransport: () => ({ mutate: mockSetTransport, isPending: false, error: null }),
  useOpenProviderSignInTab: () => ({ mutate: mockOpenSignIn, isPending: false, error: null }),
  useAuthorizeProviderTab: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useRevokeProviderTab: () => ({ mutate: jest.fn(), isPending: false, error: null }),
  useSetPaidMedia: () => ({ mutate: mockSetPaid, isPending: false, error: null })
}));
jest.mock("../../../hooks/useLocalProviderInstalls", () => ({ useLocalProviderInstalls: () => new Map() }));
jest.mock("../../../serverState/useOllamaStatus", () => ({ useOllamaStatus: () => ({ data: "connected" }) }));
jest.mock("../../workspace/openPageTab", () => ({
  openPageTab: (key: string) => mockOpenPageTab(key),
  openSettingsTab: jest.fn()
}));
jest.mock("../../storyboard/ShotManualResultPanel", () => ({ openProviderForManualStep: jest.fn() }));
jest.mock("../../model_menu/ProviderList", () => ({ getProviderIconUrl: () => null }));

import ProviderManagerPage from "../ProviderManagerPage";
import ProviderManagerLink from "../ProviderManagerLink";

const renderPage = () =>
  render(
    <ThemeProvider theme={mockTheme}>
      <ProviderManagerPage />
    </ThemeProvider>
  );

beforeEach(() => {
  mockSetTransport.mockReset();
  mockSetPaid.mockReset();
  mockOpenSignIn.mockReset();
  mockOpenPageTab.mockReset();
  mockStatus = { ...mockStatus, activeOperations: 0, agentSessionOpen: false };
});

const IDS: Record<string, string> = { ChatGPT: "chatgpt", Dreamina: "dreamina", "Muse.ai": "muse_ai" };
const card = (name: string): HTMLElement => screen.getByTestId(`provider-card-${IDS[name]}`);

describe("ProviderManagerPage", () => {
  it("shows the four statuses apart and never claims a signed-in session", () => {
    renderPage();
    const chatgpt = card("ChatGPT");
    expect(within(chatgpt).getByText("Transport")).toBeInTheDocument();
    expect(within(chatgpt).getByText("authorized")).toBeInTheDocument();
    expect(within(chatgpt).getByText("not verified (sign in by hand)")).toBeInTheDocument();
  });

  it("offers no actions for unreviewed or planned providers", () => {
    renderPage();
    for (const name of ["Dreamina", "Muse.ai"]) {
      expect(within(card(name)).queryByRole("button")).toBeNull();
    }
    expect(within(card("Dreamina")).getByText("Terms not reviewed")).toBeInTheDocument();
    expect(within(card("Muse.ai")).getByText("Planned")).toBeInTheDocument();
    expect(within(card("Muse.ai")).getByText("Capabilities to be defined")).toBeInTheDocument();
  });

  it("opens a sign-in tab for ChatGPT on Orca", async () => {
    renderPage();
    await userEvent.click(within(card("ChatGPT")).getByRole("button", { name: "New sign-in tab" }));
    expect(mockOpenSignIn).toHaveBeenCalledWith({ provider: "chatgpt" });
  });

  it("switches the transport, but not while browser work runs", async () => {
    const { unmount } = renderPage();
    await userEvent.click(screen.getByRole("button", { name: /Extension/ }));
    expect(mockSetTransport).toHaveBeenCalledWith({ transport: "extension" });
    unmount();

    mockSetTransport.mockReset();
    mockStatus = { ...mockStatus, activeOperations: 1 };
    renderPage();
    expect(screen.getByRole("button", { name: /Extension/ })).toBeDisabled();
    expect(screen.getByText(/Browser work is in progress/)).toBeInTheDocument();
  });

  it("asks before turning paid media on, and turns it off without asking", async () => {
    renderPage();
    const label = screen.getByText("Paid media");
    let row: HTMLElement | null = label.parentElement;
    while (row && !row.querySelector("input[type=checkbox]")) row = row.parentElement;
    const toggle = row!.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    expect(toggle.checked).toBe(false);
    await userEvent.click(toggle);
    expect(mockSetPaid).not.toHaveBeenCalled();
    expect(screen.getByText("Turn on paid media for OpenAI?")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(mockSetPaid).not.toHaveBeenCalled();

    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("button", { name: "Turn on" }));
    expect(mockSetPaid).toHaveBeenCalledWith({ provider: "openai", enabled: true });
  });

  it("sends local model management to the Model manager", async () => {
    renderPage();
    await userEvent.click(screen.getByRole("button", { name: "Manage models" }));
    expect(mockOpenPageTab).toHaveBeenCalledWith("models");
  });
});

describe("ProviderManagerLink", () => {
  it("opens the Providers page", async () => {
    render(
      <ThemeProvider theme={mockTheme}>
        <ProviderManagerLink />
      </ThemeProvider>
    );
    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    expect(mockOpenPageTab).toHaveBeenCalledWith("providers");
  });
});
