import { NETWORK_PROFILES, setNetwork, type NetworkProfile } from "../abr/networkApi";

interface Props {
  active: string;
  onChange: (profile: NetworkProfile) => void;
}

export default function NetworkControls({ active, onChange }: Props) {
  const pick = async (profile: NetworkProfile) => {
    await setNetwork(profile);
    onChange(profile);
  };

  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "12px 0" }}>
      <span style={{ fontSize: 13, opacity: 0.7 }}>Network:</span>
      {NETWORK_PROFILES.map((profile) => {
        const isActive = profile.label === active;
        return (
          <button
            key={profile.label}
            onClick={() => pick(profile)}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: isActive ? "1px solid #2196f3" : "1px solid #444",
              background: isActive ? "#2196f3" : "transparent",
              color: isActive ? "#fff" : "inherit",
              cursor: "pointer",
              fontWeight: isActive ? 600 : 400,
            }}
          >
            {profile.label}
            {profile.mbps > 0 && (
              <span style={{ fontSize: 11, opacity: 0.8 }}> · {profile.mbps} Mbps</span>
            )}
          </button>
        );
      })}
    </div>
  );
}