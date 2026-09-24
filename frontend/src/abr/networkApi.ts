const BASE = "http://localhost:5000/api/network";

export interface NetworkProfile {
  label: string;
  mbps: number;      // 0 = unlimited
  latencyMs: number;
}

/* The profiles shown as buttons. Tune freely. */
export const NETWORK_PROFILES: NetworkProfile[] = [
  { label: "2G", mbps: 0.4, latencyMs: 400 },
  { label: "3G", mbps: 1, latencyMs: 200 },
  { label: "4G", mbps: 4, latencyMs: 60 },
  { label: "5G", mbps: 25, latencyMs: 20 },
  { label: "Unlimited", mbps: 0, latencyMs: 0 },
];

export async function setNetwork(profile: NetworkProfile): Promise<void> {
  await fetch(BASE, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(profile),
  });
  console.log(`%c📶 NETWORK -> ${profile.label}`, "color:#00bcd4;font-weight:bold");
}