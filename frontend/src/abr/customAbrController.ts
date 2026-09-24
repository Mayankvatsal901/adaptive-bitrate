import Hls from "hls.js";
import type {
  FragBufferedData,
  FragLoadedData,
  FragLoadingData,
  Fragment,
} from "hls.js";
import { BandwidthEstimator } from "./bandwidthEstimator";
import { selectQuality, levelLabel, type ABRLevel } from "./abrEngine";
import { getSegmentInfo } from "./segmentMetadata";

/* While a segment downloads, only this share of the buffer may be spent. */
const ABORT_BUFFER_SAFETY = 0.8;

/* Don't judge a download before this much time / data. */
const MIN_CHECK_SECONDS = 0.6;
const CHECK_INTERVAL_MS = 100;

/*
 * ---------- BUFFER UPGRADE (fast switching) ----------
 *
 * When the network recovers, the video already sitting in the
 * buffer is still low quality. Instead of making the viewer watch
 * it, we can throw it away and download it again at the better
 * quality. dash.js calls this "fast switching".
 *
 * Cost: the discarded segments were downloaded for nothing.
 * So we only do it when the gain is big and we can afford it.
 */
const ENABLE_BUFFER_UPGRADE = true;

/* Never touch the next N seconds of video — it is about to play. */
const UPGRADE_KEEP_SECONDS = 6;

/* Only bother if the new quality is at least this many levels better. */
const UPGRADE_MIN_LEVEL_GAIN = 2;

/* A run must have at least this many bad segments to be worth it. */
const UPGRADE_MIN_SEGMENTS = 2;

/* Don't do it more often than this. */
const UPGRADE_COOLDOWN_MS = 10_000;

/* Use only this share of the available runway for the refetch. */
const UPGRADE_TIME_SAFETY = 0.8;

/* A bigger time gap than this between two segments = a hole in the buffer. */
const MAX_BUFFER_HOLE = 0.5;

/* Never upgrade video nobody is watching. */
const ALLOW_UPGRADE_WHILE_PAUSED = false;

interface Monitored {
  frag: Fragment;
  sn: number;
  level: number;
  totalBytes: number;
}

/*
 * Custom ABR controller for Hls.js.
 *
 * 1. BEFORE a download: pick the highest quality whose real next
 *    segment fits the bandwidth and the buffer.
 * 2. DURING a download: if the network collapses mid-segment, abort
 *    the download and restart it at a lower quality instead of
 *    waiting and stalling.
 */
export class CustomAbrController {
  /* The player reads live numbers from here for the metrics panel. */
  static latest: CustomAbrController | null = null;

  abortCount = 0;
  upgradeCount = 0;

  private hls: Hls;
  private estimator = new BandwidthEstimator();

  private lastDecisionSn = -1;
  private lastLevel = 0;
  private forcedLevel = -1;

  private expectedTimes = new Map<number, number | null>();

  private monitored: Monitored | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  /* What is currently sitting in the buffer, and at which level. */
  private buffered = new Map<
    number,
    { sn: number; level: number; start: number; end: number }
  >();
  private lastUpgradeAt = 0;

  constructor(hls: Hls) {
    this.hls = hls;
    CustomAbrController.latest = this;

    this.onFragLoading = this.onFragLoading.bind(this);
    this.onFragLoaded = this.onFragLoaded.bind(this);
    this.onFragBuffered = this.onFragBuffered.bind(this);
    this.checkProgress = this.checkProgress.bind(this);
    this.stopMonitor = this.stopMonitor.bind(this);

    hls.on(Hls.Events.FRAG_LOADING, this.onFragLoading);
    hls.on(Hls.Events.FRAG_LOADED, this.onFragLoaded);
    hls.on(Hls.Events.FRAG_BUFFERED, this.onFragBuffered);
    hls.on(Hls.Events.ERROR, this.stopMonitor);
  }

  get liveStats() {
    return {
      bandwidthMbps: this.estimator.getEstimate(),
      bufferSeconds: this.getBufferInfo().len,
      level: this.lastLevel,
      abortCount: this.abortCount,
      upgradeCount: this.upgradeCount,
    };
  }

  destroy(): void {
    if (CustomAbrController.latest === this) CustomAbrController.latest = null;
    this.stopMonitor();
    this.hls.off(Hls.Events.FRAG_LOADING, this.onFragLoading);
    this.hls.off(Hls.Events.FRAG_LOADED, this.onFragLoaded);
    this.hls.off(Hls.Events.FRAG_BUFFERED, this.onFragBuffered);
    this.hls.off(Hls.Events.ERROR, this.stopMonitor);
  }

  private get abrLevels(): ABRLevel[] {
    return this.hls.levels.map((l, index) => ({
      index,
      bitrate: l.bitrate,
      width: l.width,
      height: l.height,
    }));
  }

