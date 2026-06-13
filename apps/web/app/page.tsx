"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

type InterviewType = "dsa" | "system-design" | "machine-coding";
type Screen = "checking" | "login" | "home" | "starting" | "active" | "ended";
type Role = "assistant" | "user";
type SpeakerTarget = "interviewer" | "you";

interface InterviewOption {
  type: InterviewType;
  label: string;
  blurb: string;
}

interface TranscriptTurn {
  id: string;
  role: Role;
  text: string;
}

interface EndResponse {
  storage?: {
    jsonKey?: string;
    markdownKey?: string;
    lastError?: string;
  };
}

const API_BASE =
  process.env.NEXT_PUBLIC_API_BASE_URL?.replace(/\/$/, "") ??
  "http://localhost:8787";

const interviewOptions: InterviewOption[] = [
  {
    type: "dsa",
    label: "DSA",
    blurb:
      "Arrays, graphs, recursion and dynamic programming — reasoned out loud, against the clock.",
  },
  {
    type: "system-design",
    label: "System Design",
    blurb:
      "Architect at scale. Trade-offs, bottlenecks and back-of-the-envelope math.",
  },
  {
    type: "machine-coding",
    label: "Machine Coding",
    blurb:
      "Build a working module live. Clean abstractions, edge cases and tests.",
  },
];

