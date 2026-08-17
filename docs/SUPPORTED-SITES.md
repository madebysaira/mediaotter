# 🌐 MediaOtter — supported sites

MediaOtter downloads through **yt-dlp**, which supports **1,000+ websites**.
YouTube gets the full experience (search, suggestions, playlists, account sign-in);
everything else works through **Paste URL**.

## Works out of the box (paste a link)

- **Video**: YouTube, Vimeo, Twitch, TikTok, Instagram, Facebook, X/Twitter,
  Reddit, Dailymotion, VK, Rumble, archive.org, TED, Coursera, PeerTube, …
- **Audio**: SoundCloud, Bandcamp, Mixcloud, Apple Podcasts, Spotify (with cookies),
  Deezer (with cookies), Audius, …
- **Channels/playlists**: YouTube channels & playlists, Twitch VODs & clips,
  SoundCloud sets, Bandcamp albums, …

## Notes

- Some sites require **login cookies** (e.g. Spotify, private Instagram).
  Use **Settings → YouTube browser session** — MediaOtter passes your browser's
  cookies to yt-dlp for the supported browsers (Chrome, Edge, Brave, Firefox).
- Sites paywalled or protected by DRM (Netflix, Prime Video, HBO Max, Disney+) are
  **not** supported by yt-dlp and never will be — please don't ask.
- YouTube private/age-restricted videos also need the browser session.

## Verify what yt-dlp supports

```bash
./extension/binaries/yt-dlp --list-extractors | wc -l
```

The authoritative list lives at
<https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md>.

## Fair use

Only download content you have the right to. MediaOtter is a tool, not a license —
respect each platform's terms of service and copyright.
