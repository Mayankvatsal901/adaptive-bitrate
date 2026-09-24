import { useCallback, useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { CustomAbrController } from "../abr/customAbrController";
import { loadSegmentMetadata } from "../abr/segmentMetadata";
import { setNetwork, NETWORK_PROFILES, type NetworkProfile } from "../abr/networkApi";
import NetworkControls from "./NetworkControls";
import MetricsPanel, { type Metrics } from "./MetricsPanel";

const STREAM_URL = "http://localhost:5000/videos/hls/sample/master.m3u8";

const EMPTY_METRICS: Metrics = {
  startupMs: null,
  rebufferCount: 0,
  rebufferSeconds: 0,
  switchCount: 0,
  averageBitrateMbps: 0,
  currentQuality: "—",
  bandwidthMbps: 0,
  bufferSeconds: 0,
  abortCount: 0,
  upgradeCount: 0,
};

export default function VideoPlayer() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  const [metrics, setMetrics] = useState<Metrics>(EMPTY_METRICS);
  const [activeProfile, setActiveProfile] = useState("Unlimited");

  /* Counters that must survive re-renders. */
  const startedAt = useRef(performance.now());
  const firstPlay = useRef<number | null>(null);
  const rebufferCount = useRef(0);
  const rebufferSeconds = useRef(0);
  const rebufferStart = useRef<number | null>(null);
  const switchCount = useRef(0);
  const playedSeconds = useRef(0);
  const playedBits = useRef(0);
  const lastSampleTime = useRef(0);

  const reset = useCallback(() => {
    startedAt.current = performance.now();
    firstPlay.current = null;
    rebufferCount.current = 0;
    rebufferSeconds.current = 0;
    rebufferStart.current = null;
    switchCount.current = 0;
    playedSeconds.current = 0;
    playedBits.current = 0;
    const controller = CustomAbrController.latest;
    if (controller) {
      controller.abortCount = 0;
      controller.upgradeCount = 0;
    }
    setMetrics(EMPTY_METRICS);
  }, []);

  const pickProfile = useCallback((profile: NetworkProfile) => {
    setActiveProfile(profile.label);
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!Hls.isSupported()) {
      console.error("HLS.js is not supported");
      return;
    }

    let cancelled = false;

    const start = async () => {
      // Start every session on a known network state.
      const initial = NETWORK_PROFILES.find((p) => p.label === "Unlimited")!;
      await setNetwork(initial).catch(() => undefined);

      try {
        await loadSegmentMetadata();
        console.log("CUSTOM ABR: metadata loaded");
      } catch (error) {
        console.error("CUSTOM ABR: metadata error, using bitrate fallback", error);
      }
      if (cancelled) return;

      const hls = new Hls({
        startLevel: 0,
        testBandwidth: false,
        maxBufferLength: 20,
        maxMaxBufferLength: 30,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        abrController: CustomAbrController as any,
      });

      hlsRef.current = hls;
      hls.attachMedia(video);
      hls.loadSource(STREAM_URL);

      hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
        data.levels.forEach((level, index) => {
          console.log(
            `LEVEL ${index}: ${level.width}x${level.height}`,
            `${(level.bitrate / 1_000_000).toFixed(2)} Mbps`
          );
        });
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const level = hls.levels[data.level];
        if (!level) return;
        switchCount.current += 1;
        console.log("NOW PLAYING:", `${level.width}x${level.height}`);
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) {
          if ((data.details as string) !== "aborted") console.warn("HLS warning:", data.details);
          return;
        }
        console.error("HLS FATAL ERROR:", data.type, data.details);
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            hls.destroy();
        }
      });
    };

    /* ---- quality of experience tracking ---- */

    const onPlaying = () => {
      if (firstPlay.current === null) firstPlay.current = performance.now() - startedAt.current;
      if (rebufferStart.current !== null) {
        rebufferSeconds.current += (performance.now() - rebufferStart.current) / 1000;
        rebufferStart.current = null;
      }
      lastSampleTime.current = video.currentTime;
    };

    const onWaiting = () => {
      // Ignore the very first buffering: that is startup, not a rebuffer.
      if (firstPlay.current === null) return;
      rebufferCount.current += 1;
      rebufferStart.current = performance.now();
    };

    video.addEventListener("playing", onPlaying);
    video.addEventListener("waiting", onWaiting);

    /* Sample every 500 ms: played seconds x bitrate = average bitrate. */
    const sampler = setInterval(() => {
      const hls = hlsRef.current;
      const controller = CustomAbrController.latest;

      if (!video.paused && !video.seeking) {
        const delta = video.currentTime - lastSampleTime.current;
        if (delta > 0 && delta < 2) {
          const level = hls?.levels[hls.currentLevel];
          if (level) {
            playedSeconds.current += delta;
            playedBits.current += delta * level.bitrate;
          }
        }
        lastSampleTime.current = video.currentTime;
      }

      const level = hls?.levels[hls.currentLevel ?? -1];
      const live = controller?.liveStats;

      setMetrics({
        startupMs: firstPlay.current,
        rebufferCount: rebufferCount.current,
        rebufferSeconds:
          rebufferSeconds.current +
          (rebufferStart.current ? (performance.now() - rebufferStart.current) / 1000 : 0),
        switchCount: switchCount.current,
        averageBitrateMbps:
          playedSeconds.current > 0
            ? playedBits.current / playedSeconds.current / 1_000_000
            : 0,
        currentQuality: level ? `${level.height}p` : "—",
        bandwidthMbps: live?.bandwidthMbps ?? 0,
        bufferSeconds: live?.bufferSeconds ?? 0,
        abortCount: live?.abortCount ?? 0,
        upgradeCount: live?.upgradeCount ?? 0,
      });
    }, 500);

    start();

    return () => {
      cancelled = true;
      clearInterval(sampler);
      video.removeEventListener("playing", onPlaying);
      video.removeEventListener("waiting", onWaiting);
      hlsRef.current?.destroy();
      hlsRef.current = null;
    };
  }, []);

  return (
    <div style={{ width: "100%", maxWidth: "1000px", margin: "0 auto" }}>
      <video
        ref={videoRef}
        controls
        playsInline
        autoPlay
        muted
        style={{ width: "100%", display: "block", background: "#000" }}
      />

      <NetworkControls active={activeProfile} onChange={pickProfile} />
      <MetricsPanel metrics={metrics} onReset={reset} />
    </div>
  );
}