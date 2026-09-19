import { useEffect, useRef } from "react";
import Hls from "hls.js";
import { CustomAbrController } from "../abr/customAbrController";
import { loadSegmentMetadata } from "../abr/segmentMetadata";

const STREAM_URL =
  "http://localhost:5000/videos/hls/sample/master.m3u8";

export default function VideoPlayer() {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (!Hls.isSupported()) {
      console.error("HLS.js is not supported");
      return;
    }

    let hls: Hls | null = null;
    let cancelled = false;

    const start = async () => {
      // Load metadata BEFORE playback so the first decisions use real sizes.
      try {
        await loadSegmentMetadata();
        console.log("CUSTOM ABR: metadata loaded");
      } catch (error) {
        console.error("CUSTOM ABR: metadata error, using bitrate fallback", error);
      }

      if (cancelled) return;

      hls = new Hls({
        startLevel: 0,
        testBandwidth: false,

        // Keep only ~20-30 s ahead (like YouTube does).
        // With 60+ s buffered, a new quality only becomes VISIBLE
        // a minute later, and the buffer never gets under pressure.
        maxBufferLength: 20,
        maxMaxBufferLength: 30,
        // Our ABR is now inside Hls.js itself.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        abrController: CustomAbrController as any,
      });

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

      // Fires when PLAYBACK reaches a new quality (not when it downloads).
      hls.on(Hls.Events.LEVEL_SWITCHED, (_, data) => {
        const level = hls?.levels[data.level];
        if (level) console.log("NOW PLAYING:", `${level.width}x${level.height}`);
      });

      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data.fatal) {
          // Aborted downloads are normal during switches; don't spam the console.
          if ((data.details as string) !== "aborted") {
            console.warn("HLS warning:", data.details);
          }
          return;
        }

        console.error("HLS FATAL ERROR:", data.type, data.details);

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls?.startLoad(); // retry loading
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls?.recoverMediaError(); // try to recover decoding
            break;
          default:
            hls?.destroy();
        }
      });
    };

    start();

    return () => {
      cancelled = true;
      hls?.destroy();
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
        style={{ width: "100%", display: "block" }}
      />
    </div>
  );
}