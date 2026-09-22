import type { EnrichedPerson } from "./domain";

const ENDPOINT = "https://api.crustdata.com/person/enrich";
type Source = "email" | "linkedin";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function value(value: unknown, max = 200): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
}
function normalizeUrl(input: string): string | null {
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" || !["linkedin.com", "www.linkedin.com"].includes(url.hostname)) return null;
    return url.pathname.replace(/\/$/, "").toLowerCase();
  } catch { return null; }
}
function sameIdentifier(actual: unknown, expected: string, source: Source): boolean {
  if (typeof actual !== "string") return false;
  return source === "email"
    ? actual.trim().toLowerCase() === expected.trim().toLowerCase()
    : !!normalizeUrl(actual) && normalizeUrl(actual) === normalizeUrl(expected);
}
function sameName(actual: string, expected: string): boolean {
  const normalize = (name: string) => name.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return normalize(actual) === normalize(expected);
}

export function parseEnrichment(
  payload: unknown,
  source: Source,
  identifier: string,
  applicantName: string,
): EnrichedPerson | null {
  if (!Array.isArray(payload) || payload.length !== 1) return null;
  const item = record(payload[0]);
  if (!item || !sameIdentifier(item.matched_on, identifier, source) ||
      item.match_type !== (source === "email" ? "business_email" : "professional_network_profile_url")) return null;
  const matches = Array.isArray(item.matches) ? item.matches : [];
  if (matches.length !== 1) return null;
  const match = record(matches[0]);
  if (!match || typeof match.confidence_score !== "number" || match.confidence_score < 0.9) return null;
  const person = record(match.person_data);
  const basic = record(person?.basic_profile);
  const name = value(basic?.name);
  if (!name || !sameName(name, applicantName)) return null;
  const experience = record(person?.experience);
  const employment = record(experience?.employment_details);
  const current = Array.isArray(employment?.current) ? record(employment.current[0]) : null;
  const education = record(person?.education);
  const school = Array.isArray(education?.schools) ? record(education.schools[0]) : null;
  const rawLocation = basic?.location;
  return {
    name,
    title: value(basic?.current_title) ?? value(current?.title),
    location: value(rawLocation) ?? value(record(rawLocation)?.raw),
    company: value(current?.name),
    school: value(school?.school),
    degree: value(school?.degree),
  };
}

export async function enrichPerson(
  apiKey: string,
  source: Source,
  identifier: string,
  applicantName: string,
): Promise<EnrichedPerson | null> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "x-api-version": "2025-11-01",
    },
    body: JSON.stringify({
      [source === "email" ? "business_emails" : "professional_network_profile_urls"]: [identifier],
      fields: ["basic_profile", "experience", "education"],
    }),
    signal: AbortSignal.timeout(35000),
  });
  if (!response.ok) throw new Error(`Crustdata lookup failed: ${response.status}`);
  if (Number(response.headers.get("content-length") ?? 0) > 131072) throw new Error("Crustdata response too large");
  if (!response.body) throw new Error("Empty Crustdata response");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    size += chunk.byteLength;
    if (size > 131072) { await reader.cancel(); throw new Error("Crustdata response too large"); }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return parseEnrichment(JSON.parse(new TextDecoder().decode(bytes)), source, identifier, applicantName);
}
