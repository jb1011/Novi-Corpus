import { request } from "@/lib/api/client";

export type FoundingConfig = {
  open: boolean;
  spots: number;
};

export function getFoundingConfig(): Promise<FoundingConfig> {
  return request("/founding/config");
}

export function submitFoundingApplication(body: unknown): Promise<{ id: string }> {
  return request("/founding/applications", { method: "POST", body });
}
