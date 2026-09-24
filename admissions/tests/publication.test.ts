import { describe, expect, it } from "vitest";
import { matchesOfficialPaper } from "../src/publication";

describe("official main-track publication verification", () => {
  const author = "Asha Kumar";
  it("accepts a matching ICML proceedings page", () => {
    expect(matchesOfficialPaper(
      { title: "Robust Language Models for Science", venue: "ICML", year: 2025 },
      author,
      "https://proceedings.mlr.press/v267/kumar25a.html",
      "Robust Language Models for Science — Asha Kumar. Proceedings of the 42nd International Conference on Machine Learning, 2025.",
    )).toBe(true);
  });
  it("accepts matching ACL and NeurIPS main-track records", () => {
    expect(matchesOfficialPaper(
      { title: "Robust Language Models for Science", venue: "ACL", year: 2025 },
      author,
      "https://aclanthology.org/2025.acl-long.123/",
      "Robust Language Models for Science — Asha Kumar",
    )).toBe(true);
    expect(matchesOfficialPaper(
      { title: "Robust Language Models for Science", venue: "NeurIPS", year: 2025 },
      author,
      "https://proceedings.neurips.cc/paper_files/paper/2025/hash/abcd-Abstract-Conference.html",
      "Robust Language Models for Science — Asha Kumar. Advances in Neural Information Processing Systems.",
    )).toBe(true);
  });
  it("does not mistake an ICML workshop proceedings page for the main track", () => {
    expect(matchesOfficialPaper(
      { title: "Robust Language Models for Science", venue: "ICML", year: 2025 },
      author,
      "https://proceedings.mlr.press/v267/kumar25a.html",
      "Robust Language Models for Science — Asha Kumar. Proceedings of the ICML 2025 Workshop on Science.",
    )).toBe(false);
  });
  it("rejects workshop pages, wrong authors, years, and non-official hosts", () => {
    const paper = { title: "Robust Language Models for Science", venue: "ACL" as const, year: 2025 };
    expect(matchesOfficialPaper(paper, author, "https://aclanthology.org/2025.acl-w.123/", "Robust Language Models for Science — Asha Kumar")).toBe(false);
    expect(matchesOfficialPaper(paper, author, "https://aclanthology.org/2025.acl-long.123/", "Robust Language Models for Science — Another Author")).toBe(false);
    expect(matchesOfficialPaper(paper, author, "https://aclanthology.org/2024.acl-long.123/", "Robust Language Models for Science — Asha Kumar")).toBe(false);
    expect(matchesOfficialPaper(paper, author, "https://example.com/2025.acl-long.123/", "Robust Language Models for Science — Asha Kumar")).toBe(false);
  });
});
