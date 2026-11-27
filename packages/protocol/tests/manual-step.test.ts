import { describe, expect, it } from "vitest";
import { formatManualStepMessage, parseManualStepMessage } from "../src/index.js";
import { storyboardShot } from "../src/api-schemas/storyboards.js";

const NOW = new Date("2026-11-27T18:00:00Z");

describe("manual step messages", () => {
  const message = formatManualStepMessage({
    provider: "chatgpt",
    prompt: "Create one image.\n\nA lighthouse at dawn\n\nAspect ratio: 3:2.",
    steps: ["NodeTool sent nothing to ChatGPT.", "Paste the prompt below into ChatGPT and generate one image.", "Download it."],
    openUrl: "https://chatgpt.com/"
  });

  it("round-trips the provider, prompt, steps and url", () => {
    expect(message.startsWith("Manual step needed.")).toBe(true);
    const parsed = parseManualStepMessage(message, { kind: "keyframe", model: "chatgpt-image", now: NOW });
    expect(parsed).toEqual({
      provider: "chatgpt",
      model: "chatgpt-image",
      access_mode: "browser_assisted",
      kind: "keyframe",
      prompt: "Create one image.\n\nA lighthouse at dawn\n\nAspect ratio: 3:2.",
      steps: ["NodeTool sent nothing to ChatGPT.", "Paste the prompt below into ChatGPT and generate one image.", "Download it."],
      open_url: "https://chatgpt.com/",
      requested_at: NOW.toISOString()
    });
  });

  it("still reads it behind a prefix a caller added", () => {
    expect(parseManualStepMessage(`text_to_image failed: ${message}`)?.provider).toBe("chatgpt");
  });

  it("leaves ordinary failures alone", () => {
    expect(parseManualStepMessage("provider is down")).toBeNull();
    expect(parseManualStepMessage("Manual step needed. but no marker")).toBeNull();
    expect(parseManualStepMessage(undefined)).toBeNull();
  });

  it("ignores a url that is not https", () => {
    const plain = formatManualStepMessage({ provider: "x", prompt: "p", steps: [], openUrl: "http://evil.example" });
    expect(parseManualStepMessage(plain)?.open_url).toBeUndefined();
  });

  it("validates as part of a saved shot", () => {
    const request = parseManualStepMessage(message, { kind: "keyframe", now: NOW })!;
    const shot = storyboardShot.parse({
      type: "shot",
      id: "s1",
      index: 0,
      action: "Pier at dawn",
      status: "awaiting_manual_result",
      manual_request: request
    });
    expect(shot.manual_request?.prompt).toContain("lighthouse");
    expect(() => storyboardShot.parse({ type: "shot", id: "s1", index: 0, action: "x", status: "awaiting_manual_result", manual_request: { provider: "x" } })).toThrow();
  });
});
