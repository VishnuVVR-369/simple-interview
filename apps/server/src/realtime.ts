import WebSocket from "ws";
import type { AppConfig } from "./env";
import { INTERVIEW_LABELS, buildInterviewInstructions } from "./prompts";
import { persistTranscript } from "./storage";
import { ingestRealtimeEvent } from "./transcript";
import type { InterviewSession, InterviewType } from "./types";

const REALTIME_MODEL = "gpt-realtime-2";
const REALTIME_VOICE = "marin";

const sessions = new Map<string, InterviewSession>();
const persistQueues = new Map<string, Promise<void>>();

export async function createRealtimeInterview(
  interviewType: InterviewType,
  sdp: string,
  config: AppConfig,
): Promise<{ sdp: string; session: InterviewSession }> {
  const fd = new FormData();
  fd.set("sdp", sdp);
  fd.set("session", JSON.stringify(buildSessionConfig(interviewType)));

  const response = await fetch("https://api.openai.com/v1/realtime/calls", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openAiApiKey}`,
      "OpenAI-Safety-Identifier": "simple-interview-owner",
    },
    body: fd,
  });
  const answerSdp = await response.text();

  if (!response.ok) {
    throw new Error(
      `OpenAI Realtime call creation failed (${response.status}): ${answerSdp}`,
    );
  }

  const callId = extractCallId(response.headers.get("location"));

  if (!callId) {
    throw new Error("OpenAI Realtime call response did not include a call ID");
  }

  const now = new Date();
  const session = createSession(callId, interviewType, now);
  sessions.set(session.id, session);
  connectSideband(session, config);

  return { sdp: answerSdp, session };
}

export function getInterviewSession(
  id: string | undefined,
): InterviewSession | undefined {
  if (!id) {
    return undefined;
  }

  return sessions.get(id);
}

export async function endInterviewSession(
  session: InterviewSession,
  config: AppConfig,
): Promise<void> {
  if (session.status === "ended") {
    return;
  }

  const now = new Date().toISOString();
  session.status = "ended";
  session.endedAt = now;
  session.updatedAt = now;

  if (session.sideband?.readyState === WebSocket.OPEN) {
    session.sideband.close(1000, "Interview ended");
  }

  await enqueuePersist(session, config);
}

function buildSessionConfig(interviewType: InterviewType) {
  return {
    type: "realtime",
    model: REALTIME_MODEL,
    instructions: buildInterviewInstructions(interviewType),
    output_modalities: ["audio"],
    audio: {
      input: {
        transcription: {
          model: "gpt-realtime-whisper",
          language: "en",
        },
        turn_detection: {
          type: "semantic_vad",
        },
      },
      output: {
        voice: REALTIME_VOICE,
      },
    },
    reasoning: {
      effort: "low",
    },
  };
}

function createSession(
  callId: string,
  interviewType: InterviewType,
  now: Date,
): InterviewSession {
  const timestamp = now.toISOString();
  const datePart = timestamp.slice(0, 10);
  const safeTimestamp = timestamp.replace(/[:.]/g, "-");

  return {
    id: callId,
    callId,
    type: interviewType,
    label: INTERVIEW_LABELS[interviewType],
    model: REALTIME_MODEL,
    voice: REALTIME_VOICE,
    status: "created",
    createdAt: timestamp,
    updatedAt: timestamp,
    transcriptKeyPrefix: `transcripts/${interviewType}/${datePart}/${safeTimestamp}-${callId}`,
    sequence: 0,
    turns: [],
    rawTranscriptEvents: [],
    partials: new Map(),
    storage: {},
  };
}

function connectSideband(session: InterviewSession, config: AppConfig): void {
  const url = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(
    session.callId,
  )}`;
  const ws = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${config.openAiApiKey}`,
    },
  });
  session.sideband = ws;

  ws.on("open", () => {
    session.status = "sideband_connected";
    session.updatedAt = new Date().toISOString();
  });

  ws.on("message", (message) => {
    let event: unknown;

    try {
      event = JSON.parse(message.toString());
    } catch {
      return;
    }

    const turn = ingestRealtimeEvent(session, event);

    if (turn) {
      session.status = "active";
      void enqueuePersist(session, config).catch((error) => {
        console.error("Failed to persist transcript turn", error);
      });
    }
  });

  ws.on("close", () => {
    if (session.status !== "ended" && session.status !== "error") {
      session.status = "ending";
      session.updatedAt = new Date().toISOString();
      void enqueuePersist(session, config).catch((error) => {
        console.error(
          "Failed to persist transcript after sideband close",
          error,
        );
      });
    }
  });

  ws.on("error", (error) => {
    session.status = "error";
    session.storage.lastError = error.message;
    session.updatedAt = new Date().toISOString();
    console.error("Sideband WebSocket error", error);
  });
}

function extractCallId(location: string | null): string | undefined {
  if (!location) {
    return undefined;
  }

  return location.split("/").filter(Boolean).pop();
}

function enqueuePersist(
  session: InterviewSession,
  config: AppConfig,
): Promise<void> {
  const previous = persistQueues.get(session.id) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => persistTranscript(session, config));

  persistQueues.set(session.id, next);
  return next;
}
