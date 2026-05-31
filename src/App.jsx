import { useState, useEffect, useCallback } from "react";

// ─── CONFIG ─────────────────────────────────────────────────────────────────
// Fill these in before running:
const CONFIG = {
  SPOTIFY_CLIENT_ID: "YOUR_SPOTIFY_CLIENT_ID",       // https://developer.spotify.com/dashboard
  SPOTIFY_REDIRECT_URI: window.location.origin + window.location.pathname,
  APPLE_MUSIC_DEVELOPER_TOKEN: "YOUR_APPLE_MUSIC_DEV_TOKEN", // https://developer.apple.com/documentation/applemusicapi
};

// ─── SPOTIFY HELPERS ─────────────────────────────────────────────────────────
const SPOTIFY_SCOPES = "playlist-modify-public playlist-modify-private";

function spotifyAuthUrl() {
  const params = new URLSearchParams({
    client_id: CONFIG.SPOTIFY_CLIENT_ID,
    response_type: "token",
    redirect_uri: CONFIG.SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPES,
    show_dialog: "true",
  });
  return `https://accounts.spotify.com/authorize?${params}`;
}

function getSpotifyTokenFromHash() {
  const hash = window.location.hash.substring(1);
  const params = new URLSearchParams(hash);
  return params.get("access_token") || null;
}

async function spotifySearch(token, query, preferLive = true) {
  const liveQuery = preferLive ? `${query} Dave Matthews Band live` : `${query} Dave Matthews Band`;
  const res = await fetch(
    `https://api.spotify.com/v1/search?q=${encodeURIComponent(liveQuery)}&type=track&limit=5`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  const tracks = data.tracks?.items || [];
  if (preferLive && tracks.length === 0) return spotifySearch(token, query, false);
  // Prefer tracks with "live" in name/album
  if (preferLive) {
    const live = tracks.find(
      (t) =>
        t.name.toLowerCase().includes("live") ||
        t.album?.name.toLowerCase().includes("live") ||
        t.album?.name.toLowerCase().includes("live at") ||
        t.album?.name.toLowerCase().includes("live trax")
    );
    return live || tracks[0] || null;
  }
  return tracks[0] || null;
}

async function spotifyGetUserId(token) {
  const res = await fetch("https://api.spotify.com/v1/me", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  return data.id;
}

async function spotifyCreatePlaylist(token, userId, name, description) {
  const res = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, description, public: false }),
  });
  return res.json();
}