  /* ---------------- MID-DOWNLOAD WATCHDOG ---------------- */

  private onFragLoading(_event: string, data: FragLoadingData): void {
    const frag = data.frag;
    this.stopMonitor();

    if (frag.type !== "main" || typeof frag.sn !== "number") return;

    const info = getSegmentInfo(frag.level, frag.sn);

    this.monitored = {
      frag,
      sn: frag.sn,
      level: frag.level,
      totalBytes: info?.sizeBytes ?? 0,
    };

    this.timer = setInterval(this.checkProgress, CHECK_INTERVAL_MS);
  }

  private stopMonitor(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.monitored = null;
  }

  /*
   * Runs every 100 ms while a segment downloads.
   *
   * Measures the speed of THIS download (not the old estimate) and
   * asks: at this speed, will the rest of the segment arrive before
   * the buffer runs out? If not, abort and drop a level.
   */
  private checkProgress(): void {
    const m = this.monitored;
    if (!m) return;

    const stats = m.frag.stats;

    // Finished or never started.
    if (stats.loading.end > 0) return this.stopMonitor();
    const startedAt = stats.loading.first || stats.loading.start;
    if (!startedAt) return;

    const elapsed = (performance.now() - startedAt) / 1000;
    const loaded = stats.loaded;
    if (loaded <= 0 || elapsed < MIN_CHECK_SECONDS) return;

    const totalBytes = m.totalBytes || stats.total || 0;
    if (!totalBytes || totalBytes <= loaded) return;

    // Real speed of this download, right now.
    const liveMbps = (loaded * 8) / 1_000_000 / elapsed;
    if (liveMbps <= 0) return;

    const remainingMb = ((totalBytes - loaded) * 8) / 1_000_000;
    const remainingTime = remainingMb / liveMbps;

    const buffer = this.getBufferInfo().len;
    const affordable = buffer * ABORT_BUFFER_SAFETY;

    // Still fine: let it finish.
    if (remainingTime <= affordable) return;

    // Find the highest LOWER level we could still download in time.
    let target = -1;
    for (let i = m.level - 1; i >= 0; i--) {
      const info = getSegmentInfo(i, m.sn);
      const sizeMb = info
        ? (info.sizeBytes * 8) / 1_000_000
        : (this.hls.levels[i].bitrate / 1_000_000) * 4;

      const time = sizeMb / liveMbps;
      if (time < remainingTime && time <= affordable) {
        target = i;
        break;
      }
    }

    // Nothing fits: still better to abort down to the lowest level.
    if (target < 0) {
      if (m.level === 0) return;
      target = 0;
    }

    this.abortTo(m, target, liveMbps, loaded, elapsed);
  }

