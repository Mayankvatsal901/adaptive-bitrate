/*
 * Dual EMA bandwidth estimator (same idea Hls.js uses).
 *
 * fast EMA reacts quickly, slow EMA is stable.
 * We return the MINIMUM of both:
 *   - network drops  -> fast EMA falls quickly -> we react quickly
 *   - network rises  -> slow EMA rises slowly  -> we upgrade carefully
 */
export class BandwidthEstimator {
  private fast: number | null = null;
  private slow: number | null = null;

  private readonly fastAlpha = 0.5;
  private readonly slowAlpha = 0.15;

  // Ignore tiny downloads: request latency dominates them.
  private readonly minBytes = 16_000;

  // Localhost / browser cache can give ~0 ms downloads (1000+ Mbps).
  // Cap each sample so one fake sample can't explode the estimate.
  private readonly maxSampleMbps = 100;

  update(bytesLoaded: number, downloadTimeMs: number): number {
    if (bytesLoaded < this.minBytes || downloadTimeMs <= 0) {
      return this.getEstimate();
    }

    const sampleMbps = Math.min(
      (bytesLoaded * 8) / (downloadTimeMs / 1000) / 1_000_000,
      this.maxSampleMbps
    );

    this.fast =
      this.fast === null
        ? sampleMbps
        : this.fastAlpha * sampleMbps + (1 - this.fastAlpha) * this.fast;

    this.slow =
      this.slow === null
        ? sampleMbps
        : this.slowAlpha * sampleMbps + (1 - this.slowAlpha) * this.slow;

    return this.getEstimate();
  }

  getEstimate(): number {
    if (this.fast === null || this.slow === null) return 0;
    return Math.min(this.fast, this.slow);
  }
}