export default function Home() {
  const [screen, setScreen] = useState<Screen>("checking");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("Checking session");
  const [activeInterview, setActiveInterview] =
    useState<InterviewOption | null>(null);
  const [interviewId, setInterviewId] = useState("");
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [livePartial, setLivePartial] = useState<TranscriptTurn | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [storageKeys, setStorageKeys] = useState<EndResponse["storage"]>();

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const partialsRef = useRef(new Map<string, string>());
  const interviewIdRef = useRef("");
  const endingRef = useRef(false);
  const finalizedRef = useRef(false);
  const endTimerRef = useRef<number | undefined>(undefined);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const interviewerTileRef = useRef<HTMLDivElement | null>(null);
  const youTileRef = useRef<HTMLDivElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const analysersRef = useRef<
    { analyser: AnalyserNode; target: SpeakerTarget }[]
  >([]);
  const rafRef = useRef<number | undefined>(undefined);
  const levelsRef = useRef<{ interviewer: number; you: number }>({
    interviewer: 0,
    you: 0,
  });

  useEffect(() => {
    void checkSession();

    return () => {
      cleanupCall();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Call duration timer.
  useEffect(() => {
    if (screen !== "active") {
      return;
    }

    const id = window.setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => window.clearInterval(id);
  }, [screen]);

  // Keep the transcript pinned to the latest line.
  useEffect(() => {
    const element = transcriptRef.current;

    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [turns, livePartial]);

  async function checkSession() {
    try {
      const response = await fetch(apiUrl("/api/session"), {
        credentials: "include",
      });
      const data = (await response.json()) as { authenticated?: boolean };

      setScreen(data.authenticated ? "home" : "login");
      setStatus(data.authenticated ? "Ready when you are" : "Login required");
    } catch {
      setScreen("login");
      setStatus("Server unavailable");
    }
  }

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    setStatus("Signing in");

    const response = await fetch(apiUrl("/api/login"), {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
    });

    if (!response.ok) {
      setError("Invalid password");
      setStatus("Login required");
      return;
    }

    setPassword("");
    setScreen("home");
    setStatus("Ready when you are");
  }

  async function logout() {
    await fetch(apiUrl("/api/logout"), {
      method: "POST",
      credentials: "include",
    });
    cleanupCall();
    resetInterviewState();
    setScreen("login");
    setStatus("Login required");
  }

  async function startInterview(option: InterviewOption) {
    setError("");
    setStorageKeys(undefined);
    setActiveInterview(option);
    setTurns([]);
    setLivePartial(null);
    setSeconds(0);
    setIsMuted(false);
    setScreen("starting");
    setStatus("Requesting microphone access");
    finalizedRef.current = false;
    endingRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      addStreamToVisualizer(stream, "you");

      const peer = new RTCPeerConnection();
      peerRef.current = peer;

      peer.ontrack = (event) => {
        if (!audioRef.current) {
          return;
        }

        const [remoteStream] = event.streams;

        if (remoteStream) {
          audioRef.current.srcObject = remoteStream;
          void audioRef.current.play().catch(() => undefined);
          addStreamToVisualizer(remoteStream, "interviewer");
        }
      };

      peer.onconnectionstatechange = () => {
        setStatus(connectionStatus(peer.connectionState));
      };

      for (const track of stream.getAudioTracks()) {
        peer.addTrack(track, stream);
      }

      const dataChannel = peer.createDataChannel("oai-events");
      dataChannelRef.current = dataChannel;
      dataChannel.addEventListener("open", () => {
        setStatus("Interviewer is joining");
        dataChannel.send(
          JSON.stringify({
            type: "response.create",
            response: {
              output_modalities: ["audio"],
              instructions:
                "Start the interview now with a short greeting and the first question.",
            },
          }),
        );
      });
      dataChannel.addEventListener("message", handleRealtimeMessage);
      dataChannel.addEventListener("close", () => {
        if (!endingRef.current && !finalizedRef.current) {
          setStatus("Connection closed");
        }
      });

      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);

      setStatus("Creating realtime session");
      const response = await fetch(
        apiUrl(`/api/realtime/session?type=${option.type}`),
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/sdp" },
          body: offer.sdp ?? "",
        },
      );

      if (response.status === 401) {
        setScreen("login");
        throw new Error("Session expired. Please log in again.");
      }

      const answerSdp = await response.text();

      if (!response.ok) {
        throw new Error(answerSdp || "Failed to start interview");
      }

      const id = response.headers.get("X-Interview-Id") ?? "";
      setInterviewId(id);
      interviewIdRef.current = id;

      await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });
      setScreen("active");
      setStatus("Connected");
    } catch (startError) {
      cleanupCall();
      setScreen("home");
      setStatus("Ready when you are");
      setError(
        startError instanceof Error
          ? startError.message
          : "Failed to start interview",
      );
    }
  }

  function handleRealtimeMessage(event: MessageEvent<string>) {
    let payload: Record<string, unknown>;

    try {
      payload = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return;
    }

    const eventType = stringValue(payload.type);

    if (eventType === "input_audio_buffer.speech_started") {
      setStatus("Listening to you");
    }

    if (eventType === "input_audio_buffer.speech_stopped") {
      setStatus("Thinking");
    }

    if (eventType === "response.created") {
      setStatus("Interviewer speaking");
    }

    if (eventType === "response.done") {
      setStatus(endingRef.current ? "Saving transcript" : "Listening to you");

      if (endingRef.current) {
        window.setTimeout(() => {
          void finalizeInterview();
        }, 1200);
      }
    }

    ingestTranscriptEvent(payload);
  }

  function ingestTranscriptEvent(payload: Record<string, unknown>) {
    const eventType = stringValue(payload.type);

    if (eventType === "conversation.item.input_audio_transcription.delta") {
      addPartial("user", payload, stringValue(payload.delta));
      return;
    }

    if (eventType === "conversation.item.input_audio_transcription.completed") {
      appendTurn(
        "user",
        stringValue(payload.transcript) || takePartial("user", payload),
      );
      return;
    }

    if (
      eventType === "response.output_audio_transcript.delta" ||
      eventType === "response.audio_transcript.delta"
    ) {
      addPartial("assistant", payload, stringValue(payload.delta));
      return;
    }

    if (
      eventType === "response.output_audio_transcript.done" ||
      eventType === "response.audio_transcript.done"
    ) {
      appendTurn(
        "assistant",
        stringValue(payload.transcript) || takePartial("assistant", payload),
      );
    }
  }

  function addPartial(
    role: Role,
    payload: Record<string, unknown>,
    delta: string,
  ) {
    if (!delta) {
      return;
    }

    const key = partialKey(role, payload);
    const nextText = `${partialsRef.current.get(key) ?? ""}${delta}`;
    partialsRef.current.set(key, nextText);
    setLivePartial({
      id: key,
      role,
      text: nextText,
    });
  }

  function takePartial(role: Role, payload: Record<string, unknown>): string {
    const key = partialKey(role, payload);
    const text = partialsRef.current.get(key) ?? "";
    partialsRef.current.delete(key);
    return text;
  }

  function appendTurn(role: Role, text: string) {
    const normalized = text.trim();

    if (!normalized) {
      return;
    }

    setTurns((current) => [
      ...current,
      {
        id: crypto.randomUUID(),
        role,
        text: normalized,
      },
    ]);
    setLivePartial(null);
  }

  function toggleMute() {
    const nextMuted = !isMuted;
    setIsMuted(nextMuted);

    for (const track of streamRef.current?.getAudioTracks() ?? []) {
      track.enabled = !nextMuted;
    }
  }

  async function requestEndInterview() {
    if (isEnding) {
      return;
    }

    setIsEnding(true);
    endingRef.current = true;
    setStatus("Asking for final feedback");

    const dataChannel = dataChannelRef.current;

    if (dataChannel?.readyState === "open") {
      dataChannel.send(
        JSON.stringify({
          type: "response.create",
          response: {
            output_modalities: ["audio"],
            instructions:
              "The candidate clicked End Interview. Give concise final feedback in under one minute, then stop.",
          },
        }),
      );

      endTimerRef.current = window.setTimeout(() => {
        void finalizeInterview();
      }, 12000);
      return;
    }

    await finalizeInterview();
  }

  async function finalizeInterview() {
    if (finalizedRef.current) {
      return;
    }

    finalizedRef.current = true;

    if (endTimerRef.current) {
      window.clearTimeout(endTimerRef.current);
      endTimerRef.current = undefined;
    }

    setStatus("Saving transcript");
    cleanupCall();

    const id = interviewIdRef.current;

    if (id) {
      try {
        const response = await fetch(apiUrl(`/api/interviews/${id}/end`), {
          method: "POST",
          credentials: "include",
        });
        const data = (await response.json()) as EndResponse;
        setStorageKeys(data.storage);
      } catch {
        setError("Call ended, but transcript finalization failed.");
      }
    }

    setScreen("ended");
    setStatus("Interview ended");
    setIsEnding(false);
  }

  function cleanupCall() {
    stopVisualizer();

    dataChannelRef.current?.close();
    dataChannelRef.current = null;
    peerRef.current?.close();
    peerRef.current = null;

    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }

    streamRef.current = null;

    if (audioRef.current) {
      audioRef.current.srcObject = null;
    }
  }

  function resetInterviewState() {
    setActiveInterview(null);
    setInterviewId("");
    interviewIdRef.current = "";
    setTurns([]);
    setLivePartial(null);
    setStorageKeys(undefined);
    setIsMuted(false);
    setIsEnding(false);
    setSeconds(0);
    endingRef.current = false;
    finalizedRef.current = false;
    partialsRef.current.clear();
  }

  /* ----------------------- Audio visualizer ----------------------- */

  function addStreamToVisualizer(stream: MediaStream, target: SpeakerTarget) {
    try {
      const Ctx =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;

      if (!Ctx) {
        return;
      }

      if (!audioCtxRef.current) {
        audioCtxRef.current = new Ctx();
      }

      const ctx = audioCtxRef.current;
      void ctx.resume();

      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.78;
      source.connect(analyser);
      analysersRef.current.push({ analyser, target });

      startVisualizerLoop();
    } catch {
      // Visualizer is a non-critical enhancement; never break the call.
    }
  }

  function startVisualizerLoop() {
    if (rafRef.current !== undefined) {
      return;
    }

    const tick = () => {
      const peaks: Record<SpeakerTarget, number> = { interviewer: 0, you: 0 };

      for (const { analyser, target } of analysersRef.current) {
        const data = new Uint8Array(analyser.frequencyBinCount);
        analyser.getByteTimeDomainData(data);

        let sum = 0;
        for (let i = 0; i < data.length; i += 1) {
          const v = (data[i]! - 128) / 128;
          sum += v * v;
        }

        const rms = Math.sqrt(sum / data.length);
        peaks[target] = Math.max(peaks[target], Math.min(1, rms * 3.4));
      }

      const prev = levelsRef.current;
      const next = {
        interviewer: prev.interviewer * 0.8 + peaks.interviewer * 0.2,
        you: prev.you * 0.8 + peaks.you * 0.2,
      };
      levelsRef.current = next;

      applyTile(
        interviewerTileRef.current,
        next.interviewer,
        next.interviewer > 0.08 && next.interviewer >= next.you,
      );
      applyTile(
        youTileRef.current,
        next.you,
        next.you > 0.08 && next.you > next.interviewer,
      );

      rafRef.current = window.requestAnimationFrame(tick);
    };

    rafRef.current = window.requestAnimationFrame(tick);
  }

  function applyTile(
    element: HTMLDivElement | null,
    level: number,
    speaking: boolean,
  ) {
    if (!element) {
      return;
    }

    element.style.setProperty("--level", level.toFixed(3));
    element.dataset.speaking = speaking ? "true" : "false";
  }

  function stopVisualizer() {
    if (rafRef.current !== undefined) {
      window.cancelAnimationFrame(rafRef.current);
      rafRef.current = undefined;
    }

    analysersRef.current = [];
    levelsRef.current = { interviewer: 0, you: 0 };
    applyTile(interviewerTileRef.current, 0, false);
    applyTile(youTileRef.current, 0, false);

    if (audioCtxRef.current) {
      void audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
  }

  const inCall = screen === "starting" || screen === "active";
  const isLive = screen === "active";

  return (
    <main className={styles.page}>
      <section
        className={`${styles.shell} ${inCall ? styles.shellCall : ""}`.trim()}
      >
        {!inCall ? (
          <div className={styles.topBar}>
            <div className={styles.brand}>
              <span className={styles.mark}>
                <BrandMark />
              </span>
              <div>
                <p className={styles.eyebrow}>Voice Practice Studio</p>
                <h1>Simple Interview</h1>
              </div>
            </div>
            {screen !== "login" && screen !== "checking" ? (
              <button
                className={styles.linkButton}
                onClick={logout}
                type="button"
              >
                Sign out
              </button>
            ) : null}
          </div>
        ) : null}

        {!inCall && screen !== "ended" ? (
          <p className={styles.status}>
            <span className={styles.statusDot} />
            {status}
          </p>
        ) : null}

        {error ? <p className={styles.error}>{error}</p> : null}

        {screen === "checking" ? (
          <div className={styles.centerState}>
            <span className={styles.spinner} />
            Checking your session…
          </div>
        ) : null}

        {screen === "login" ? (
          <div className={styles.loginWrap}>
            <div className={styles.loginHead}>
              <h2>
                Practice until it&apos;s <em>second nature.</em>
              </h2>
              <p>
                A calm, voice-only room where an AI interviewer asks, listens
                and pushes back — just like the real thing.
              </p>
            </div>
            <form className={styles.loginForm} onSubmit={login}>
              <label className={styles.fieldLabel} htmlFor="password">
                Access password
              </label>
              <input
                id="password"
                autoFocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                type="password"
                placeholder="Enter app password"
              />
              <button className={styles.primaryButton} type="submit">
                Enter the studio
              </button>
            </form>
          </div>
        ) : null}

        {screen === "home" ? (
          <>
            <div className={styles.homeIntro}>
              <h2>Choose your round.</h2>
              <p>
                Pick a format and start talking. You can mute or end the call at
                any time — the full transcript is saved when you finish.
              </p>
            </div>
            <div className={styles.optionGrid}>
              {interviewOptions.map((option, index) => (
                <button
                  className={styles.optionButton}
                  key={option.type}
                  onClick={() => void startInterview(option)}
                  type="button"
                >
                  <span className={styles.optionIndex}>
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <h3>{option.label}</h3>
                  <p className={styles.optionBlurb}>{option.blurb}</p>
                  <span className={styles.optionArrow}>
                    <ArrowIcon />
                  </span>
                </button>
              ))}
            </div>
          </>
        ) : null}

        {inCall ? (
          <div className={styles.room}>
            <div className={styles.roomTop}>
              <div className={styles.roomTopLeft}>
                <span className={styles.recBar} data-state={isLive ? "live" : "connecting"}>
                  <span className={styles.recDot} />
                  {isLive ? "Live" : "Connecting"}
                  <span className={styles.recTime}>{formatTime(seconds)}</span>
                </span>
                <span className={styles.roomTitle}>
                  {activeInterview?.label ?? "Interview"} round
                </span>
              </div>
              <span className={styles.phaseLabel}>{status}</span>
            </div>

            <div className={styles.roomBody}>
              <div className={styles.tiles}>
                <div
                  className={`${styles.tile} ${styles.tileInterviewer}`}
                  data-speaking="false"
                  ref={interviewerTileRef}
                >
                  <span className={styles.tileBadge}>AI Interviewer</span>
                  <div className={styles.orb}>
                    <span className={styles.orbGlow} />
                    <span className={styles.orbRing} />
                    <span className={styles.orbPulse} />
                    <span className={styles.orbCore} />
                  </div>
                  <div className={styles.nameplate}>
                    <span className={styles.nameplateIcon}>
                      <BotIcon />
                    </span>
                    Interviewer
                    <span className={styles.eq}>
                      <span />
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                </div>

                <div
                  className={`${styles.tile} ${styles.tileYou}`}
                  data-speaking="false"
                  data-muted={isMuted ? "true" : "false"}
                  ref={youTileRef}
                >
                  <span className={styles.tileBadge}>You</span>
                  <div className={styles.orb}>
                    <span className={styles.orbGlow} />
                    <span className={styles.orbRing} />
                    <span className={styles.orbPulse} />
                    <span className={styles.orbCore} />
                  </div>
                  <div className={styles.nameplate}>
                    <span className={styles.nameplateIcon}>
                      {isMuted ? <MicOffIcon /> : <MicIcon />}
                    </span>
                    {isMuted ? "Muted" : "You"}
                    <span className={styles.eq}>
                      <span />
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                </div>
              </div>

              <div className={styles.captions}>
                <div className={styles.captionsHead}>
                  <span>
                    <span className={styles.liveDot} />
                    Live transcript
                  </span>
                  {interviewId ? <span>{shortId(interviewId)}</span> : null}
                </div>
                <div className={styles.transcript} ref={transcriptRef}>
                  {turns.length === 0 && !livePartial ? (
                    <p className={styles.emptyTranscript}>
                      The conversation will appear here, word by word, as you
                      both speak.
                    </p>
                  ) : null}
                  {turns.map((turn) => (
                    <TranscriptLine key={turn.id} turn={turn} />
                  ))}
                  {livePartial ? (
                    <TranscriptLine isLive key={livePartial.id} turn={livePartial} />
                  ) : null}
                </div>
              </div>
            </div>

            <div className={styles.dock}>
              <button
                className={styles.ctrlBtn}
                data-on={isMuted ? "muted" : "live"}
                onClick={toggleMute}
                type="button"
              >
                <span className={styles.ctrlIcon}>
                  {isMuted ? <MicOffIcon /> : <MicIcon />}
                </span>
                {isMuted ? "Unmute" : "Mute"}
              </button>
              <button
                className={`${styles.ctrlBtn} ${styles.ctrlEnd}`}
                disabled={isEnding}
                onClick={() => void requestEndInterview()}
                type="button"
              >
                <span className={styles.ctrlIcon}>
                  <HangupIcon />
                </span>
                {isEnding ? "Ending…" : "End"}
              </button>
            </div>
          </div>
        ) : null}

        {screen === "ended" ? (
          <div className={styles.ended}>
            <span className={styles.endedIcon}>
              <CheckIcon />
            </span>
            <h2>That&apos;s a wrap.</h2>
            <p>
              Your transcript has been finalized and saved on the server. Take a
              breath — then go again.
            </p>
            <div className={styles.summary}>
              <div className={styles.stat}>
                <span className={styles.statNum}>{turns.length}</span>
                <span className={styles.statLabel}>Exchanges</span>
              </div>
              <div className={styles.stat}>
                <span className={styles.statNum}>{formatTime(seconds)}</span>
                <span className={styles.statLabel}>Duration</span>
              </div>
            </div>
            {storageKeys?.jsonKey ? (
              <div className={styles.receipt}>
                <div>
                  <span>JSON transcript</span>
                  <p>{storageKeys.jsonKey}</p>
                </div>
                <div>
                  <span>Markdown transcript</span>
                  <p>{storageKeys.markdownKey}</p>
                </div>
              </div>
            ) : null}
            {storageKeys?.lastError ? (
              <p className={styles.error}>
                R2 upload error: {storageKeys.lastError}
              </p>
            ) : null}
            <button
              className={styles.primaryButton}
              onClick={() => {
                resetInterviewState();
                setScreen("home");
                setStatus("Ready when you are");
              }}
              type="button"
            >
              Start another interview
            </button>
          </div>
        ) : null}

        <audio ref={audioRef} autoPlay className={styles.remoteAudio}>
          <track kind="captions" />
        </audio>
      </section>
    </main>
  );
}

