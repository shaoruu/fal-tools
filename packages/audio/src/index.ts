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
import { execa } from "execa";
import { z } from "zod";

const sampleRate = 8_000;
const maxBuffer = 100 * 1024 * 1024;

function numeric(step: PostStep, key: string): number | undefined {
  const value: JsonValue | undefined = step[key];
  return typeof value === "number" ? value : undefined;
}

function outputArguments(format: string): readonly string[] {
  const formats: Readonly<Record<string, readonly string[]>> = {
    flac: ["-f", "flac"],
    mp3: ["-f", "mp3"],
    ogg: ["-f", "ogg"],
    wav: ["-f", "wav"],
  };
  const selected = formats[format];
  if (selected === undefined) {
    throw new Error(`unsupported audio output format: ${format}`);
  }
  return selected;
}

async function runFfmpeg(
  arguments_: readonly string[],
  input?: Uint8Array,
): Promise<Uint8Array> {
  try {
    const result = await execa("ffmpeg", arguments_, {
      encoding: "buffer",
      maxBuffer,
      reject: true,
      timeout: 60_000,
      ...(input === undefined ? {} : { input }),
    });
    return new Uint8Array(result.stdout);
  } catch {
    throw new Error(
      "ffmpeg failed or was not found on PATH; install a system ffmpeg executable",
    );
  }
}

export const audioProcessor: AssetProcessor = Object.freeze({
  async process(request: ProcessRequest) {
    const arguments_: string[] = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-map_metadata",
      "-1",
    ];
    for (const step of request.post) {
      if (step.type === "trim") {
        const startSeconds = numeric(step, "startSeconds") ?? 0;
        const durationSeconds = numeric(step, "durationSeconds");
        if (
          startSeconds < 0 ||
          (durationSeconds !== undefined && durationSeconds <= 0)
        ) {
          throw new Error("trim values must be positive");
        }
        arguments_.push("-ss", String(startSeconds));
        if (durationSeconds !== undefined) {
          arguments_.push("-t", String(durationSeconds));
        }
        continue;
      }
      if (step.type === "normalize") {
        const peakDb = numeric(step, "peakDb") ?? -1;
        if (peakDb > 0 || peakDb < -12) {
          throw new Error("normalize peakDb must be between -12 and 0");
        }
        arguments_.push("-af", `loudnorm=I=-16:TP=${peakDb}:LRA=11`);
        continue;
      }
      throw new Error(`unsupported audio post step: ${step.type}`);
    }
    arguments_.push(...outputArguments(request.format), "pipe:1");
    return runFfmpeg(arguments_, request.input);
  },
});

const probeSchema = z.strictObject({
  format: z.strictObject({
    duration: z.string(),
  }),
});

async function probeDuration(candidatePath: string): Promise<number> {
  try {
    const result = await execa(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        candidatePath,
      ],
      { timeout: 30_000 },
    );
    const parsed = probeSchema.parse(JSON.parse(result.stdout));
    return Number(parsed.format.duration);
  } catch {
    throw new Error(
      "ffprobe failed or was not found on PATH; install a system ffmpeg distribution",
    );
  }
}

function rms(samples: readonly number[]): number {
  if (samples.length === 0) {
    return 0;
  }
  return Math.sqrt(
    samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length,
  );
}

function configuredCheck(
  profile: QaProfile,
  key: string,
  measured: number,
  predicate: (threshold: number) => boolean,
): QaCheck | undefined {
  const threshold = profile.checks[key];
  if (typeof threshold !== "number") {
    return undefined;
  }
  return { id: key, measured, passed: predicate(threshold) };
}

export const audioInspector: AssetInspector = Object.freeze({
  async inspect(
    candidatePath: string,
    profile: QaProfile,
  ): Promise<InspectionResult> {
    const durationSeconds = await probeDuration(candidatePath);
    const decoded = await runFfmpeg([
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      candidatePath,
      "-ac",
      "1",
      "-ar",
      String(sampleRate),
      "-f",
      "f32le",
      "pipe:1",
    ]);
    const view = new DataView(
      decoded.buffer,
      decoded.byteOffset,
      decoded.byteLength,
    );
    const samples: number[] = [];
    for (let offset = 0; offset + 4 <= view.byteLength; offset += 4) {
      const sample = view.getFloat32(offset, true);
      if (Number.isFinite(sample)) {
        samples.push(sample);
      }
    }
    const peak = samples.reduce(
      (maximum, sample) => Math.max(maximum, Math.abs(sample)),
      0,
    );
    const peakDb = peak === 0 ? -120 : 20 * Math.log10(peak);
    const clippingRatio =
      samples.filter((sample) => Math.abs(sample) >= 0.999).length /
      Math.max(samples.length, 1);
    const totalEnergy = rms(samples);
    const tailStart = Math.floor(samples.length * 0.95);
    const tailEnergyRatio =
      totalEnergy === 0 ? 0 : rms(samples.slice(tailStart)) / totalEnergy;
    const seamDelta =
      samples.length < 2
        ? 0
        : Math.abs((samples[0] ?? 0) - (samples.at(-1) ?? 0));
    const quarterSize = Math.max(1, Math.floor(samples.length / 4));
    const quarterEnergies = [0, 1, 2, 3].map((quarter) =>
      rms(
        samples.slice(
          quarter * quarterSize,
          quarter === 3 ? samples.length : (quarter + 1) * quarterSize,
        ),
      ),
    );
    const maximumQuarter = Math.max(...quarterEnergies);
    const quarterEnergyRatio =
      maximumQuarter === 0 ? 1 : Math.min(...quarterEnergies) / maximumQuarter;
    const checks: QaCheck[] = [
      {
        id: "decode",
        measured: samples.length,
        passed: samples.length > 0 && Number.isFinite(durationSeconds),
      },
    ];
    const configured = [
      configuredCheck(
        profile,
        "minDurationSeconds",
        durationSeconds,
        (threshold) => durationSeconds >= threshold,
      ),
      configuredCheck(
        profile,
        "maxDurationSeconds",
        durationSeconds,
        (threshold) => durationSeconds <= threshold,
      ),
      configuredCheck(
        profile,
        "maxPeakDb",
        peakDb,
        (threshold) => peakDb <= threshold,
      ),
      configuredCheck(
        profile,
        "maxClippingRatio",
        clippingRatio,
        (threshold) => clippingRatio <= threshold,
      ),
      configuredCheck(
        profile,
        "maxTailEnergyRatio",
        tailEnergyRatio,
        (threshold) => tailEnergyRatio <= threshold,
      ),
      configuredCheck(
        profile,
        "maxSeamDelta",
        seamDelta,
        (threshold) => seamDelta <= threshold,
      ),
      configuredCheck(
        profile,
        "minQuarterEnergyRatio",
        quarterEnergyRatio,
        (threshold) => quarterEnergyRatio >= threshold,
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
        durationSeconds,
        peakDb,
        clippingRatio,
        tailEnergyRatio,
        seamDelta,
        quarterEnergyRatio,
      },
    };
  },
});
