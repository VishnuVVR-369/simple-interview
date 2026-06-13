"use client";

import { FormEvent, useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

type InterviewType = "dsa" | "system-design" | "machine-coding";
type Screen = "checking" | "login" | "home" | "starting" | "active" | "ended";
type Role = "assistant" | "user";

interface InterviewOption {
  type: InterviewType;
  label: string;
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
  { type: "dsa", label: "DSA Interview" },
  { type: "system-design", label: "System Design Interview" },
  { type: "machine-coding", label: "Machine Coding Interview" },
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

  useEffect(() => {
    void checkSession();

    return () => {
      cleanupCall();
    };
  }, []);

  async function checkSession() {
    try {
      const response = await fetch(apiUrl("/api/session"), {
        credentials: "include",
      });
      const data = (await response.json()) as { authenticated?: boolean };

      setScreen(data.authenticated ? "home" : "login");
      setStatus(data.authenticated ? "Ready" : "Login required");
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
    setStatus("Ready");
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
    setScreen("starting");
    setStatus("Requesting microphone access");
    finalizedRef.current = false;
    endingRef.current = false;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

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
        setStatus("Interviewer is starting");
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
      setStatus("Ready");
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
      setStatus("Listening");
    }

    if (eventType === "input_audio_buffer.speech_stopped") {
      setStatus("Thinking");
    }

    if (eventType === "response.created") {
      setStatus("Interviewer speaking");
    }

    if (eventType === "response.done") {
      setStatus(endingRef.current ? "Saving transcript" : "Listening");

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
    endingRef.current = false;
    finalizedRef.current = false;
    partialsRef.current.clear();
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <div className={styles.topBar}>
          <div>
            <p className={styles.eyebrow}>Realtime Interview</p>
            <h1>Simple Interview</h1>
          </div>
          {screen !== "login" && screen !== "checking" ? (
            <button
              className={styles.linkButton}
              onClick={logout}
              type="button"
            >
              Logout
            </button>
          ) : null}
        </div>

        <p className={styles.status}>{status}</p>
        {error ? <p className={styles.error}>{error}</p> : null}

        {screen === "checking" ? (
          <div className={styles.centerState}>Checking your session...</div>
        ) : null}

        {screen === "login" ? (
          <form className={styles.loginForm} onSubmit={login}>
            <label htmlFor="password">Password</label>
            <input
              id="password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              placeholder="Enter app password"
            />
            <button className={styles.primaryButton} type="submit">
              Enter
            </button>
          </form>
        ) : null}

        {screen === "home" ? (
          <div className={styles.optionGrid}>
            {interviewOptions.map((option) => (
              <button
                className={styles.optionButton}
                key={option.type}
                onClick={() => void startInterview(option)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
        ) : null}

        {screen === "starting" || screen === "active" ? (
          <div className={styles.callLayout}>
            <div className={styles.callHeader}>
              <div>
                <p className={styles.eyebrow}>Active Call</p>
                <h2>{activeInterview?.label ?? "Interview"}</h2>
                {interviewId ? (
                  <p className={styles.callId}>Call ID: {interviewId}</p>
                ) : null}
              </div>
              <div className={styles.controls}>
                <button
                  className={styles.secondaryButton}
                  onClick={toggleMute}
                  type="button"
                >
                  {isMuted ? "Unmute" : "Mute"}
                </button>
                <button
                  className={styles.dangerButton}
                  disabled={isEnding}
                  onClick={() => void requestEndInterview()}
                  type="button"
                >
                  {isEnding ? "Ending..." : "End Interview"}
                </button>
              </div>
            </div>

            <div className={styles.transcript}>
              {[...turns, ...(livePartial ? [livePartial] : [])].length ===
              0 ? (
                <p className={styles.emptyTranscript}>
                  Transcript will appear once the conversation starts.
                </p>
              ) : null}
              {turns.map((turn) => (
                <TranscriptLine key={turn.id} turn={turn} />
              ))}
              {livePartial ? (
                <TranscriptLine
                  isLive
                  key={livePartial.id}
                  turn={livePartial}
                />
              ) : null}
            </div>
          </div>
        ) : null}

        {screen === "ended" ? (
          <div className={styles.endedState}>
            <h2>Interview ended</h2>
            <p>The transcript has been finalized on the server.</p>
            {storageKeys?.jsonKey ? (
              <div className={styles.storage}>
                <p>JSON: {storageKeys.jsonKey}</p>
                <p>Markdown: {storageKeys.markdownKey}</p>
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
                setStatus("Ready");
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
  return (
    <article className={styles.turn}>
      <span className={styles.turnRole}>
        {turn.role === "assistant" ? "Interviewer" : "You"}
        {isLive ? " speaking" : ""}
      </span>
      <p>{turn.text}</p>
    </article>
  );
}

function apiUrl(path: string): string {
  return `${API_BASE}${path}`;
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
