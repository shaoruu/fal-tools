import type {
  AssetInspector,
  AssetProcessor,
  InspectionResult,
  JsonValue,
  PostStep,
  ProcessRequest,
  QaCheck,
  QaProfile,
} from "@fal-tools/core";

async function loadSharp() {
  try {
    return (await import("sharp")).default;
  } catch {
    throw new Error(
      "image processing requires the optional sharp dependency; install sharp explicitly",
    );
  }
}

function numeric(step: PostStep, key: string): number | undefined {
  const value: JsonValue | undefined = step[key];
  return typeof value === "number" ? value : undefined;
}

function imageFormat(format: string): "jpeg" | "png" | "webp" {
  if (format === "jpg") {
    return "jpeg";
  }
  if (format === "jpeg" || format === "png" || format === "webp") {
    return format;
  }
  throw new Error(`unsupported image output format: ${format}`);
}

export const imageProcessor: AssetProcessor = Object.freeze({
  async process(request: ProcessRequest) {
    const sharp = await loadSharp();
    let operation = sharp(request.input, {
      failOn: "warning",
      limitInputPixels: 100_000_000,
    });

    for (const step of request.post) {
      if (step.type === "stripMetadata") {
        continue;
      }
      if (step.type === "resize") {
        const width = numeric(step, "width");
        const height = numeric(step, "height");
        if (
          (width === undefined && height === undefined) ||
          (width !== undefined &&
            (!Number.isSafeInteger(width) || width < 1)) ||
          (height !== undefined &&
            (!Number.isSafeInteger(height) || height < 1))
        ) {
          throw new Error("resize requires positive integer width or height");
        }
        operation = operation.resize({
          ...(width === undefined ? {} : { width }),
          ...(height === undefined ? {} : { height }),
          fit: "inside",
          withoutEnlargement: true,
        });
        continue;
      }
      throw new Error(`unsupported image post step: ${step.type}`);
    }

    return operation.toFormat(imageFormat(request.format)).toBuffer();
  },
});

function configuredCheck(
  profile: QaProfile,
  key: string,
  measured: number | boolean,
  predicate: (threshold: number | boolean) => boolean,
): QaCheck | undefined {
  const threshold = profile.checks[key];
  if (threshold === undefined) {
    return undefined;
  }
  return {
    id: key,
    measured,
    passed: predicate(threshold),
  };
}

export const imageInspector: AssetInspector = Object.freeze({
  async inspect(
    candidatePath: string,
    profile: QaProfile,
  ): Promise<InspectionResult> {
    const sharp = await loadSharp();
    const image = sharp(candidatePath, {
      failOn: "warning",
      limitInputPixels: 100_000_000,
    });
    const metadata = await image.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const hasAlpha = metadata.hasAlpha ?? false;
    const trimmed = await image
      .clone()
      .trim({ background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer({ resolveWithObject: true });
    const fullArea = width * height;
    const bboxPaddingRatio =
      fullArea === 0
        ? 1
        : 1 - (trimmed.info.width * trimmed.info.height) / fullArea;
    const checks: QaCheck[] = [
      {
        id: "decode",
        measured: metadata.format ?? "invalid",
        passed: width > 0 && height > 0,
      },
    ];

    const configured = [
      configuredCheck(
        profile,
        "minWidth",
        width,
        (threshold) => typeof threshold === "number" && width >= threshold,
      ),
      configuredCheck(
        profile,
        "minHeight",
        height,
        (threshold) => typeof threshold === "number" && height >= threshold,
      ),
      configuredCheck(
        profile,
        "maxWidth",
        width,
        (threshold) => typeof threshold === "number" && width <= threshold,
      ),
      configuredCheck(
        profile,
        "maxHeight",
        height,
        (threshold) => typeof threshold === "number" && height <= threshold,
      ),
      configuredCheck(
        profile,
        "requireAlpha",
        hasAlpha,
        (threshold) =>
          typeof threshold === "boolean" && (!threshold || hasAlpha),
      ),
      configuredCheck(
        profile,
        "maxBboxPaddingRatio",
        bboxPaddingRatio,
        (threshold) =>
          typeof threshold === "number" && bboxPaddingRatio <= threshold,
      ),
    ];
    for (const check of configured) {
      if (check !== undefined) {
        checks.push(check);
      }
    }

    return {
      checks,
      measurements: {
        width,
        height,
        hasAlpha,
        bboxPaddingRatio,
      },
    };
  },
});
