/*
 * Duration-weighted EWMA bandwidth estimator
 * (the same maths Hls.js uses internally).
 *
 * Why weighted?
 *
 * A simple average treats every sample equally, so one 21-second
 * slow download counts the same as a 0.2-second fast one. That is
 * why the estimate stayed at 50 Mbps even after a download that
 * clearly measured 1.4 Mbps.
 *
 * Here the WEIGHT of a sample is how long the download took, so a
 * long slow download almost completely replaces the old estimate.
 */
class Ewma {
  private readonly alpha: number;
  private estimate = 0;
  private totalWeight = 0;

  constructor(halfLifeSeconds: number) {
    // alpha^halfLife = 0.5
    this.alpha = Math.exp(Math.log(0.5) / halfLifeSeconds);
  }

  sample(weightSeconds: number, value: number): void {
    const adjustedAlpha = Math.pow(this.alpha, weightSeconds);
    this.estimate = value * (1 - adjustedAlpha) + adjustedAlpha * this.estimate;
    this.totalWeight += weightSeconds;
  }

  getEstimate(): number {
    if (this.totalWeight === 0) return 0;
    // Remove the bias of starting from zero.
    const zeroFactor = 1 - Math.pow(this.alpha, this.totalWeight);
    return this.estimate / zeroFactor;
  }

  hasSample(): boolean {
    return this.totalWeight > 0;
  }
}

export class BandwidthEstimator {
  // Fast: reacts within a couple of seconds of download time.
  private fast = new Ewma(2);
  // Slow: stable, prevents jumping up too eagerly.
  private slow = new Ewma(8);

  // Localhost / cache can report ~0 ms downloads (1000+ Mbps).
  private readonly maxSampleMbps = 100;

  /*
   * Feed one measurement. Can also be called with PARTIAL data
   * while a segment is still downloading (see the abort logic).
   */
  update(bytesLoaded: number, downloadTimeMs: number): number {
    if (bytesLoaded <= 0 || downloadTimeMs <= 0) return this.getEstimate();

    const seconds = downloadTimeMs / 1000;
    const sampleMbps = Math.min(
      (bytesLoaded * 8) / seconds / 1_000_000,
      this.maxSampleMbps
    );

    this.fast.sample(seconds, sampleMbps);
    this.slow.sample(seconds, sampleMbps);

    return this.getEstimate();
  }

  getEstimate(): number {
    if (!this.fast.hasSample()) return 0;
    // Lowest of the two = the careful choice.
    return Math.min(this.fast.getEstimate(), this.slow.getEstimate());
  }
}