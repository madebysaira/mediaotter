# 🔑 MediaOtter — YouTube credentials (bring your own)

MediaOtter is **open source**. It never ships with Google credentials inside the repo —
you create your own free Google Cloud credentials and paste them into a **gitignored**
file on your machine. Nothing is committed, nothing is leaked.

> Your credentials stay on **your** machine in
> `extension/js/credentials.json` (gitignored — see `.gitignore`).
> The packaged release only embeds the credentials the maintainer injects at build
> time via environment variables, never from the repo.

## What you need (5 minutes, free)

1. A Google account (you already have one).
2. A Google Cloud project with the **YouTube Data API v3** enabled.
3. An OAuth **Desktop** client (Client ID) + an **API key**.

No client secret is needed — MediaOtter uses the **PKCE** flow, so there is no
secret to leak at all.

---

## Step-by-step

### 1. Create a Google Cloud project
- Go to <https://console.cloud.google.com/projectcreate>
- Name it anything (e.g. `mediaotter`), click **Create**.

### 2. Enable the YouTube Data API v3
- <https://console.cloud.google.com/apis/library/youtube.googleapis.com>
- Select your project → **Enable**.

### 3. Configure the OAuth consent screen
- <https://console.cloud.google.com/apis/credentials/consent>
- **User type: External** (your account alone works, no verification needed for personal use).
- Fill in the app name + your email; skip everything else; **Save**.

### 4. Create an OAuth Client ID
- <https://console.cloud.google.com/apis/credentials>
- **Create credentials → OAuth client ID**
- Application type: **Desktop app** (this enables the loopback `127.0.0.1` redirect
  MediaOtter uses for sign-in).
- Copy the **Client ID** (starts with `....apps.googleusercontent.com`).

### 5. Create an API key
- <https://console.cloud.google.com/apis/credentials>
- **Create credentials → API key** — copy it.

> Optional hardening: restrict the API key to the YouTube Data API only
> (Edit API key → API restrictions → YouTube Data API v3). Recommended.

### 6. Tell MediaOtter
Create the file:

```
extension/js/credentials.json
```

with:

```json
{
  "clientId": "YOUR_CLIENT_ID.apps.googleusercontent.com",
  "apiKey": "YOUR_API_KEY"
}
```

That file is **gitignored** — `git status` will never show it. Then restart the
panel: **My YouTube → Sign in with Google**.

---

## For packagers / maintainers

Never commit `credentials.json` or `*.secret`. To inject credentials into a build:

```bash
export MF_GOOGLE_CLIENT_ID="…"
export MF_GOOGLE_API_KEY="…"
node scripts/inject-credentials.js
```

`scripts/inject-credentials.js` refuses to run when the values are empty or still
placeholders, and prints a redacted confirmation only (`clientId: …r4nd0m…suffix`).

## Security model recap

| Item | Where it lives | In the repo? |
|---|---|---|
| Your Client ID + API key | `extension/js/credentials.json` | ❌ gitignored |
| OAuth refresh token | `~/.mediaotter/auth.json` (0600) | ❌ never |
| Download history | `~/.mediaotter/history.json` | ❌ never |
| Logs | `~/.mediaotter/logs/` | ❌ never |
| yt-dlp / ffmpeg / deno binaries | `extension/binaries/` | ❌ gitignored |
| Maintainer's build credentials | CI env vars → injected at package time | ❌ never |
