/**
 * @jest-environment node
 *
 * Assisted mode: a shot the provider handed to the user waits in
 * `awaiting_manual_result` with its request saved on it, survives a reload,
 * can be cancelled, and becomes `keyframe_ready` when its image is imported.
 */

jest.mock("../../../lib/websocket/GlobalWebSocketManager", () => ({
  globalWebSocketManager: {
    ensureConnection: jest.fn().mockResolvedValue(undefined),
    subscribe: jest.fn().mockReturnValue(() => {})
  }
}));

import type { ImageRef, ManualResultRequest, Shot } from "@nodetool-ai/protocol";
import { formatManualStepMessage } from "@nodetool-ai/protocol";
import { useStoryboardStore } from "../StoryboardStore";
import { useStoryboardGenerationStore } from "../StoryboardGenerationStore";
import { useNotificationStore } from "../../NotificationStore";

const BOARD = "board-manual";
const SHOT = "shot-manual";

const REQUEST: ManualResultRequest = {
  provider: "chatgpt",
  access_mode: "browser_assisted",
  kind: "keyframe",
  prompt: "Create one image.\n\nA lighthouse at dawn",
  steps: ["NodeTool sent nothing to ChatGPT."],
  open_url: "https://chatgpt.com/",
  requested_at: "2026-11-27T18:00:00.000Z"
};

const still = (n: number): ImageRef => ({
  type: "image",
  uri: `http://example.com/still-${n}.png`,
  asset_id: `img-${n}`
});

const seed = (extra: Partial<Shot> = {}): void => {
  const store = useStoryboardStore.getState();
  store.ensureBoard(BOARD);
  store.upsertShot(BOARD, {
    type: "shot",
    id: SHOT,
    index: 0,
    action: "Pier at dawn",
    status: "planned",
    ...extra
  });
};

const getShot = (): Shot | undefined =>
  useStoryboardStore.getState().getBoard(BOARD)?.shots.find((s) => s.id === SHOT);

beforeEach(() => {
  useNotificationStore.getState().clearNotifications();
});

describe("awaiting_manual_result", () => {
  it("saves the request on the shot", () => {
    seed();
    useStoryboardStore.getState().setShotAwaitingManual(BOARD, SHOT, REQUEST);
    expect(getShot()).toMatchObject({
      status: "awaiting_manual_result",
      manual_request: REQUEST
    });
  });

  it("keeps the request across a reload of the board document", () => {
    seed();
    useStoryboardStore.getState().setShotAwaitingManual(BOARD, SHOT, REQUEST);
    const saved = JSON.parse(JSON.stringify(getShot())) as Shot;

    useStoryboardStore.getState().removeShot(BOARD, SHOT);
    expect(getShot()).toBeUndefined();
    useStoryboardStore.getState().upsertShot(BOARD, saved);

    expect(getShot()?.status).toBe("awaiting_manual_result");
    expect(getShot()?.manual_request).toEqual(REQUEST);
  });

  it("cancel returns the shot to where it was and drops the request", () => {
    seed();
    useStoryboardStore.getState().setShotAwaitingManual(BOARD, SHOT, REQUEST);
    useStoryboardStore.getState().cancelShotManualResult(BOARD, SHOT);
    expect(getShot()?.status).toBe("planned");
    expect(getShot()).not.toHaveProperty("manual_request");

    seed({ keyframe: still(1), keyframe_versions: [still(1)], status: "keyframe_ready" });
    useStoryboardStore.getState().setShotAwaitingManual(BOARD, SHOT, REQUEST);
    useStoryboardStore.getState().cancelShotManualResult(BOARD, SHOT);
    expect(getShot()?.status).toBe("keyframe_ready");
    expect(getShot()?.keyframe).toEqual(still(1));
  });

  it("an imported image becomes the still and the shot keyframe_ready", () => {
    seed();
    useStoryboardStore.getState().setShotAwaitingManual(BOARD, SHOT, REQUEST);
    useStoryboardStore.getState().importShotStill(BOARD, SHOT, still(2));
    expect(getShot()).toMatchObject({
      status: "keyframe_ready",
      keyframe: still(2),
      keyframe_versions: [still(2)]
    });
    expect(getShot()).not.toHaveProperty("manual_request");
  });

  it("a shot waiting with an older still takes the new image as its still", () => {
    seed({ keyframe: still(1), keyframe_versions: [still(1)], status: "keyframe_ready" });
    useStoryboardStore.getState().setShotAwaitingManual(BOARD, SHOT, REQUEST);
    useStoryboardStore.getState().importShotStill(BOARD, SHOT, still(3));
    expect(getShot()).toMatchObject({
      status: "keyframe_ready",
      keyframe: still(3),
      keyframe_versions: [still(1), still(3)]
    });
  });

  it("an ordinary upload keeps the upload rules", () => {
    seed({ keyframe: still(1), keyframe_versions: [still(1)], status: "keyframe_ready" });
    useStoryboardStore.getState().importShotStill(BOARD, SHOT, still(4));
    expect(getShot()?.keyframe).toEqual(still(1));
    expect(getShot()?.keyframe_versions).toEqual([still(1), still(4)]);
  });

  it("a manual-step answer from the generation RPC waits instead of failing", () => {
    seed();
    const message = formatManualStepMessage({
      provider: "chatgpt",
      prompt: REQUEST.prompt,
      steps: REQUEST.steps,
      openUrl: "https://chatgpt.com/"
    });
    useStoryboardGenerationStore
      .getState()
      .recordStartFailure(SHOT, BOARD, "keyframe", `text_to_image failed: ${message}`);

    expect(getShot()?.status).toBe("awaiting_manual_result");
    expect(getShot()?.manual_request).toMatchObject({
      provider: "chatgpt",
      prompt: REQUEST.prompt,
      open_url: "https://chatgpt.com/"
    });
    expect(getShot()).not.toHaveProperty("failure_reason");
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("an ordinary failure still fails and toasts", () => {
    seed();
    useStoryboardGenerationStore
      .getState()
      .recordStartFailure(SHOT, BOARD, "keyframe", "Out of credits");
    expect(getShot()?.status).toBe("failed");
    expect(useNotificationStore.getState().notifications.at(-1)?.content).toContain("Out of credits");
  });
});
