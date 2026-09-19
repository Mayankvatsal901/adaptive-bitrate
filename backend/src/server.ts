import express from "express";
import * as path from "path";
import * as fs from "fs";

const app = express();

const PORT = 5000;

const hlsPath = path.join(
  process.cwd(),
  "videos",
  "hls"
);

/*
 * ------------------------------------------------
 * CORS
 * ------------------------------------------------
 *
 * Frontend:
 * http://localhost:5173
 *
 * Backend:
 * http://localhost:5000
 *
 * These are different origins, so allow the
 * frontend to request our API and HLS files.
 */
app.use((_req, res, next) => {
  res.header(
    "Access-Control-Allow-Origin",
    "http://localhost:5173"
  );

  res.header(
    "Access-Control-Allow-Methods",
    "GET,OPTIONS"
  );

  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type"
  );

  next();
});

/*
 * ------------------------------------------------
 * HLS STATIC FILES
 * ------------------------------------------------
 *
 * This exposes:
 *
 * /videos/hls/sample/master.m3u8
 *
 * /videos/hls/sample/360p/segment_000.ts
 *
 * etc.
 */
app.use(
  "/videos/hls",
  express.static(hlsPath)
);

/*
 * ------------------------------------------------
 * VIDEO QUALITIES
 * ------------------------------------------------
 *
 * The index MUST match the HLS level index.
 *
 * HLS:
 *
 * level 0 → 360p
 * level 1 → 480p
 * level 2 → 720p
 * level 3 → 1080p
 */
const qualities = [
  {
    index: 0,
    name: "360p",
    directory: "360p",
  },
  {
    index: 1,
    name: "480p",
    directory: "480p",
  },
  {
    index: 2,
    name: "720p",
    directory: "720p",
  },
  {
    index: 3,
    name: "1080p",
    directory: "1080p",
  },
];

/*
 * ------------------------------------------------
 * READ SEGMENT DURATIONS
 * ------------------------------------------------
 *
 * Reads the corresponding playlist.m3u8.
 *
 * Example:
 *
 * #EXTINF:8.000,
 * segment_000.ts
 *
 * We extract:
 *
 * duration = 8 seconds
 */
function getSegmentDurations(
  directoryPath: string
): number[] {
  const playlistPath = path.join(
    directoryPath,
    "playlist.m3u8"
  );

  if (!fs.existsSync(playlistPath)) {
    return [];
  }

  const playlist = fs.readFileSync(
    playlistPath,
    "utf-8"
  );

  const durations: number[] = [];

  const lines = playlist
    .split(/\r?\n/)
    .map((line) => line.trim());

  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      const durationText = line
        .replace("#EXTINF:", "")
        .split(",")[0];

      const duration = Number(
        durationText
      );

      if (!Number.isNaN(duration)) {
        durations.push(duration);
      }
    }
  }

  return durations;
}

/*
 * ------------------------------------------------
 * SEGMENT METADATA API
 * ------------------------------------------------
 *
 * GET:
 *
 * /api/videos/sample/segments
 *
 * Returns:
 *
 * - quality
 * - HLS level index
 * - segment number
 * - actual file size
 * - segment duration
 */
app.get(
  "/api/videos/sample/segments",
  (_req, res) => {
    try {
      const result = qualities.map(
        (quality) => {
          const directoryPath =
            path.join(
              hlsPath,
              "sample",
              quality.directory
            );

          /*
           * Check quality directory.
           */
          if (
            !fs.existsSync(
              directoryPath
            )
          ) {
            return {
              index: quality.index,
              name: quality.name,
              segments: [],
            };
          }

          /*
           * Get all TS files.
           */
          const files = fs
            .readdirSync(directoryPath)
            .filter((file) =>
              /^segment_\d+\.ts$/.test(
                file
              )
            )
            .sort();

          /*
           * Get durations from playlist.
           */
          const durations =
            getSegmentDurations(
              directoryPath
            );

          const segments =
            files.map(
              (file, fileIndex) => {
                const filePath =
                  path.join(
                    directoryPath,
                    file
                  );

                const stats =
                  fs.statSync(filePath);

                /*
                 * Extract actual segment
                 * number from filename.
                 *
                 * segment_009.ts
                 *        ↓
                 *       9
                 */
                const match =
                  file.match(
                    /segment_(\d+)\.ts/
                  );

                const segmentNumber =
                  match
                    ? Number(match[1])
                    : fileIndex;

                return {
                  segment:
                    segmentNumber,

                  sizeBytes:
                    stats.size,

                  duration:
                    durations[
                      fileIndex
                    ] ?? 0,
                };
              }
            );

          return {
            index: quality.index,
            name: quality.name,
            segments,
          };
        }
      );

      res.json({
        video: "sample",
        qualities: result,
      });
    } catch (error) {
      console.error(
        "SEGMENT METADATA ERROR:",
        error
      );

      res.status(500).json({
        error:
          "Failed to generate segment metadata",
      });
    }
  }
);

/*
 * ------------------------------------------------
 * SERVER
 * ------------------------------------------------
 */
app.listen(PORT, () => {
  console.log(
    `Server running on http://localhost:${PORT}`
  );
});