async function spotifyAddTracks(token, playlistId, uris) {
  // Spotify allows max 100 tracks per call
  for (let i = 0; i < uris.length; i += 100) {
    await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/tracks`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ uris: uris.slice(i, i + 100) }),
    });
  }
}

// ─── APPLE MUSIC HELPERS ─────────────────────────────────────────────────────
async function initMusicKit() {
  return new Promise((resolve, reject) => {
    if (window.MusicKit) {
      resolve(window.MusicKit);
      return;
    }
    const script = document.createElement("script");
    script.src = "https://js-cdn.music.apple.com/musickit/v3/musickit.js";
    script.onload = () => resolve(window.MusicKit);
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function configureMusicKit(devToken) {
  const MusicKit = await initMusicKit();
  await MusicKit.configure({
    developerToken: devToken,
    app: { name: "DMB Setlist Playlist", build: "1.0" },
  });
  return MusicKit.getInstance();
}

async function appleMusicSearch(music, query, preferLive = true) {
  const liveQuery = preferLive ? `${query} Dave Matthews live` : `${query} Dave Matthews`;
  const res = await music.api.music(`/v1/catalog/us/search`, {
    term: liveQuery,
    types: "songs",
    limit: 5,
  });
  const songs = res.data?.results?.songs?.data || [];
  if (preferLive && songs.length === 0) return appleMusicSearch(music, query, false);
  if (preferLive) {
    const live = songs.find(
      (s) =>
        s.attributes?.name?.toLowerCase().includes("live") ||
        s.attributes?.albumName?.toLowerCase().includes("live")
    );
    return live || songs[0] || null;
  }
  return songs[0] || null;
}

async function appleMusicCreatePlaylist(music, name, description, trackIds) {
  const res = await music.api.music("/v1/me/library/playlists", {}, {
    fetchOptions: {
      method: "POST",
      body: JSON.stringify({
        attributes: { name, description },
        relationships: {
          tracks: {
            data: trackIds.map((id) => ({ id, type: "songs" })),
          },
        },
      }),
    },
  });
  return res;
}

// ─── SETLIST SCRAPER (via Claude AI proxy) ───────────────────────────────────
async function fetchSetlistFromDMBSite(dateHint = "") {
  const prompt = `
Fetch the most recent Dave Matthews Band setlist from https://davematthewsband.com/
${dateHint ? `Try to find the setlist for: ${dateHint}` : "Find the most recent/latest setlist posted."}

Return ONLY a JSON object with this exact structure, no markdown:
{
  "date": "Month Day, Year",
  "venue": "Venue Name",
  "city": "City, State",
  "songs": ["Song Title 1", "Song Title 2", ...]
}

If you cannot find the setlist, return: {"error": "Could not find setlist"}
`;

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1000,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const data = await response.json();
  const text = data.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
  const clean = text.replace(/```json|```/g, "").trim();
  // Extract JSON from the response
  const match = clean.match(/\{[\s\S]*\}/);
  if (match) return JSON.parse(match[0]);
  throw new Error("Could not parse setlist response");
}

// ─── COMPONENTS ──────────────────────────────────────────────────────────────
const COLORS = {
  bg: "#0a0a0a",
  card: "#111111",
  border: "#222",
  accent: "#c8a84b",
  accentDim: "#8a7030",
  text: "#e8e0cc",
  muted: "#666",
  spotify: "#1DB954",
  apple: "#fc3c44",
  success: "#4caf78",
  error: "#e05555",
};

const css = `
  @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap');

  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: ${COLORS.bg}; color: ${COLORS.text}; font-family: 'IBM Plex Mono', monospace; }

  .app { min-height: 100vh; padding: 32px 16px; max-width: 760px; margin: 0 auto; }

  h1 { font-family: 'Playfair Display', serif; font-size: clamp(2rem, 5vw, 3.2rem);
    color: ${COLORS.accent}; letter-spacing: -1px; line-height: 1.1; }
  h2 { font-family: 'Playfair Display', serif; font-size: 1.4rem; color: ${COLORS.text}; margin-bottom: 12px; }

  .subtitle { font-size: 0.75rem; color: ${COLORS.muted}; letter-spacing: 2px; text-transform: uppercase;
    margin-top: 6px; margin-bottom: 40px; }

  .card { background: ${COLORS.card}; border: 1px solid ${COLORS.border};
    border-radius: 4px; padding: 24px; margin-bottom: 20px; }

  .section-label { font-size: 0.65rem; color: ${COLORS.accentDim}; letter-spacing: 3px;
    text-transform: uppercase; margin-bottom: 16px; border-bottom: 1px solid ${COLORS.border}; padding-bottom: 8px; }

  button { cursor: pointer; font-family: 'IBM Plex Mono', monospace; font-size: 0.8rem;
    letter-spacing: 1px; text-transform: uppercase; border: none; border-radius: 3px;
    padding: 10px 20px; transition: all 0.15s; }
  button:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-spotify { background: ${COLORS.spotify}; color: #000; font-weight: 700; }
  .btn-spotify:hover:not(:disabled) { background: #25e26a; transform: translateY(-1px); }

  .btn-apple { background: ${COLORS.apple}; color: #fff; font-weight: 700; }
  .btn-apple:hover:not(:disabled) { background: #ff5560; transform: translateY(-1px); }

  .btn-gold { background: ${COLORS.accent}; color: #000; font-weight: 700; }
  .btn-gold:hover:not(:disabled) { background: #e0bc5a; transform: translateY(-1px); }

  .btn-ghost { background: transparent; color: ${COLORS.muted}; border: 1px solid ${COLORS.border}; }
  .btn-ghost:hover:not(:disabled) { border-color: ${COLORS.accent}; color: ${COLORS.accent}; }

  .btn-row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }

  input, textarea { background: #1a1a1a; border: 1px solid ${COLORS.border}; color: ${COLORS.text};
    font-family: 'IBM Plex Mono', monospace; font-size: 0.85rem; border-radius: 3px;
    padding: 10px 14px; width: 100%; outline: none; transition: border-color 0.15s; }
  input:focus, textarea:focus { border-color: ${COLORS.accent}; }
  label { font-size: 0.7rem; color: ${COLORS.muted}; letter-spacing: 1px; text-transform: uppercase;
    display: block; margin-bottom: 6px; }

  .setlist { list-style: none; }
  .setlist li { display: flex; align-items: center; gap: 12px; padding: 8px 0;
    border-bottom: 1px solid #1a1a1a; font-size: 0.85rem; }
  .setlist li:last-child { border-bottom: none; }
  .setlist .num { color: ${COLORS.accentDim}; min-width: 28px; font-size: 0.7rem; }
  .setlist .song-status { margin-left: auto; font-size: 0.65rem; padding: 2px 8px; border-radius: 2px; }
  .status-found { background: #1a3025; color: ${COLORS.success}; }
  .status-notfound { background: #2a1818; color: ${COLORS.error}; }
  .status-live { background: #1a2a15; color: #7fcf60; }
  .status-searching { color: ${COLORS.muted}; }

  .meta { font-size: 0.75rem; color: ${COLORS.muted}; }
  .meta strong { color: ${COLORS.accent}; font-size: 0.9rem; }

  .log { background: #070707; border: 1px solid #1a1a1a; border-radius: 3px; padding: 16px;
    font-size: 0.7rem; max-height: 200px; overflow-y: auto; margin-top: 16px; }
  .log p { margin: 2px 0; color: ${COLORS.muted}; }
  .log p.ok { color: ${COLORS.success}; }
  .log p.err { color: ${COLORS.error}; }
  .log p.info { color: ${COLORS.accent}; }

  .pill { display: inline-block; font-size: 0.6rem; letter-spacing: 1px; text-transform: uppercase;
    padding: 3px 8px; border-radius: 2px; margin-left: 8px; }
  .pill-connected { background: #1a3025; color: ${COLORS.success}; }
  .pill-disconnected { background: #2a1818; color: ${COLORS.error}; }

  .divider { border: none; border-top: 1px solid ${COLORS.border}; margin: 24px 0; }
  .flex-between { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; }

  .config-warning { background: #1a1400; border: 1px solid #3a3000; border-radius: 4px;
    padding: 16px; margin-bottom: 20px; font-size: 0.78rem; color: #c8a030; line-height: 1.6; }
  .config-warning code { background: #2a2000; padding: 1px 6px; border-radius: 2px; }
`;

export default function App() {
  const [spotifyToken, setSpotifyToken] = useState(null);
  const [appleMusic, setAppleMusic] = useState(null);
  const [appleMusicAuthed, setAppleMusicAuthed] = useState(false);
  const [setlist, setSetlist] = useState(null);
  const [trackResults, setTrackResults] = useState([]);
  const [dateHint, setDateHint] = useState("");
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [log, setLog] = useState([]);
  const [playlistName, setPlaylistName] = useState("");
  const [configOk, setConfigOk] = useState(false);

  const addLog = useCallback((msg, type = "") => {
    setLog((l) => [...l, { msg, type, id: Date.now() + Math.random() }]);
  }, []);

  // Check config
  useEffect(() => {
    const ok =
      CONFIG.SPOTIFY_CLIENT_ID !== "YOUR_SPOTIFY_CLIENT_ID" ||
      CONFIG.APPLE_MUSIC_DEVELOPER_TOKEN !== "YOUR_APPLE_MUSIC_DEV_TOKEN";
    setConfigOk(ok);
  }, []);

  // Capture Spotify token from hash after OAuth redirect
  useEffect(() => {
    const token = getSpotifyTokenFromHash();
    if (token) {
      setSpotifyToken(token);
      window.history.replaceState({}, "", window.location.pathname);
      addLog("Spotify connected ✓", "ok");
    }
  }, [addLog]);

  // Init Apple Music
  async function connectAppleMusic() {
    try {
      addLog("Loading MusicKit JS…", "info");
      const music = await configureMusicKit(CONFIG.APPLE_MUSIC_DEVELOPER_TOKEN);
      setAppleMusic(music);
      addLog("Requesting Apple Music authorization…", "info");
      await music.authorize();
      setAppleMusicAuthed(true);
      addLog("Apple Music connected ✓", "ok");
    } catch (e) {
      addLog("Apple Music error: " + e.message, "err");
    }
  }

  // Fetch setlist
  async function fetchSetlist() {
    setLoading(true);
    setTrackResults([]);
    setLog([]);
    try {
      addLog("Fetching latest DMB setlist…", "info");
      const data = await fetchSetlistFromDMBSite(dateHint);
      if (data.error) throw new Error(data.error);
      setSetlist(data);
      const name = `DMB – ${data.venue} – ${data.date}`;
      setPlaylistName(name);
      addLog(`Found setlist: ${data.songs.length} songs at ${data.venue}`, "ok");
    } catch (e) {
      addLog("Error: " + e.message, "err");
    }
    setLoading(false);
  }

  // Search tracks on Spotify
  async function searchSpotifyTracks() {
    if (!spotifyToken || !setlist) return;
    setCreating(true);
    addLog("Searching Spotify for each song (preferring live versions)…", "info");
    const results = [];
    for (const song of setlist.songs) {
      addLog(`  Searching: "${song}"…`);
      const track = await spotifySearch(spotifyToken, song);
      const isLive =
        track &&
        (track.name.toLowerCase().includes("live") ||
          track.album?.name.toLowerCase().includes("live") ||
          track.album?.name.toLowerCase().includes("live trax"));
      results.push({ song, track, isLive, found: !!track });
      setTrackResults([...results]);
    }
    setCreating(false);
    const found = results.filter((r) => r.found).length;
    addLog(`Found ${found}/${setlist.songs.length} tracks on Spotify`, found === setlist.songs.length ? "ok" : "info");
  }

  // Create Spotify playlist
  async function createSpotifyPlaylist() {
    if (!spotifyToken || trackResults.length === 0) return;
    setCreating(true);
    try {
      addLog("Creating Spotify playlist…", "info");
      const userId = await spotifyGetUserId(spotifyToken);
      const pl = await spotifyCreatePlaylist(
        spotifyToken,
        userId,
        playlistName,
        `DMB Setlist from ${setlist?.date} at ${setlist?.venue} — auto-generated, live versions preferred`
      );
      const uris = trackResults.filter((r) => r.found).map((r) => r.track.uri);
      await spotifyAddTracks(spotifyToken, pl.id, uris);
      addLog(`Playlist created! "${playlistName}" (${uris.length} tracks)`, "ok");
      if (pl.external_urls?.spotify) {
        addLog(`Open: ${pl.external_urls.spotify}`, "info");
      }
    } catch (e) {
      addLog("Spotify error: " + e.message, "err");
    }
    setCreating(false);
  }

  // Search & create Apple Music playlist
  async function createAppleMusicPlaylist() {
    if (!appleMusic || !appleMusicAuthed || !setlist) return;
    setCreating(true);
    try {
      addLog("Searching Apple Music for each song (preferring live versions)…", "info");
      const ids = [];
      for (const song of setlist.songs) {
        addLog(`  Searching AM: "${song}"…`);
        const track = await appleMusicSearch(appleMusic, song);
        if (track) {
          ids.push(track.id);
          addLog(`  ✓ ${track.attributes?.name}`, "ok");
        } else {
          addLog(`  ✗ Not found: "${song}"`, "err");
        }
      }
      addLog("Creating Apple Music playlist…", "info");
      await appleMusicCreatePlaylist(
        appleMusic,
        playlistName,
        `DMB Setlist from ${setlist?.date} at ${setlist?.venue} — live versions preferred`,
        ids
      );
      addLog(`Apple Music playlist created! "${playlistName}" (${ids.length} tracks)`, "ok");
    } catch (e) {
      addLog("Apple Music error: " + e.message, "err");
    }
    setCreating(false);
  }

  const isConfigured = CONFIG.SPOTIFY_CLIENT_ID !== "YOUR_SPOTIFY_CLIENT_ID";

  return (
    <>
      <style>{css}</style>
      <div className="app">
        {/* Header */}
        <h1>DMB Setlist<br />→ Playlist</h1>
        <p className="subtitle">Dave Matthews Band · Live show playlist generator</p>

        {/* Config warning */}
        {!isConfigured && (
          <div className="config-warning">
            <strong>⚙ Setup required</strong> before using this tool:
            <br /><br />
            <strong>Spotify:</strong> Create an app at{" "}
            <a href="https://developer.spotify.com/dashboard" target="_blank" style={{ color: COLORS.accent }}>
              developer.spotify.com/dashboard
            </a>{" "}
            → copy your <code>Client ID</code> → set your Redirect URI to this page's URL →
            paste into <code>CONFIG.SPOTIFY_CLIENT_ID</code> at the top of this file.
            <br /><br />
            <strong>Apple Music:</strong> Requires an Apple Developer account ($99/yr). Generate a{" "}
            <a href="https://developer.apple.com/documentation/applemusicapi/generating_developer_tokens" target="_blank" style={{ color: COLORS.accent }}>
              MusicKit Developer Token
            </a>{" "}
            (JWT signed with your MusicKit key) → paste into <code>CONFIG.APPLE_MUSIC_DEVELOPER_TOKEN</code>.
          </div>
        )}

        {/* Step 1: Connect */}
        <div className="card">
          <div className="section-label">Step 1 — Connect your music services</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div className="flex-between">
              <span style={{ fontSize: "0.85rem" }}>
                Spotify
                <span className={`pill ${spotifyToken ? "pill-connected" : "pill-disconnected"}`}>
                  {spotifyToken ? "connected" : "not connected"}
                </span>
              </span>
              <button
                className="btn-spotify"
                onClick={() => window.location.href = spotifyAuthUrl()}
                disabled={!isConfigured || !!spotifyToken}
              >
                {spotifyToken ? "✓ Connected" : "Connect Spotify"}
              </button>
            </div>
            <div className="flex-between">
              <span style={{ fontSize: "0.85rem" }}>
                Apple Music
                <span className={`pill ${appleMusicAuthed ? "pill-connected" : "pill-disconnected"}`}>
                  {appleMusicAuthed ? "connected" : "not connected"}
                </span>
              </span>
              <button
                className="btn-apple"
                onClick={connectAppleMusic}
                disabled={!isConfigured || appleMusicAuthed || CONFIG.APPLE_MUSIC_DEVELOPER_TOKEN === "YOUR_APPLE_MUSIC_DEV_TOKEN"}
              >
                {appleMusicAuthed ? "✓ Connected" : "Connect Apple Music"}
              </button>
            </div>
          </div>
        </div>

        {/* Step 2: Fetch setlist */}
        <div className="card">
          <div className="section-label">Step 2 — Fetch setlist from davematthewsband.com</div>
          <label htmlFor="dateHint">Date (optional — e.g. "June 14, 2025")</label>
          <input
            id="dateHint"
            value={dateHint}
            onChange={(e) => setDateHint(e.target.value)}
            placeholder="Leave blank for the most recent show"
          />
          <div className="btn-row">
            <button className="btn-gold" onClick={fetchSetlist} disabled={loading}>
              {loading ? "Fetching…" : "Fetch Latest Setlist"}
            </button>
          </div>
        </div>

        {/* Setlist display */}
        {setlist && (
          <div className="card">
            <div className="section-label">Setlist</div>
            <div className="meta" style={{ marginBottom: 16 }}>
              <strong>{setlist.venue}</strong>
              <br />
              {setlist.city} · {setlist.date}
            </div>

            <label htmlFor="plName">Playlist name</label>
            <input
              id="plName"
              value={playlistName}
              onChange={(e) => setPlaylistName(e.target.value)}
            />

            <ul className="setlist" style={{ marginTop: 16 }}>
              {setlist.songs.map((song, i) => {
                const result = trackResults[i];
                return (
                  <li key={i}>
                    <span className="num">{i + 1}</span>
                    <span>{song}</span>
                    {result && (
                      <span className={`song-status ${result.found ? (result.isLive ? "status-live" : "status-found") : "status-notfound"}`}>
                        {result.found ? (result.isLive ? "live ✓" : "found ✓") : "not found"}
                      </span>
                    )}
                    {!result && trackResults.length > 0 && i >= trackResults.length && (
                      <span className="song-status status-searching">…</span>
                    )}
                  </li>
                );
              })}
            </ul>

            <hr className="divider" />

            <div className="btn-row">
              {spotifyToken && trackResults.length === 0 && (
                <button className="btn-spotify" onClick={searchSpotifyTracks} disabled={creating}>
                  Search Spotify Tracks
                </button>
              )}
              {spotifyToken && trackResults.length > 0 && (
                <button className="btn-spotify" onClick={createSpotifyPlaylist} disabled={creating}>
                  {creating ? "Creating…" : "Create Spotify Playlist"}
                </button>
              )}
              {appleMusicAuthed && (
                <button className="btn-apple" onClick={createAppleMusicPlaylist} disabled={creating}>
                  {creating ? "Creating…" : "Create Apple Music Playlist"}
                </button>
              )}
              {!spotifyToken && !appleMusicAuthed && (
                <span style={{ fontSize: "0.75rem", color: COLORS.muted }}>
                  Connect a music service above to create a playlist
                </span>
              )}
            </div>
          </div>
        )}

        {/* Log */}
        {log.length > 0 && (
          <div className="log">
            {log.map((entry) => (
              <p key={entry.id} className={entry.type}>
                {entry.msg}
              </p>
            ))}
          </div>
        )}

        <p style={{ fontSize: "0.65rem", color: COLORS.muted, marginTop: 32, textAlign: "center" }}>
          Live versions preferred — searches "Dave Matthews Band live [song]" first.
          <br />Setlist scraped via AI web search from davematthewsband.com
        </p>
      </div>
    </>
  );
}
