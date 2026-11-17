import type { PublicConfig } from "@/lib/api/types";

/**
 * Whether this deployment offers the full product, read from `GET /config`.
 *
 * Only an explicit answer decides. `true` is "offered" and `false` is "not_offered"; an absent
 * field (a backend that predates it), a config still loading and a config that could not be read
 * are all "unknown", and a screen treats "unknown" as it did before the field existed.
 */
export type FullProductGate = "offered" | "not_offered" | "unknown";

export function fullProductGate(
  config: Pick<PublicConfig, "fullProductAvailable"> | undefined,
): FullProductGate {
  if (config?.fullProductAvailable === true) return "offered";
  if (config?.fullProductAvailable === false) return "not_offered";
  return "unknown";
}
