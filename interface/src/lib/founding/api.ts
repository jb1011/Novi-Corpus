import { API_URL } from "@/lib/api/config";
import { clientBudgetMs } from "@/lib/api/budgets";
import { fetchWithTimeout } from "@/lib/api/timeout";
import { throwIfNotOk, request } from "@/lib/api/client";

export type FoundingConfig = {
  open: boolean;
  closesAt: number | null;
  picksAt: number | null;
  spots: number;
};

export type FoundingListItem = {
  id: string;
  createdAt: number;
  email: string;
  xHandle: string | null;
  agentName: string;
  status: FoundingStatus;
  reviewCount: number;
  averageScore: number | null;
};

export type FoundingStatus = "new" | "shortlist" | "winner" | "rejected" | "waitlist";

export type FoundingReview = {
  reviewer: string;
  useCase: number;
  moneyFlow: number;
  builder: number;
  note: string | null;
  updatedAt: number;
};

export type FoundingDetail = FoundingListItem & {
  description: string;
  utm: Record<string, string> | null;
  via: "web" | "mcp";
  reviews: FoundingReview[];
};

export function getFoundingConfig(): Promise<FoundingConfig> {
  return request("/founding/config");
}

export function submitFoundingApplication(body: unknown): Promise<{ id: string }> {
  return request("/founding/applications", { method: "POST", body });
}

export function listFoundingApplications(
  token: string,
  query: { status?: string; sort?: string; dir?: string },
): Promise<{ applications: FoundingListItem[] }> {
  const params = new URLSearchParams();
  if (query.status) params.set("status", query.status);
  if (query.sort) params.set("sort", query.sort);
  if (query.dir) params.set("dir", query.dir);
  const qs = params.toString();
  return request(`/founding/applications${qs ? `?${qs}` : ""}`, { token });
}

export function getFoundingApplication(
  token: string,
  id: string,
): Promise<{ application: FoundingDetail }> {
  return request(`/founding/applications/${encodeURIComponent(id)}`, { token });
}

export function saveFoundingReview(
  token: string,
  id: string,
  body: { useCase: number; moneyFlow: number; builder: number; note?: string },
): Promise<{ review: FoundingReview }> {
  return request(`/founding/applications/${encodeURIComponent(id)}/review`, {
    method: "PUT",
    token,
    body,
  });
}

export function setFoundingStatus(
  token: string,
  id: string,
  status: FoundingStatus,
): Promise<{ id: string; status: FoundingStatus }> {
  return request(`/founding/applications/${encodeURIComponent(id)}`, {
    method: "PATCH",
    token,
    body: { status },
  });
}

export async function downloadFoundingCsv(token: string): Promise<void> {
  const path = "/founding/applications.csv";
  const res = await fetchWithTimeout(
    `${API_URL}${path}`,
    { headers: { authorization: `Bearer ${token}` } },
    clientBudgetMs("GET", path),
  );
  await throwIfNotOk(res);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "founding-applications.csv";
  link.click();
  URL.revokeObjectURL(url);
}
