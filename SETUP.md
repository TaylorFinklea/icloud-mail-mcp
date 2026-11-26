# Setup

You do every step that touches a secret or an account. About 20 minutes.

## 0. Before you start

- A domain on Cloudflare (for example a subdomain like `mail-mcp.<your-domain>`).
- Cloudflare Zero Trust (the free plan is enough) for Access.
- Node 22.12+ and `npx wrangler login` done on your machine.
- Your own config: `cp wrangler.example.jsonc wrangler.jsonc`. It is
  git-ignored, so your addresses and IDs stay out of the repo.

## 1. Make an Apple app-specific password

1. Sign in at account.apple.com.
2. **Sign-In and Security** > **App-Specific Passwords** > **Generate an app-specific password**.
3. Name it `Claude mail connector`. Keep the page open; you paste it in step 4.

Two-factor must be on. You can remove it there anytime, and changing your
Apple Account password revokes it too.

## 2. Create the KV namespace

```sh
npx wrangler kv namespace create OAUTH_KV
```

Put the printed `id` into `wrangler.jsonc` under `kv_namespaces`.

## 3. Put Cloudflare Access in front of /authorize only

In Zero Trust: **Access** > **Applications** > **Add an application** > **Self-hosted**.

- Domain: your hostname, path: `authorize`
- Policy: **Allow**, include **Emails** = the email you sign in to Access with
- Save, then copy the application's **AUD tag**

Do not protect the whole hostname: Claude's servers call `/token` and `/mcp`
without a browser and would be blocked.

## 4. Fill in config and the secret

In `wrangler.jsonc`:

| Key | Value |
| --- | --- |
| `routes[0].pattern` | your hostname |
| `PUBLIC_ORIGIN` | `https://` + your hostname |
| `ICLOUD_USER` | your iCloud Mail address. Apple says the name part alone (before `@icloud.com`) usually works for IMAP; use the full address if that fails |
| `OWNER_EMAIL` | the email Access lets through |
| `ACCESS_TEAM_DOMAIN` | `https://<team>.cloudflareaccess.com` (no trailing slash) |
| `ACCESS_AUD` | the AUD tag from step 3 |

Then set the password yourself; wrangler prompts for it and it never lands in a file:

```sh
npx wrangler secret put ICLOUD_APP_PASSWORD
```

## 5. Test and deploy

```sh
npm ci
npm test
npx wrangler deploy
```

Quick checks:

```sh
curl -s https://<host>/.well-known/oauth-protected-resource/mcp   # JSON with "resource"
curl -si -X POST https://<host>/mcp | head -1                     # 401
```

Open `https://<host>/authorize` in a private window: you should get the Access
login, and `https://<host>/` should not ask for one.

## 6. Add it to Claude

1. claude.ai > **Settings** > **Connectors** > **Add custom connector**.
2. Name `iCloud Mail`, URL `https://<host>/mcp`.
3. **Connect**: sign in to Access, then on the consent page leave **Move messages
   to your Archive folder** unticked if you want read-only first. **Allow**.
4. In the connector's tool settings, set `archive_messages` to ask before running
   until you trust it.

Ask Claude to "list my iCloud Mail folders" to confirm.

## Turning it off

- Disconnect in claude.ai, and/or
- Remove the app-specific password at account.apple.com (stops IMAP at once), and/or
- `npx wrangler secret delete ICLOUD_APP_PASSWORD` or `npx wrangler delete`.

## What iCloud does

Checked against the live service:

- The Worker reaches `imap.mail.me.com:993` over `cloudflare:sockets`.
- iCloud advertises `UIDPLUS` but not `MOVE`, so archiving copies, then
  `UID EXPUNGE`s just those messages. A server with neither makes
  `archive_messages` return "archiving is disabled" with its capability list,
  and reading still works.
- iCloud's `Archive` folder is found. The code looks for the `\Archive`
  special-use flag, then a folder named `Archive`.
