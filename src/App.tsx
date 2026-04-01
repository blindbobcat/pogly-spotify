import { useEffect, useState, useCallback, useRef } from "react";
import {
  redirectToSpotifyAuth,
  exchangeCodeForToken,
  getValidAccessToken,
  getCurrentlyPlaying,
  isAuthenticated,
  logout,
  createPlayer,
  transferPlayback,
  type NowPlaying,
  type SpotifyPlayer,
  type PlayerState,
} from "./spotify";

const POLL_INTERVAL = 3000;

interface AppProps {
  clientId: string;
}

export default function App({ clientId }: AppProps) {
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  const [authed, setAuthed] = useState(isAuthenticated());
  const [error, setError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [hovered, setHovered] = useState(false);
  const progressRef = useRef<HTMLDivElement>(null);
  const animationRef = useRef<number>(0);
  const lastFetchRef = useRef<{
    progressMs: number;
    durationMs: number;
    timestamp: number;
  } | null>(null);
  const playerRef = useRef<SpotifyPlayer | null>(null);
  const deviceIdRef = useRef<string | null>(null);

  // Handle OAuth callback
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    if (code && clientId) {
      exchangeCodeForToken(clientId, code)
        .then(() => {
          setAuthed(true);
          setError(null);
        })
        .catch(() => setError("Authentication failed. Try again."));
    }
  }, [clientId]);

  // Initialize Web Playback SDK
  useEffect(() => {
    if (!authed || !clientId) return;

    let mounted = true;

    const initPlayer = async () => {
      try {
        const player = await createPlayer(
          clientId,
          "Pogly Spotify Widget",
          0.5,
          async (deviceId) => {
            if (!mounted) return;
            deviceIdRef.current = deviceId;
            setPlayerReady(true);
            // Transfer playback to this widget
            const token = await getValidAccessToken(clientId);
            if (token) {
              await transferPlayback(token, deviceId);
            }
          },
          (state: PlayerState | null) => {
            if (!mounted || !state) return;
            setIsPlaying(!state.paused);
            const track = state.track_window.current_track;
            setNowPlaying({
              isPlaying: !state.paused,
              trackName: track.name,
              artistName: track.artists.map((a) => a.name).join(", "),
              albumName: track.album.name,
              albumArt: track.album.images[0]?.url ?? "",
              progressMs: state.position,
              durationMs: state.duration,
              trackUrl: "",
            });
            lastFetchRef.current = {
              progressMs: state.position,
              durationMs: state.duration,
              timestamp: Date.now(),
            };
          },
          (msg) => {
            if (!mounted) return;
            console.error("Spotify Player Error:", msg);
          }
        );
        if (mounted) playerRef.current = player;
      } catch {
        // SDK failed — fall back to polling API
        if (mounted) setPlayerReady(false);
      }
    };

    initPlayer();

    return () => {
      mounted = false;
      playerRef.current?.disconnect();
    };
  }, [authed, clientId]);

  // Fallback: poll API if SDK not available
  const fetchNowPlaying = useCallback(async () => {
    if (!clientId || playerReady) return;
    const token = await getValidAccessToken(clientId);
    if (!token) {
      setAuthed(false);
      return;
    }
    try {
      const data = await getCurrentlyPlaying(token);
      if (data) {
        lastFetchRef.current = {
          progressMs: data.progressMs,
          durationMs: data.durationMs,
          timestamp: Date.now(),
        };
        setIsPlaying(data.isPlaying);
      }
      setNowPlaying(data);
      setError(null);
    } catch {
      setError("Failed to fetch playback");
    }
  }, [clientId, playerReady]);

  useEffect(() => {
    if (!authed || playerReady) return;
    fetchNowPlaying();
    const interval = setInterval(fetchNowPlaying, POLL_INTERVAL);
    return () => clearInterval(interval);
  }, [authed, fetchNowPlaying, playerReady]);

  // Animate progress bar smoothly
  useEffect(() => {
    if (!isPlaying || !progressRef.current) {
      cancelAnimationFrame(animationRef.current);
      return;
    }

    const animate = () => {
      if (!progressRef.current || !lastFetchRef.current) return;
      const { progressMs, durationMs, timestamp } = lastFetchRef.current;
      const elapsed = Date.now() - timestamp;
      const currentProgress = Math.min(progressMs + elapsed, durationMs);
      const pct = (currentProgress / durationMs) * 100;
      progressRef.current.style.width = `${pct}%`;
      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(animationRef.current);
  }, [isPlaying]);

  // Show/hide animation
  useEffect(() => {
    if (nowPlaying) {
      setVisible(true);
    } else {
      const timeout = setTimeout(() => setVisible(false), 500);
      return () => clearTimeout(timeout);
    }
  }, [nowPlaying]);

  // Playback controls
  const handleTogglePlay = async () => {
    if (playerRef.current) {
      await playerRef.current.togglePlay();
    } else {
      // Fallback: use API
      const token = await getValidAccessToken(clientId);
      if (!token) return;
      const endpoint = isPlaying ? "pause" : "play";
      await fetch(`https://api.spotify.com/v1/me/player/${endpoint}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${token}` },
      });
      setIsPlaying(!isPlaying);
    }
  };

  const handleNext = async () => {
    if (playerRef.current) {
      await playerRef.current.nextTrack();
    } else {
      const token = await getValidAccessToken(clientId);
      if (!token) return;
      await fetch("https://api.spotify.com/v1/me/player/next", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  };

  const handlePrev = async () => {
    if (playerRef.current) {
      await playerRef.current.previousTrack();
    } else {
      const token = await getValidAccessToken(clientId);
      if (!token) return;
      await fetch("https://api.spotify.com/v1/me/player/previous", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    }
  };

  if (!clientId) {
    return (
      <div className="setup">
        <p>
          Missing <code>client_id</code> parameter. Set your Spotify Client ID
          in the Pogly widget variables.
        </p>
      </div>
    );
  }

  if (!authed) {
    return (
      <div className="setup">
        <button
          className="auth-btn"
          onClick={() => redirectToSpotifyAuth(clientId)}
        >
          Connect Spotify
        </button>
        {error && <p className="error">{error}</p>}
        <p className="hint">
          You only need to do this once per browser. After connecting, the widget
          will remember your session.
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="setup">
        <p className="error">{error}</p>
        <button
          className="auth-btn"
          onClick={() => {
            logout();
            setAuthed(false);
            setError(null);
          }}
        >
          Reconnect
        </button>
      </div>
    );
  }

  return (
    <div
      className={`widget ${visible ? "visible" : "hidden"}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {nowPlaying && (
        <>
          <div className="album-art">
            <img src={nowPlaying.albumArt} alt={nowPlaying.albumName} />
            {hovered && (
              <button className="play-overlay" onClick={handleTogglePlay}>
                {isPlaying ? (
                  <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                    <rect x="6" y="4" width="4" height="16" rx="1" />
                    <rect x="14" y="4" width="4" height="16" rx="1" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="currentColor" width="28" height="28">
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>
            )}
          </div>
          <div className="track-info">
            <div className="track-name">{nowPlaying.trackName}</div>
            <div className="artist-name">{nowPlaying.artistName}</div>
            {hovered && (
              <div className="controls">
                <button className="ctrl-btn" onClick={handlePrev}>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                    <path d="M6 6h2v12H6zm3.5 6 8.5 6V6z" />
                  </svg>
                </button>
                <button className="ctrl-btn ctrl-play" onClick={handleTogglePlay}>
                  {isPlaying ? (
                    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                      <rect x="6" y="4" width="4" height="16" rx="1" />
                      <rect x="14" y="4" width="4" height="16" rx="1" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
                <button className="ctrl-btn" onClick={handleNext}>
                  <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                    <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
                  </svg>
                </button>
              </div>
            )}
            <div className="progress-bar">
              <div className="progress-fill" ref={progressRef} />
            </div>
            <div className="time-info">
              <span>{formatTime(nowPlaying.progressMs)}</span>
              <span>{formatTime(nowPlaying.durationMs)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function formatTime(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}
