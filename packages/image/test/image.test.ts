import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";

import { imageAuditor } from "../src/index.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("imageAuditor", () => {
  it("reports dimensions, alpha bounds, and duplicate hashes", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "fal-tools-image-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "shape.png");
    const image = await sharp({
      create: {
        background: { alpha: 0, b: 0, g: 0, r: 0 },
        channels: 4,
        height: 6,
        width: 8,
      },
    })
      .composite([
        {
          input: {
            create: {
              background: { alpha: 1, b: 0, g: 0, r: 255 },
              channels: 4,
              height: 2,
              width: 3,
            },
          },
          left: 2,
          top: 1,
        },
      ])
      .png()
      .toBuffer();
    await writeFile(filePath, image, { mode: 0o600 });

    const result = await imageAuditor.audit({
      candidate: {
        cacheKey: "cache",
        candidateId: "shape.1",
        contentHash: "digest",
        file: "candidates/shape.png",
        jobId: "shape",
        kind: "image",
        sizeBytes: image.length,
        status: "completed",
        variantId: "1",
      },
      duplicateCandidateIds: ["shape.2"],
      filePath,
      profile: {
        image: {
          isAlphaRequired: true,
          isDuplicateAllowed: false,
          minHeight: 6,
          minWidth: 8,
        },
      },
    });

    expect(result.isPassed).toBe(false);
    expect(result.checks.width).toBe(8);
    expect(result.checks.height).toBe(6);
    expect(result.checks.isAlphaPresent).toBe(true);
    expect(result.checks.isDuplicate).toBe(true);
    expect(result.checks.alphaBoundingBox).toEqual({
      height: 2,
      width: 3,
      x: 2,
      y: 1,
    });
  });
});