  private abortTo(
    m: Monitored,
    target: number,
    liveMbps: number,
    loaded: number,
    elapsed: number
  ): void {
    const from = this.hls.levels[m.level];
    const to = this.hls.levels[target];

    console.log(
      `%c⛔ ABORT segment ${m.sn}: ${from?.height}p -> ${to?.height}p`,
      "color:#ff9800;font-weight:bold"
    );
    console.log(
      `   network collapsed to ${liveMbps.toFixed(2)} Mbps mid-download,`,
      `buffer ${this.getBufferInfo().len.toFixed(2)} s — restarting lower`
    );

    this.abortCount++;

    // Feed the partial measurement so the next decision uses the real speed.
    this.estimator.update(loaded, elapsed * 1000);

    // Force the retry of this same segment to use the lower level.
    this.lastDecisionSn = m.sn;
    this.lastLevel = target;
    this.expectedTimes.delete(m.sn);

    const frag = m.frag;
    this.stopMonitor();

    frag.abortRequests();

    // Tells Hls.js to go back to IDLE and reload this segment.
    this.hls.trigger(Hls.Events.FRAG_LOAD_EMERGENCY_ABORTED, {
      frag,
      stats: frag.stats,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
  }

  /* ---------------- AFTER DOWNLOAD ---------------- */

  private onFragLoaded(_event: string, data: FragLoadedData): void {
    this.stopMonitor();

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

    const verdict =
      expected != null
        ? actualSec <= expected
          ? "✅ faster than predicted"
          : "⚠️ slower than predicted"
        : "";

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

  /* ---------------- WHAT IS IN THE BUFFER ---------------- */

  private onFragBuffered(_event: string, data: FragBufferedData): void {
    const frag = data.frag;
    if (frag.type !== "main" || typeof frag.sn !== "number") return;

    this.buffered.set(frag.sn, {
      sn: frag.sn,
      level: frag.level,
      start: frag.start,
      end: frag.start + frag.duration,
    });

    // Forget what is well behind the playhead.
    const t = this.hls.media?.currentTime ?? 0;
    for (const [sn, f] of this.buffered) {
      if (f.end < t - 30) this.buffered.delete(sn);
    }
  }

  /* ---------------- BUFFER UPGRADE ---------------- */

  /*
   * The network recovered, so the low-quality segments already in
   * the buffer are now worse than what we could fetch. Throw them
   * away and let Hls.js download them again at the new level.
   *
   * Safety rules:
   *  - keep UPGRADE_KEEP_SECONDS of video ahead of the playhead,
   *    so playback never pauses while we refetch
   *  - only if ONE segment at the new level downloads inside that
   *    kept window
   *  - only if the gain is big, several segments are affected,
   *    and we did not just do it
   */
  /*
   * Find the NEAREST run of bad segments ahead of the viewer and
   * replace just that run. Good segments are never touched: the
   * walk stops as soon as it meets one, and the next run is picked
   * up on a later pass, when the viewer has moved closer to it.
   */
  private maybeUpgradeBuffer(chosenLevel: number): void {
    if (!ENABLE_BUFFER_UPGRADE) return;

    const media = this.hls.media;
    if (!media) return;

    // Nobody watching -> refetching would just burn data.
    if (!ALLOW_UPGRADE_WHILE_PAUSED && (media.paused || document.hidden)) return;

    const now = performance.now();
    if (now - this.lastUpgradeAt < UPGRADE_COOLDOWN_MS) return;

    const playhead = media.currentTime;
    const safeFrom = playhead + UPGRADE_KEEP_SECONDS;

    // Everything still really in the buffer, after the safe window.
    const ahead = [...this.buffered.values()]
      .filter((f) => f.end > safeFrom && this.isStillBuffered(f))
      .sort((a, b) => a.start - b.start);

    if (!ahead.length) return;

    const isBad = (level: number) =>
      level <= chosenLevel - UPGRADE_MIN_LEVEL_GAIN;

    /*
     * Walk forward in playback order:
     *   - a hole in the buffer ends the search
     *   - good segments before the run are skipped
     *   - the first good segment AFTER the run ends the run
     */
    const run: typeof ahead = [];
    let previousEnd = -1;

    for (const f of ahead) {
      if (previousEnd >= 0 && f.start - previousEnd > MAX_BUFFER_HOLE) break;
      previousEnd = f.end;

      if (isBad(f.level)) {
        run.push(f);
      } else if (run.length) {
        break;
      }
    }

    if (run.length < UPGRADE_MIN_SEGMENTS) return;

    const runStart = Math.max(run[0].start, safeFrom);
    const runEnd = run[run.length - 1].end;

    /*
     * Runway = how long until playback reaches the run.
     * The first replacement must arrive before then.
     */
    const runway = (runStart - playhead) * UPGRADE_TIME_SAFETY;

    const info = getSegmentInfo(chosenLevel, run[0].sn);
    const sizeMb = info
      ? (info.sizeBytes * 8) / 1_000_000
      : (this.hls.levels[chosenLevel].bitrate / 1_000_000) * 4;

    const safeBandwidth = this.estimator.getEstimate() * 0.8;
    if (safeBandwidth <= 0) return;

    const refetchTime = sizeMb / safeBandwidth;
    if (refetchTime > runway) return;

    const worst = this.hls.levels[Math.min(...run.map((f) => f.level))];
    const better = this.hls.levels[chosenLevel];

    console.log(
      `%c♻️ UPGRADE BUFFER: ${worst?.height}p -> ${better?.height}p`,
      "color:#9c27b0;font-weight:bold"
    );
    console.log(
      `   segments ${run[0].sn}-${run[run.length - 1].sn}`,
      `(${runStart.toFixed(1)}s - ${runEnd.toFixed(1)}s) |`,
      `runway ${runway.toFixed(1)} s, refetch ${refetchTime.toFixed(2)} s/segment`
    );

    this.lastUpgradeAt = now;
    this.upgradeCount++;
    for (const f of run) this.buffered.delete(f.sn);

    // Drop ONLY that range. Everything else stays.
    this.hls.trigger(Hls.Events.BUFFER_FLUSHING, {
      startOffset: runStart,
      endOffset: runEnd,
      type: null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    this.lastDecisionSn = -1;
  }

  /* The browser can evict buffered video, so always verify. */
  private isStillBuffered(f: { start: number; end: number }): boolean {
    const media = this.hls.media;
    if (!media) return false;

    const middle = (f.start + f.end) / 2;
    const ranges = media.buffered;

    for (let i = 0; i < ranges.length; i++) {
      if (middle >= ranges.start(i) && middle <= ranges.end(i)) return true;
    }
    return false;
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
    this.maybeUpgradeBuffer(level);
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