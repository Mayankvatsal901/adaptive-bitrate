export interface Metrics {
  startupMs: number | null;
  rebufferCount: number;
  rebufferSeconds: number;
  switchCount: number;
  averageBitrateMbps: number;
  currentQuality: string;
  bandwidthMbps: number;
  bufferSeconds: number;
  abortCount: number;
  upgradeCount: number;
}

interface Props {
  metrics: Metrics;
  onReset: () => void;
}

function Cell({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div
      style={{
        padding: "10px 14px",
        border: "1px solid #333",
        borderRadius: 8,
        minWidth: 130,
        background: "#111",
      }}
    >
      <div style={{ fontSize: 11, opacity: 0.6, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 18, fontWeight: 600, color: warn ? "#ff9800" : "#eee" }}>{value}</div>
    </div>
  );
}

export default function MetricsPanel({ metrics, onReset }: Props) {
  return (
    <div style={{ margin: "12px 0" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong style={{ fontSize: 14 }}>Playback metrics</strong>
        <button
          onClick={onReset}
          style={{
            padding: "4px 10px",
            borderRadius: 6,
            border: "1px solid #444",
            background: "transparent",
            color: "inherit",
            cursor: "pointer",
            fontSize: 12,
          }}
        >
          Reset
        </button>
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <Cell label="Playing" value={metrics.currentQuality} />
        <Cell label="Bandwidth" value={`${metrics.bandwidthMbps.toFixed(2)} Mbps`} />
        <Cell label="Buffer" value={`${metrics.bufferSeconds.toFixed(1)} s`} />
        <Cell
          label="Startup"
          value={metrics.startupMs == null ? "—" : `${(metrics.startupMs / 1000).toFixed(2)} s`}
        />
        <Cell
          label="Rebuffers"
          value={`${metrics.rebufferCount} (${metrics.rebufferSeconds.toFixed(1)} s)`}
          warn={metrics.rebufferCount > 0}
        />
        <Cell label="Avg bitrate" value={`${metrics.averageBitrateMbps.toFixed(2)} Mbps`} />
        <Cell label="Switches" value={String(metrics.switchCount)} />
        <Cell label="Aborts" value={String(metrics.abortCount)} warn={metrics.abortCount > 0} />
        <Cell label="Upgrades" value={String(metrics.upgradeCount)} />
      </div>
    </div>
  );
}