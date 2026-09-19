import Hls from "hls.js";
import type { FragLoadedData } from "hls.js";
import { BandwidthEstimator } from "./bandwidthEstimator";
import { selectQuality, levelLabel, type ABRLevel } from "./abrEngine";

/*
 * Custom ABR controller plugged directly into Hls.js.
 * Hls.js reads `nextAutoLevel` right BEFORE each fragment request.
 *
 * Console output per segment:
 *   ▶ SEGMENT N — DECISION   (bandwidth, buffer, table of every quality)
 *   ✔ SEGMENT N DOWNLOADED   (expected vs actual time, new estimate)
 */
export class CustomAbrController {
  private hls: Hls;
  private estimator = new BandwidthEstimator();

  private lastDecisionSn = -1;
  private lastLevel = 0;
  private forcedLevel = -1;

  // sn -> expected download time we predicted
  private expectedTimes = new Map<number, number | null>();

  constructor(hls: Hls) {
    this.hls = hls;
    this.onFragLoaded = this.onFragLoaded.bind(this);
    hls.on(Hls.Events.FRAG_LOADED, this.onFragLoaded);
  }

  destroy(): void {
    this.hls.off(Hls.Events.FRAG_LOADED, this.onFragLoaded);
  }

  private get abrLevels(): ABRLevel[] {
    return this.hls.levels.map((l, index) => ({
      index,
      bitrate: l.bitrate,
      width: l.width,
      height: l.height,
    }));
  }

  /* ---------------- AFTER DOWNLOAD ---------------- */

  private onFragLoaded(_event: string, data: FragLoadedData): void {
    const frag = data.frag;
    if (frag.type !== "main" || typeof frag.sn !== "number") return;

    const stats = frag.stats;
    const actualSec = (stats.loading.end - stats.loading.start) / 1000;
    const sizeMB = stats.loaded / 1_000_000;
    const measuredMbps = actualSec > 0 ? (sizeMB * 8) / actualSec : 0;

    const newEstimate = this.estimator.update(stats.loaded, actualSec * 1000);

    const expected = this.expectedTimes.get(frag.sn);
    this.expectedTimes.delete(frag.sn);

    const quality = this.hls.levels[frag.level];
    const buffer = this.getBufferInfo();

    let verdict = "";
    if (expected != null) {
      verdict = actualSec <= expected ? "✅ faster than predicted" : "⚠️ slower than predicted";
    }

    console.log(
      `%c✔ SEGMENT ${frag.sn} DOWNLOADED @ ${quality ? quality.height + "p" : "?"}`,
      "color:#4caf50;font-weight:bold"
    );
    console.log(
      `   size ${sizeMB.toFixed(2)} MB | took ${actualSec.toFixed(2)} s` +
        (expected != null ? ` (predicted ${expected.toFixed(2)} s) ${verdict}` : "")
    );
    console.log(
      `   measured ${measuredMbps.toFixed(2)} Mbps -> new estimate ${newEstimate.toFixed(2)} Mbps | buffer ${buffer.len.toFixed(2)} s`
    );
  }

  /* ---------------- BUFFER ---------------- */

  private getBufferInfo(): { len: number; end: number } {
    const media = this.hls.media;
    if (!media) return { len: 0, end: 0 };

    const t = media.currentTime;
    const ranges = media.buffered;

    for (let i = 0; i < ranges.length; i++) {
      if (t >= ranges.start(i) - 0.5 && t <= ranges.end(i)) {
        return { len: ranges.end(i) - t, end: ranges.end(i) };
      }
    }
    return { len: 0, end: t };
  }

  private getNextSn(bufferEnd: number): number {
    const fragments =
      this.hls.levels[this.lastLevel]?.details?.fragments ??
      this.hls.levels.find((l) => l.details)?.details?.fragments;

    if (!fragments?.length) return 0;

    const next = fragments.find((f) => bufferEnd < f.start + f.duration - 0.05);
    return typeof next?.sn === "number" ? next.sn : -1;
  }

  /* ---------------- DECISION ---------------- */

  get nextAutoLevel(): number {
    const levels = this.abrLevels;
    if (!levels.length) return 0;

    const buffer = this.getBufferInfo();
    const sn = this.getNextSn(buffer.end);

    // Called many times per segment: decide once per segment.
    if (sn < 0 || sn === this.lastDecisionSn) return this.lastLevel;

    const decision = selectQuality(levels, this.estimator.getEstimate(), buffer.len, sn);

    let level = Math.max(0, decision.level);
    let reason = decision.reason;

    if (this.forcedLevel >= 0 && this.forcedLevel < level) {
      level = this.forcedLevel;
      reason += ` | Hls.js forced down to ${levelLabel(levels[level])} (fragment error)`;
    }
    this.forcedLevel = -1;

    this.lastDecisionSn = sn;
    this.lastLevel = level;
    this.expectedTimes.set(sn, decision.expectedDownloadSec);

    this.printDecision(sn, decision, levels[level], reason);
    return level;
  }

  private printDecision(
    sn: number,
    d: ReturnType<typeof selectQuality>,
    chosen: ABRLevel,
    reason: string
  ): void {
    const playTime = this.hls.media?.currentTime ?? 0;

    console.groupCollapsed(
      `%c▶ SEGMENT ${sn} → ${chosen.height}p   (bw ${d.bandwidthMbps.toFixed(2)} Mbps, buffer ${d.bufferSeconds.toFixed(2)} s)`,
      "color:#2196f3;font-weight:bold"
    );
    console.log(`Video time         : ${playTime.toFixed(2)} s`);
    console.log(
      `Bandwidth estimate : ${d.bandwidthMbps.toFixed(2)} Mbps  × 0.8 = ${d.safeBandwidthMbps.toFixed(2)} Mbps (safe)`
    );
    console.log(
      `Buffer ahead       : ${d.bufferSeconds.toFixed(2)} s  × 0.8 = ${d.usableBuffer.toFixed(2)} s (usable)`
    );
    console.log(`Rule               : download time = size × 8 / safe bandwidth  must be  <= usable buffer`);
    if (d.checks.length) console.table(d.checks);
    console.log(`%cResult: ${chosen.height}p  —  ${reason}`, "font-weight:bold");
    console.groupEnd();
  }

  /*
   * Hls.js writes back to this setter on every load tick
   * (it "echoes" the level we just returned). Old code treated that
   * echo as a forced switch -> it locked us to the previous level.
   *
   * Now: ignore echoes. Only accept a real DOWN-switch
   * (Hls.js does this after a fragment error).
   */
  set nextAutoLevel(level: number) {
    if (level < 0 || level >= this.lastLevel) return;
    this.forcedLevel = level;
    this.lastDecisionSn = -1;
  }

  get firstAutoLevel(): number {
    return 0;
  }

  get forcedAutoLevel(): number {
    return -1;
  }

  resetEstimator(): void {}
}