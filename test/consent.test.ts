import { describe, expect, it } from "vitest";
import { consentPage } from "../src/consent";

const details = (scope: string[]) =>
  ({ clientName: "Claude", clientDomain: undefined, redirectHost: "claude.ai", scope }) as any;

describe("consent page", () => {
  it("offers archive unticked when the client asked only for read", () => {
    const html = consentPage(details(["mail:read", "offline_access"]), "h");
    expect(html).toMatch(/value="mail:archive"\s+>/);
    expect(html).toContain("Move messages to your Archive folder");
  });

  it("ticks archive when the client asked for it, and lists it once", () => {
    const html = consentPage(details(["mail:read", "mail:archive"]), "h");
    expect(html).toMatch(/value="mail:archive" checked/);
    expect(html.match(/value="mail:archive"/g)).toHaveLength(1);
  });
});
