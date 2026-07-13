import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { audioAuditor } from "../src/index.js";

const temporaryDirectories: string[] = [];

function wavBytes(sampleRate: number, durationSeconds: number): Buffer {
  const sampleCount = Math.floor(sampleRate * durationSeconds);
  const dataSize = sampleCount * 2;
  const bytes = Buffer.alloc(44 + dataSize);
  bytes.write("RIFF", 0);
  bytes.writeUInt32LE(36 + dataSize, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const sample = Math.sin((index / sampleRate) * Math.PI * 2 * 440) * 0.5;
    bytes.writeInt16LE(Math.round(sample * 32_767), 44 + index * 2);
  }
  return bytes;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("audioAuditor", () => {
  it("reports decode, energy, peak, clipping, tail, and seam measurements", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "fal-tools-audio-"));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, "tone.wav");
    await writeFile(filePath, wavBytes(16_000, 0.25), { mode: 0o600 });

    const result = await audioAuditor.audit({
      candidate: {
        cacheKey: "cache",
        candidateId: "tone.1",
        contentHash: "digest",
        file: "candidates/tone.wav",
        jobId: "tone",
        kind: "audio",
        sizeBytes: 8_044,
        status: "completed",
        variantId: "1",
      },
      duplicateCandidateIds: [],
      filePath,
      profile: {
        audio: {
          maxClippedSampleRatio: 0,
          maxPeakDbfs: -3,
          minDurationSeconds: 0.2,
        },
      },
    });

    expect(result.isPassed).toBe(true);
    expect(result.checks.durationSeconds).toBeCloseTo(0.25, 2);
    expect(result.checks.clippedSampleRatio).toBe(0);
    expect(result.checks.quarterEnergy).toHaveLength(4);
    expect(result.checks.seamDelta).toBeTypeOf("number");
    expect(result.checks.tailEnergyRatio).toBeTypeOf("number");
  });
});
