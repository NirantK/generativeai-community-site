import { describe, expect, it, vi } from "vitest";
import { enrichPerson, parseEnrichment } from "../src/crustdata";

const profile = [{
  matched_on: "https://www.linkedin.com/in/asha-kumar/",
  match_type: "professional_network_profile_url",
  matches: [{
    confidence_score: 1,
    person_data: {
      basic_profile: { name: "Asha Kumar", current_title: "Research Scientist", location: { raw: "Bengaluru" } },
      experience: { employment_details: { current: [{ name: "Example AI", title: "Research Scientist" }] } },
      education: { schools: [{ school: "Example University", degree: "PhD" }] },
    },
  }],
}];

describe("Crustdata deterministic enrichment", () => {
  it("keeps only a single high-confidence exact LinkedIn match", () => {
    expect(parseEnrichment(profile, "linkedin", "https://linkedin.com/in/asha-kumar", "Asha Kumar"))
      .toEqual({ name: "Asha Kumar", title: "Research Scientist", location: "Bengaluru", company: "Example AI", school: "Example University", degree: "PhD" });
    expect(parseEnrichment(profile, "linkedin", "https://linkedin.com/in/someone-else", "Asha Kumar")).toBeNull();
    expect(parseEnrichment(profile, "linkedin", "https://linkedin.com/in/asha-kumar", "Another Person")).toBeNull();
    expect(parseEnrichment([{ ...profile[0], matches: [{ ...profile[0].matches[0], confidence_score: 0.5 }] }], "linkedin", "https://linkedin.com/in/asha-kumar", "Asha Kumar")).toBeNull();
    expect(parseEnrichment([{ ...profile[0], matches: [profile[0].matches[0], profile[0].matches[0]] }], "linkedin", "https://linkedin.com/in/asha-kumar", "Asha Kumar")).toBeNull();
  });
  it("requires an exact name match for business email", () => {
    const email = [{ ...profile[0], matched_on: "asha@example.com", match_type: "business_email" }];
    expect(parseEnrichment(email, "email", "ASHA@example.com", "Asha Kumar")?.name).toBe("Asha Kumar");
    expect(parseEnrichment(email, "email", "asha@example.com", "Another Person")).toBeNull();
  });
  it("sends one identifier to the current versioned API", async () => {
    const request = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify(profile), { status: 200 }));
    try {
      await enrichPerson("test-key", "linkedin", "https://www.linkedin.com/in/asha-kumar/", "Asha Kumar");
      expect(request).toHaveBeenCalledOnce();
      const [url, init] = request.mock.calls[0];
      expect(url).toBe("https://api.crustdata.com/person/enrich");
      expect(new Headers(init?.headers).get("x-api-version")).toBe("2025-11-01");
      expect(JSON.parse(String(init?.body))).toEqual({ professional_network_profile_urls: ["https://www.linkedin.com/in/asha-kumar/"], fields: ["basic_profile", "experience", "education"] });
    } finally { request.mockRestore(); }
  });
});
