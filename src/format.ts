import type { Checkpoint } from "./types";

export function formatAge(timestamp: number): string {
  const deltaSec = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (deltaSec < 60) return `${deltaSec}s ago`;
  const deltaMin = Math.floor(deltaSec / 60);
  if (deltaMin < 60) return `${deltaMin}m ago`;
  const deltaHr = Math.floor(deltaMin / 60);
  if (deltaHr < 24) return `${deltaHr}h ago`;
  const deltaDay = Math.floor(deltaHr / 24);
  return `${deltaDay}d ago`;
}

export function checkpointLine(checkpoint: Checkpoint): string {
  return `${checkpoint.entryId.slice(0, 8)}  ${checkpoint.revision.slice(0, 12)}  ${formatAge(checkpoint.timestamp)}`;
}