function TranscriptLine({
  turn,
  isLive = false,
}: {
  turn: TranscriptTurn;
  isLive?: boolean;
}) {
  const isInterviewer = turn.role === "assistant";

  return (
    <article
      className={`${styles.turn} ${
        isInterviewer ? styles.turnInterviewer : styles.turnUser
      } ${isLive ? styles.turnLive : ""}`.trim()}
    >
      <span className={styles.turnRole}>
        <span className={styles.roleDot} />
        {isInterviewer ? "Interviewer" : "You"}
      </span>
      <p className={styles.bubble}>
        {turn.text}
        {isLive ? <span className={styles.caret} /> : null}
      </p>
    </article>
  );
}

/* ------------------------------ Icons ------------------------------ */

function BrandMark() {
  return (
    <svg width="24" height="24" viewBox="0 0 30 30" fill="none" aria-hidden>
      <circle cx="15" cy="15" r="3.2" fill="currentColor" />
      <path
        d="M9.5 9.5a8 8 0 0 0 0 11M20.5 9.5a8 8 0 0 1 0 11"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
      <path
        d="M6 6a13 13 0 0 0 0 18M24 6a13 13 0 0 1 0 18"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        opacity="0.5"
      />
    </svg>
  );
}

function ArrowIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 12h14M13 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M6 11a6 6 0 0 0 12 0M12 17v3.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9 9v2a3 3 0 0 0 4.5 2.6M15 11.2V6a3 3 0 0 0-5.6-1.5"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M6 11a6 6 0 0 0 9 5.2M12 17v3.5M4 4l16 16"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function HangupIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M3.5 14.5c4.7-4 12.3-4 17 0l-2 2.3c-.5.6-1.4.7-2 .2l-2-1.5a1.4 1.4 0 0 1-.5-1.5l.3-1.1c-1.8-.5-3.8-.5-5.6 0l.3 1.1c.2.6 0 1.2-.5 1.5l-2 1.5c-.6.5-1.5.4-2-.2l-2-2.3Z"
        fill="currentColor"
      />
    </svg>
  );
}

function BotIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect
        x="4"
        y="8"
        width="16"
        height="11"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path d="M12 4v4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
      <circle cx="9.5" cy="13.5" r="1.3" fill="currentColor" />
      <circle cx="14.5" cy="13.5" r="1.3" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M5 12.5l4.5 4.5L19 7"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ----------------------------- Helpers ----------------------------- */

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
}

function formatTime(total: number): string {
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
}

function shortId(id: string): string {
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

function partialKey(role: Role, payload: Record<string, unknown>): string {
  return [
    role,
    stringValue(payload.response_id),
    stringValue(payload.item_id),
    stringValue(payload.output_index),
    stringValue(payload.content_index),
  ]
    .filter(Boolean)
    .join(":");
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number") {
    return String(value);
  }

  return "";
}

function connectionStatus(state: RTCPeerConnectionState): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "disconnected":
      return "Disconnected";
    case "failed":
      return "Connection failed";
    case "closed":
      return "Connection closed";
    default:
      return "Starting";
  }
}
