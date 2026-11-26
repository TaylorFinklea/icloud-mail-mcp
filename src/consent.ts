import type { ConsentDescription } from "@cloudflare/workers-oauth-provider";
import { SCOPE_ARCHIVE, SCOPE_READ } from "./tools";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const SCOPE_LABELS: Record<string, string> = {
  [SCOPE_READ]: "Search and read your iCloud Mail (never marks it read)",
  [SCOPE_ARCHIVE]: "Move messages to your Archive folder",
};

export function consentPage(details: ConsentDescription, handle: string): string {
  const name = escape(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escape(details.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  // Clients request only the resource's required scope (mail:read), so the
  // archive opt-in is always offered here, unticked unless it was requested.
  const offered = details.scope.includes(SCOPE_ARCHIVE) ? details.scope : [...details.scope, SCOPE_ARCHIVE];
  const scopes = offered
    .map((s) => {
      const checked = s === SCOPE_ARCHIVE && !details.scope.includes(SCOPE_ARCHIVE) ? "" : "checked";
      return `<label><input type="checkbox" name="scope" value="${escape(s)}" ${checked} ${s === SCOPE_READ ? "disabled" : ""}> ${escape(SCOPE_LABELS[s] ?? s)}</label>`;
    })
    .join("<br>");
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow ${name}?</title>
<style>body{font:16px system-ui;max-width:32rem;margin:2rem auto;padding:0 1rem}button{font:inherit;padding:.5rem 1rem;margin-right:.5rem}</style>
<h1>Allow ${name} to use your iCloud Mail?</h1>
<p>${origin} Access goes to <strong>${escape(details.redirectHost)}</strong>.</p>
<p>It can never send or delete mail.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <input type="hidden" name="scope" value="${SCOPE_READ}">
  <p>${scopes}</p>
  <p><button name="decision" value="approve">Allow</button><button name="decision" value="deny">Deny</button></p>
</form>`;
}
