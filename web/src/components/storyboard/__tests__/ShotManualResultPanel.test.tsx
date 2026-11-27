/**
 * The assisted-mode panel on a shot waiting for a result made by hand: shows
 * the prepared prompt, opens the provider's tab, imports the image by picker
 * or drop, and cancels.
 */
import React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "@mui/material/styles";
import type { ManualResultRequest, Shot } from "@nodetool-ai/protocol";
import mockTheme from "../../../__mocks__/themeMock";

jest.mock("../../../hooks/useResolvedMediaUri");
jest.mock("../../../hooks/assets/useAssetsForLocators");
jest.mock("../../assets/AssetViewer", () => ({
  __esModule: true,
  default: () => <div data-testid="asset-viewer" />
}));

const mockShowProviderTab = jest.fn();
jest.mock("../../../trpc/client", () => ({
  trpc: { scripts: { get: { useQuery: () => ({ data: undefined }) } } },
  trpcClient: {
    extension: { showProviderTab: { mutate: (input: unknown) => mockShowProviderTab(input) } }
  }
}));
jest.mock("../../../serverState/useEntities", () => ({
  useEntities: () => ({ data: [] })
}));

type UploadCall = { file: File; onCompleted?: (asset: { id: string }) => void };
const mockUploadAsset = jest.fn<void, [UploadCall]>();
jest.mock("../../../serverState/useAssetUpload", () => ({
  useAssetUpload: (selector: (state: unknown) => unknown) =>
    selector({ uploadAsset: mockUploadAsset })
}));
jest.mock("../../../hooks/storyboard/useGenerateShot", () => ({
  useGenerateShot: () => ({
    generateKeyframe: jest.fn(async () => undefined),
    generateClip: jest.fn(async () => undefined),
    generateRevisedClip: jest.fn(async () => undefined),
    retryFailedRequest: jest.fn(async () => undefined)
  })
}));

import ShotCard from "../ShotCard";
import { useStoryboardStore } from "../../../stores/storyboard/StoryboardStore";

const BOARD = "board-manual-panel";
const REQUEST: ManualResultRequest = {
  provider: "chatgpt",
  access_mode: "browser_assisted",
  kind: "keyframe",
  prompt: "Create one image.\n\nA lighthouse at dawn",
  steps: [],
  open_url: "https://chatgpt.com/",
  requested_at: "2026-11-27T18:00:00.000Z"
};

const seed = (): Shot => {
  const shot: Shot = {
    type: "shot",
    id: "shot-1",
    index: 0,
    action: "Pier at dawn",
    status: "awaiting_manual_result",
    manual_request: REQUEST
  };
  useStoryboardStore.getState().ensureBoard(BOARD);
  useStoryboardStore.getState().upsertShot(BOARD, shot);
  return shot;
};
const current = (): Shot | undefined =>
  useStoryboardStore.getState().boards[BOARD]?.shots.find((s) => s.id === "shot-1");
const renderCard = (shot: Shot) =>
  render(
    <ThemeProvider theme={mockTheme}>
      <ShotCard boardId={BOARD} shot={shot} onEdit={jest.fn()} />
    </ThemeProvider>
  );
const png = () => new File(["x"], "still.png", { type: "image/png" });

beforeEach(() => {
  mockUploadAsset.mockReset();
  mockShowProviderTab.mockReset();
});
afterEach(() => useStoryboardStore.getState().removeBoard(BOARD));

describe("ShotManualResultPanel", () => {
  it("shows the prepared prompt and no failure", () => {
    renderCard(seed());
    expect(screen.getByTestId("shot-manual-prompt").textContent).toBe(REQUEST.prompt);
    expect(screen.queryByTestId("shot-render-error")).toBeNull();
  });

  it("brings the provider tab forward", async () => {
    mockShowProviderTab.mockResolvedValue({ shown: true, openUrl: "https://chatgpt.com/" });
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    renderCard(seed());
    await userEvent.click(screen.getByRole("button", { name: /chatgpt/i }));
    await waitFor(() => expect(mockShowProviderTab).toHaveBeenCalledWith({ provider: "chatgpt" }));
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("opens the site when no tab can be shown", async () => {
    mockShowProviderTab.mockResolvedValue({ shown: false, openUrl: "https://chatgpt.com/" });
    const open = jest.spyOn(window, "open").mockImplementation(() => null);
    renderCard(seed());
    await userEvent.click(screen.getByRole("button", { name: /chatgpt/i }));
    await waitFor(() =>
      expect(open).toHaveBeenCalledWith("https://chatgpt.com/", "_blank", "noopener,noreferrer")
    );
    open.mockRestore();
  });

  it("a dropped image becomes the still and the shot keyframe_ready", async () => {
    mockUploadAsset.mockImplementation(({ onCompleted }) => onCompleted?.({ id: "img-9" }));
    renderCard(seed());
    fireEvent.drop(screen.getByTestId("shot-manual-result"), {
      dataTransfer: { files: [png()], types: ["Files"] }
    });
    await waitFor(() => expect(current()?.status).toBe("keyframe_ready"));
    expect(current()?.keyframe?.asset_id).toBe("img-9");
    expect(current()).not.toHaveProperty("manual_request");
  });

  it("a picked image is imported too", async () => {
    mockUploadAsset.mockImplementation(({ onCompleted }) => onCompleted?.({ id: "img-7" }));
    const { container } = renderCard(seed());
    const input = container.querySelector<HTMLInputElement>(
      '[data-testid="shot-manual-result"] input[type="file"]'
    );
    expect(input).not.toBeNull();
    await userEvent.upload(input!, png());
    await waitFor(() => expect(current()?.status).toBe("keyframe_ready"));
  });

  it("cancel drops the request", async () => {
    renderCard(seed());
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(current()?.status).toBe("planned");
    expect(current()).not.toHaveProperty("manual_request");
  });
});
