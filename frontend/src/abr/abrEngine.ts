import { getSegmentInfo } from "./segmentMetadata";

export interface ABRLevel {
  index: number;
  bitrate: number;
  width: number;
  height: number;
}

/* One row of the decision table printed in the console. */
export interface LevelCheck {
  quality: string;
  "size (MB)": string;
  "download (s)": string;
  "segment (s)": string;
  "usable buffer (s)": string;
  result: string;
}

export interface ABRDecision {
  level: number;
  reason: string;
  bandwidthMbps: number;
  safeBandwidthMbps: number;
  bufferSeconds: number;
  usableBuffer: number;
  expectedDownloadSec: number | null;
  checks: LevelCheck[];
}

const BANDWIDTH_SAFETY_FACTOR = 0.8;
const BUFFER_SAFETY_FACTOR = 0.8;
const EMERGENCY_BUFFER_SECONDS = 2;
const FALLBACK_SEGMENT_SECONDS = 4;

export const levelLabel = (l: ABRLevel) => `${l.height}p`;

/*
 * A quality is SAFE for the next segment when BOTH are true:
 *
 *  1. SUSTAINABLE: download time <= segment duration
 *     (we download 4 s of video in <= 4 s, so the buffer does not shrink)
 *
 *  2. NO STALL:    download time <= usable buffer
 *     (playback won't run out of video while we wait)
 *
 *  download time = real segment size (Mb) / safe bandwidth (Mbps)
 *
 * We use the REAL segment size instead of the advertised bitrate,
 * which is more accurate (calm scenes are small, action scenes big).
 */
export function selectQuality(
  levels: ABRLevel[],
  bandwidthMbps: number,
  bufferSeconds: number,
  nextSegmentNumber: number
): ABRDecision {
  const safeBandwidthMbps = bandwidthMbps * BANDWIDTH_SAFETY_FACTOR;
  const usableBuffer = bufferSeconds * BUFFER_SAFETY_FACTOR;

  const base = {
    bandwidthMbps,
    safeBandwidthMbps,
    bufferSeconds,
    usableBuffer,
    checks: [] as LevelCheck[],
    expectedDownloadSec: null as number | null,
  };

  if (levels.length === 0) {
    return { ...base, level: -1, reason: "no levels available" };
  }

  if (bufferSeconds <= EMERGENCY_BUFFER_SECONDS) {
    return {
      ...base,
      level: 0,
      reason: `EMERGENCY: buffer ${bufferSeconds.toFixed(2)} s <= ${EMERGENCY_BUFFER_SECONDS} s -> lowest quality`,
    };
  }

  if (bandwidthMbps <= 0) {
    return { ...base, level: 0, reason: "bandwidth unknown (first segment) -> lowest quality" };
  }

  let selected = -1;
  const expectedByLevel: number[] = [];

  for (const level of levels) {
    const segment = getSegmentInfo(level.index, nextSegmentNumber);

    // Last segment can be very short (e.g. 0.41 s): don't let that block everything.
    const duration = Math.max(segment?.duration || FALLBACK_SEGMENT_SECONDS, 1);

    const sizeMegabits = segment
      ? (segment.sizeBytes * 8) / 1_000_000
      : (level.bitrate / 1_000_000) * duration;

    const expected = sizeMegabits / safeBandwidthMbps;
    expectedByLevel[level.index] = expected;

    let result: string;
    if (expected > usableBuffer) result = "❌ would stall (download > buffer)";
    else if (expected > duration) result = "❌ buffer would shrink (download > segment)";
    else {
      result = "✅ safe";
      selected = level.index;
    }

    base.checks.push({
      quality: levelLabel(level),
      "size (MB)": (sizeMegabits / 8).toFixed(2) + (segment ? "" : " (est)"),
      "download (s)": expected.toFixed(2),
      "segment (s)": duration.toFixed(2),
      "usable buffer (s)": usableBuffer.toFixed(2),
      result,
    });
  }

  if (selected < 0) {
    base.checks[0].result = "⚠️ fallback (lowest)";
    return {
      ...base,
      level: 0,
      expectedDownloadSec: expectedByLevel[0],
      reason: "no quality is safe -> lowest quality",
    };
  }

  base.checks[selected].result = "✅ SELECTED";
  return {
    ...base,
    level: selected,
    expectedDownloadSec: expectedByLevel[selected],
    reason: `highest safe quality = ${levelLabel(levels[selected])}`,
  };
}