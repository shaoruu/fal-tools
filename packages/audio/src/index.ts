import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { execa } from "execa";

import type {
  AssetAuditor,
  AssetProcessor,
  CandidateAudit,
  JsonObject,
} from "@fal-tools/core";

type ProbeOutput = {
  format?: { duration?: string };
  streams?: { channels?: number; sample_rate?: string }[];
};

async function probe(filePath: string): Promise<{
  channels: number;
  durationSeconds: number;
  sampleRate: number;
}> {
  const result = await execa("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=sample_rate,channels:format=duration",
    "-of",
    "json",
    filePath,
  ]);
  const parsed = JSON.parse(result.stdout) as ProbeOutput;
  const stream = parsed.streams?.[0];
  const channels = stream?.channels;
  const sampleRate = Number(stream?.sample_rate);
  const durationSeconds = Number(parsed.format?.duration);
  if (
    channels === undefined ||
    !Number.isFinite(sampleRate) ||
    !Number.isFinite(durationSeconds)
  ) {
    throw new Error("ffprobe returned incomplete audio metadata");
  }
  return { channels, durationSeconds, sampleRate };
}

async function decodeMono(filePath: string): Promise<Float32Array> {
  const result = await execa(
    "ffmpeg",
    [
      "-v",
      "error",
      "-i",
      filePath,
      "-map",
      "0:a:0",
      "-ac",
      "1",
      "-f",
      "f32le",
      "pipe:1",
    ],
    { encoding: "buffer" },
  );
  const bytes = Buffer.from(result.stdout);
  const sampleCount = Math.floor(bytes.length / 4);
  const samples = new Float32Array(sampleCount);
  for (let index = 0; index < sampleCount; index += 1) {
    samples[index] = bytes.readFloatLE(index * 4);
  }
  return samples;
}

function rootMeanSquare(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const sample of samples) {
    sum += sample * sample;
  }
  return Math.sqrt(sum / samples.length);
}

function sliceSamples(
  samples: Float32Array,
  startRatio: number,
  endRatio: number,
): Float32Array {
  return samples.slice(
    Math.floor(samples.length * startRatio),
    Math.floor(samples.length * endRatio),
  );
}

export const audioAuditor: AssetAuditor = {
  async audit(context): Promise<CandidateAudit> {
    const metadata = await probe(context.filePath);
    const samples = await decodeMono(context.filePath);
    let peak = 0;
    let clippedSamples = 0;
    for (const sample of samples) {
      const magnitude = Math.abs(sample);
      peak = Math.max(peak, magnitude);
      if (magnitude >= 0.999) {
        clippedSamples += 1;
      }
    }
    const peakDbfs = peak === 0 ? -120 : 20 * Math.log10(peak);
    const clippedSampleRatio =
      samples.length === 0 ? 0 : clippedSamples / samples.length;
    const totalEnergy = rootMeanSquare(samples);
    const tailEnergy = rootMeanSquare(sliceSamples(samples, 0.9, 1));
    const tailEnergyRatio = totalEnergy === 0 ? 0 : tailEnergy / totalEnergy;
    const seamDelta =
      samples.length < 2
        ? 0
        : Math.abs((samples[0] ?? 0) - (samples[samples.length - 1] ?? 0));
    const quarterEnergy = [0, 1, 2, 3].map((quarter) =>
      rootMeanSquare(sliceSamples(samples, quarter / 4, (quarter + 1) / 4)),
    );
    const profile = context.profile.audio ?? {};
    const isPassed =
      (profile.minDurationSeconds === undefined ||
        metadata.durationSeconds >= profile.minDurationSeconds) &&
      (profile.maxPeakDbfs === undefined || peakDbfs <= profile.maxPeakDbfs) &&
      (profile.maxClippedSampleRatio === undefined ||
        clippedSampleRatio <= profile.maxClippedSampleRatio) &&
      (profile.maxTailEnergyRatio === undefined ||
        tailEnergyRatio <= profile.maxTailEnergyRatio) &&
      (profile.maxSeamDelta === undefined || seamDelta <= profile.maxSeamDelta);
    const checks: JsonObject = {
      channels: metadata.channels,
      clippedSampleRatio,
      durationSeconds: metadata.durationSeconds,
      peakDbfs,
      quarterEnergy,
      sampleRate: metadata.sampleRate,
      seamDelta,
      tailEnergyRatio,
    };
    return {
      checks,
      isPassed,
      profile: context.profile,
    };
  },
};

export const audioProcessor: AssetProcessor = {
  async process(context): Promise<Uint8Array> {
    let current = context.bytes;
    for (const step of context.steps) {
      if (step.type !== "audio-convert") {
        throw new Error("audio processor received a non-audio step");
      }
      const temporaryDirectory = await mkdtemp(
        path.join(os.tmpdir(), "fal-tools-audio-"),
      );
      try {
        const inputPath = path.join(temporaryDirectory, "input");
        const format = step.format ?? context.format;
        const outputPath = path.join(temporaryDirectory, `output.${format}`);
        await writeFile(inputPath, current, { mode: 0o600 });
        const argumentsList = ["-v", "error", "-y", "-i", inputPath];
        if (step.sampleRate !== undefined) {
          argumentsList.push("-ar", String(step.sampleRate));
        }
        if (step.channels !== undefined) {
          argumentsList.push("-ac", String(step.channels));
        }
        argumentsList.push(outputPath);
        await execa("ffmpeg", argumentsList);
        current = await readFile(outputPath);
      } finally {
        await rm(temporaryDirectory, { force: true, recursive: true });
      }
    }
    return current;
  },
};
