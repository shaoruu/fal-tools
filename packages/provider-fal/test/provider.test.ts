import { describe, expect, it } from "vitest";

import { createFalProvider } from "../src/index.js";

describe("fal provider submission safety", () => {
  it("does not let the SDK retry an ambiguous queue submission", async () => {
    let calls = 0;
    const fetcher: typeof fetch = (input, init) => {
      void input;
      void init;
      calls += 1;
      return Promise.resolve(
        new Response(JSON.stringify({ detail: "temporary failure" }), {
          headers: { "content-type": "application/json" },
          status: 503,
        }),
      );
    };
    const provider = createFalProvider({
      capabilities: {
        "fal-ai/example-image": {
          kinds: ["image"],
          outputFormats: ["png"],
        },
      },
      credentials: ["synthetic", "value"].join("-"),
      fetcher,
    });

    await expect(
      provider.generate({
        input: {},
        kind: "image",
        model: "fal-ai/example-image",
        outputFormat: "png",
        prompt: "A synthetic geometric shape",
      }),
    ).rejects.toThrow();
    expect(calls).toBe(1);
  });
});
