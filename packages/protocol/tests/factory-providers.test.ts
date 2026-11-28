import { describe, expect, it } from "vitest";
import {
  FACTORY_BROWSER_PROVIDERS,
  capabilityGroups,
  factoryBrowserProvider,
  isMediaCapability
} from "../src/index.js";

describe("factory provider catalog", () => {
  it("groups declared capabilities into text, image, video and audio, in order", () => {
    expect(capabilityGroups(["text_to_video", "generate_message", "text_to_image", "image_to_image"])).toEqual([
      "text",
      "image",
      "video"
    ]);
    expect(capabilityGroups(["text_to_music", "automatic_speech_recognition"])).toEqual(["audio"]);
    expect(capabilityGroups(["generate_embedding", "text_to_3d"])).toEqual([]);
  });

  it("treats only text and vectors as non-media", () => {
    for (const capability of ["generate_message", "generate_messages", "generate_embedding", "rerank"]) {
      expect(isMediaCapability(capability), capability).toBe(false);
    }
    for (const capability of ["text_to_image", "image_to_video", "text_to_speech", "text_to_music", "text_to_3d"]) {
      expect(isMediaCapability(capability), capability).toBe(true);
    }
  });

  it("offers only ChatGPT as working, and Muse.ai as planned with no transport", () => {
    expect(FACTORY_BROWSER_PROVIDERS.filter((p) => p.integration === "available").map((p) => p.id)).toEqual(["chatgpt"]);
    expect(factoryBrowserProvider("muse_ai")).toMatchObject({ integration: "planned", transports: [] });
    for (const id of ["gemini_web", "google_flow", "dreamina"]) {
      expect(factoryBrowserProvider(id)).toMatchObject({ integration: "terms_unreviewed", transports: ["extension"] });
    }
  });
});
