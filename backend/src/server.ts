import express from "express";
import * as path from "path";
import * as fs from "fs";

const app = express();
const PORT = 5000;

const hlsPath = path.join(process.cwd(), "videos", "hls");

app.use(express.json());

/*
 * ------------------------------------------------
 * CORS + NO CACHE
 * ------------------------------------------------
 */
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "http://localhost:5173");
  res.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  res.header("Cache-Control", "no-store");

  // Express 5 rejects the "*" route pattern, so answer preflight here.
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }

  next();
});

/*
 * ================================================
 * NETWORK SIMULATION
 * ================================================
 *
 * Instead of DevTools throttling, the SERVER limits how fast it
 * sends segments. The frontend switches profiles with a button,
 * so the demo works for anyone who clones the repo.
 *
 * mbps = 0 means unlimited.
 */
let networkMbps = 0;
let networkLatencyMs = 0;
let networkLabel = "Unlimited";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

app.get("/api/network", (_req, res) => {
  res.json({ mbps: networkMbps, latencyMs: networkLatencyMs, label: networkLabel });
});

app.post("/api/network", (req, res) => {
  const { mbps, latencyMs, label } = req.body ?? {};

  networkMbps = Number(mbps) || 0;
  networkLatencyMs = Number(latencyMs) || 0;
  networkLabel = String(label ?? (networkMbps ? `${networkMbps} Mbps` : "Unlimited"));

  console.log(`NETWORK -> ${networkLabel} (${networkMbps || "unlimited"} Mbps, ${networkLatencyMs} ms)`);
  res.json({ mbps: networkMbps, latencyMs: networkLatencyMs, label: networkLabel });
});

/*
 * Send a file at a limited speed: one slice every 100 ms.
 *
 *   bytes per slice = mbps × 1_000_000 / 8 / 10
 */
async function sendThrottled(res: express.Response, filePath: string): Promise<void> {
  const stats = fs.statSync(filePath);
  const TICK_MS = 100;
  const bytesPerTick = Math.max(2048, Math.floor((networkMbps * 1_000_000) / 8 / (1000 / TICK_MS)));

  res.setHeader("Content-Type", "video/mp2t");
  res.setHeader("Content-Length", stats.size);

  if (networkLatencyMs > 0) await sleep(networkLatencyMs);

  const stream = fs.createReadStream(filePath, { highWaterMark: bytesPerTick });

  let aborted = false;
  res.on("close", () => {
    aborted = true;
    stream.destroy();
  });

  try {
    for await (const chunk of stream) {
      if (aborted) return;

      if (!res.write(chunk)) {
        await new Promise<void>((resolve) => res.once("drain", () => resolve()));
      }
      await sleep(TICK_MS);
    }
    if (!aborted) res.end();
  } catch {
    if (!aborted) res.end();
  }
}

/*
 * Segments go through the throttle; playlists are tiny, so they don't.
 */
app.get(/^\/videos\/hls\/.*\.ts$/, (req, res, next) => {
  if (networkMbps <= 0) return next();

  const filePath = path.join(hlsPath, decodeURIComponent(req.path.replace("/videos/hls/", "")));
  if (!fs.existsSync(filePath)) return res.sendStatus(404);

  void sendThrottled(res, filePath);
});

app.use("/videos/hls", express.static(hlsPath));

/*
 * ================================================
 * VIDEO QUALITIES
 * ================================================
 */
const qualities = [
  { index: 0, name: "144p", directory: "144p" },
  { index: 1, name: "360p", directory: "360p" },
  { index: 2, name: "480p", directory: "480p" },
  { index: 3, name: "720p", directory: "720p" },
  { index: 4, name: "1080p", directory: "1080p" },
];

function getSegmentDurations(directoryPath: string): number[] {
  const playlistPath = path.join(directoryPath, "playlist.m3u8");
  if (!fs.existsSync(playlistPath)) return [];

  const playlist = fs.readFileSync(playlistPath, "utf-8");
  const durations: number[] = [];

  for (const line of playlist.split(/\r?\n/).map((l) => l.trim())) {
    if (line.startsWith("#EXTINF:")) {
      const duration = Number(line.replace("#EXTINF:", "").split(",")[0]);
      if (!Number.isNaN(duration)) durations.push(duration);
    }
  }
  return durations;
}

/*
 * ================================================
 * SEGMENT METADATA API
 * ================================================
 */
app.get("/api/videos/sample/segments", (_req, res) => {
  try {
    const result = qualities.map((quality) => {
      const directoryPath = path.join(hlsPath, "sample", quality.directory);

      if (!fs.existsSync(directoryPath)) {
        console.warn(`MISSING QUALITY DIRECTORY: ${directoryPath}`);
        return { index: quality.index, name: quality.name, segments: [] };
      }

      const files = fs
        .readdirSync(directoryPath)
        .filter((file) => /^segment_\d+\.ts$/.test(file))
        .sort();

      const durations = getSegmentDurations(directoryPath);

      const segments = files.map((file, fileIndex) => {
        const stats = fs.statSync(path.join(directoryPath, file));
        const match = file.match(/segment_(\d+)\.ts/);
        const segmentNumber = match ? Number(match[1]) : fileIndex;

        return {
          segment: segmentNumber,
          sizeBytes: stats.size,
          duration: durations[fileIndex] ?? 0,
        };
      });

      return { index: quality.index, name: quality.name, segments };
    });

    console.log(
      "SEGMENT METADATA:",
      result.map((q) => `${q.name}=${q.segments.length}`).join(" ")
    );

    res.json({ video: "sample", qualities: result });
  } catch (error) {
    console.error("SEGMENT METADATA ERROR:", error);
    res.status(500).json({ error: "Failed to generate segment metadata" });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});