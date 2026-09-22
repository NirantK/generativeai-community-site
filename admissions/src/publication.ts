import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Application, Assessment } from "./domain";

type Paper = NonNullable<Assessment["paper"]>;
const MCP_URL = "https://search.parallel.ai/mcp";

function normalized(value: string): string {
  return value.normalize("NFKD").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function officialUrl(value: string, venue: Paper["venue"]): string | null {
  try {
    const url = new URL(value.replace(/[),.;]+$/, ""));
    if (url.protocol !== "https:") return null;
    if (venue === "ACL" && url.hostname === "aclanthology.org" &&
        /^\/\d{4}\.acl-(long|short)\.\d+\/?$/.test(url.pathname)) return url.href;
    if (venue === "NeurIPS" && url.hostname === "proceedings.neurips.cc" &&
        /^\/(?:paper_files\/)?paper\/\d{4}\/hash\/[^/]+-Abstract(?:-Conference)?\.html$/.test(url.pathname)) return url.href;
    if (venue === "ICML" && url.hostname === "proceedings.mlr.press" &&
        /^\/v\d+\/[^/]+\.html$/.test(url.pathname)) return url.href;
  } catch { /* Invalid search result URL. */ }
  return null;
}

export function matchesOfficialPaper(
  paper: Paper,
  applicantName: string,
  url: string,
  page: string,
): boolean {
  if (!officialUrl(url, paper.venue)) return false;
  const text = normalized(page);
  if (!text.includes(normalized(paper.title)) || !text.includes(normalized(applicantName))) return false;
  if (paper.venue === "ACL") return new URL(url).pathname.startsWith(`/${paper.year}.acl-`);
  if (paper.venue === "NeurIPS") {
    return new URL(url).pathname.includes(`/paper/${paper.year}/`) &&
      text.includes("advances in neural information processing systems");
  }
  return /proceedings of the \d+(?:st|nd|rd|th) international conference on machine learning/.test(text) &&
    text.includes(String(paper.year));
}

function toolText(result: unknown): string {
  if (!result || typeof result !== "object" || !("content" in result)) throw new Error("No Parallel MCP content");
  const value = result as { content: unknown; isError?: boolean };
  if (value.isError || !Array.isArray(value.content)) throw new Error("Parallel MCP tool failed");
  return value.content.filter((item): item is { type: "text"; text: string } =>
    item?.type === "text" && typeof item.text === "string").map((item) => item.text).join("\n");
}

export async function verifyMainTrackPaper(
  paper: Paper,
  applicantName: string,
  application: Application,
): Promise<string | null> {
  const claim = normalized(Object.values(application).join(" "));
  if (!claim.includes(normalized(paper.title)) || !claim.includes(normalized(paper.venue)) || !claim.includes(String(paper.year))) return null;
  const client = new Client({ name: "genaicommunity-admissions", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_URL));
  try {
    await client.connect(transport, { timeout: 10000 });
    const search = toolText(await client.callTool({
      name: "web_search",
      arguments: {
        objective: `Find the official ${paper.venue} ${paper.year} main-track proceedings record for a paper titled ${paper.title} by ${applicantName}.`,
        search_queries: [
          `${paper.title} ${applicantName} ${paper.venue}`,
          `${paper.title} ${paper.venue} ${paper.year} proceedings`,
        ],
        session_id: crypto.randomUUID(),
      },
    }, undefined, { timeout: 15000 }));
    const candidates = [...new Set(
      (search.match(/https:\/\/[^\s\]<>"']+/g) ?? [])
        .map((value) => officialUrl(value, paper.venue))
        .filter((value): value is string => !!value),
    )].slice(0, 3);
    for (const url of candidates) {
      const page = toolText(await client.callTool({
        name: "web_fetch",
        arguments: { urls: [url], objective: "Check paper title, authors, year, and main conference proceedings." },
      }, undefined, { timeout: 15000 }));
      if (matchesOfficialPaper(paper, applicantName, url, page)) return url;
    }
    return null;
  } finally {
    await client.close();
  }
}
