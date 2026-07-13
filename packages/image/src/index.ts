import { readFile } from "node:fs/promises";

import sharp from "sharp";

import type {
  AssetAuditor,
  AssetProcessor,
  CandidateAudit,
  ImagePostStep,
  JsonObject,
} from "@fal-tools/core";

type SharpPipeline = ReturnType<typeof sharp>;

function alphaBoundingBox(
  pixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
): JsonObject {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const alpha = pixels[(y * width + x) * channels + channels - 1] ?? 0;
      if (alpha > 0) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
  }
  if (maxX < 0 || maxY < 0) {
    return { height: 0, width: 0, x: 0, y: 0 };
  }
  return {
    height: maxY - minY + 1,
    width: maxX - minX + 1,
    x: minX,
    y: minY,
  };
}

export const imageAuditor: AssetAuditor = {
  async audit(context): Promise<CandidateAudit> {
    const bytes = await readFile(context.filePath);
    const image = sharp(bytes, { failOn: "error" });
    const metadata = await image.metadata();
    const decoded = await image
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const isAlphaPresent = metadata.hasAlpha;
    const isDuplicate = context.duplicateCandidateIds.length > 0;
    const profile = context.profile.image ?? {};
    const isPassed =
      (profile.minWidth === undefined || metadata.width >= profile.minWidth) &&
      (profile.minHeight === undefined ||
        metadata.height >= profile.minHeight) &&
      (profile.isAlphaRequired !== true || isAlphaPresent) &&
      (profile.isDuplicateAllowed === true || !isDuplicate);

    return {
      checks: {
        alphaBoundingBox: alphaBoundingBox(
          decoded.data,
          metadata.width,
          metadata.height,
          decoded.info.channels,
        ),
        duplicateCandidateIds: context.duplicateCandidateIds,
        height: metadata.height,
        isAlphaPresent,
        isDuplicate,
        width: metadata.width,
      },
      isPassed,
      profile: context.profile,
    };
  },
};

function applyFormat(
  pipeline: SharpPipeline,
  step: ImagePostStep,
  fallbackFormat: string,
): SharpPipeline {
  const format = step.format ?? fallbackFormat;
  const options = step.quality === undefined ? {} : { quality: step.quality };
  if (format === "jpeg") {
    return pipeline.jpeg(options);
  }
  if (format === "png") {
    return pipeline.png(options);
  }
  if (format === "webp") {
    return pipeline.webp(options);
  }
  if (format === "avif") {
    return pipeline.avif(options);
  }
  throw new Error(`unsupported image conversion format: ${format}`);
}

export const imageProcessor: AssetProcessor = {
  async process(context): Promise<Uint8Array> {
    let current = context.bytes;
    for (const rawStep of context.steps) {
      if (rawStep.type !== "image-convert") {
        throw new Error("image processor received a non-image step");
      }
      let pipeline = sharp(current, { failOn: "error" });
      if (rawStep.background !== undefined) {
        pipeline = pipeline.flatten({ background: rawStep.background });
      }
      current = await applyFormat(pipeline, rawStep, context.format).toBuffer();
    }
    return current;
  },
};
