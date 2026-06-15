import WebSocket from "ws";
import {
  ACTIVE_AI_CONFIG,
  INTERVIEW_LABELS,
  buildRealtimeSessionConfig,
  type InterviewType,
  type QuestionSettings,
} from "@repo/ai-config/prompts";
import {
  createInitialWorkspace,
  normalizeWorkspace,
  renderWorkspaceForModel,
  summarizeWorkspace,
  type InterviewWorkspace,
  type WorkspaceSyncReason,
} from "@repo/ai-config/workspace";
import type { AppConfig } from "./env";
import { generateEvaluation } from "./evaluation";
import { persistTranscript } from "./storage";
import { ingestRealtimeEvent } from "./transcript";
import type { InterviewSession } from "./types";

const sessions = new Map<string, InterviewSession>();
const persistQueues = new Map<string, Promise<void>>();

export async function createRealtimeInterview(
  interviewType: InterviewType,
  questionSettings: QuestionSettings,
  sdp: string,
  config: AppConfig,
): Promise<{ sdp: string; session: InterviewSession }> {
  const fd = new FormData();
  fd.set("sdp", sdp);
  fd.set(
    "session",
    JSON.stringify(buildRealtimeSessionConfig(interviewType, questionSettings)),
  );

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
  const session = createSession(callId, interviewType, questionSettings, now);
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
  session.evaluation = await generateEvaluation(session, config);

  if (session.evaluation) {
    await enqueuePersist(session, config);
  }
}

export function updateInterviewWorkspace(
  session: InterviewSession,
  workspace: unknown,
  reason: WorkspaceSyncReason = "client_sync",
): InterviewWorkspace {
  const normalized = normalizeWorkspace(workspace, session.type);
  const now = new Date().toISOString();
  session.workspace = {
    ...normalized,
    updatedAt: now,
  } as InterviewWorkspace;
  session.updatedAt = now;
  recordWorkspaceEvent(session, reason);

  return session.workspace;
}

export function shareWorkspaceWithInterviewer(
  session: InterviewSession,
  reason = "The candidate shared their workspace with you.",
): boolean {
  const ws = session.sideband;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  recordWorkspaceEvent(session, "manual_share");
  sendWorkspaceContextItem(session, reason);
  ws.send(
    JSON.stringify({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions:
          "Use the newly shared workspace context if it is relevant. Give concise interviewer feedback or ask the next focused question.",
      },
    }),
  );

  return true;
}

function createSession(
  callId: string,
  interviewType: InterviewType,
  questionSettings: QuestionSettings,
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
    model: ACTIVE_AI_CONFIG.realtimeModel,
    voice: ACTIVE_AI_CONFIG.voice,
    question: questionSettings,
    status: "created",
    createdAt: timestamp,
    updatedAt: timestamp,
    transcriptKeyPrefix: `transcripts/${interviewType}/${datePart}/${safeTimestamp}-${callId}`,
    sequence: 0,
    turns: [],
    rawTranscriptEvents: [],
    workspace: createInitialWorkspace(interviewType),
    workspaceEvents: [],
    workspaceSequence: 0,
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
    handleWorkspaceToolCalls(session, event, ws);

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

function handleWorkspaceToolCalls(
  session: InterviewSession,
  event: unknown,
  ws: WebSocket,
): void {
  if (!isRecord(event) || event.type !== "response.done") {
    return;
  }

  const response = event.response;

  if (!isRecord(response) || !Array.isArray(response.output)) {
    return;
  }

  for (const output of response.output) {
    if (
      !isRecord(output) ||
      output.type !== "function_call" ||
      output.name !== "get_workspace_context" ||
      typeof output.call_id !== "string"
    ) {
      continue;
    }

    recordWorkspaceEvent(session, "tool_read");

    ws.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: output.call_id,
          output: JSON.stringify({
            ok: true,
            focus: parseWorkspaceFocus(output.arguments),
            context: renderWorkspaceForModel(session.workspace, session.type),
          }),
        },
      }),
    );
    ws.send(
      JSON.stringify({
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions:
            "Use the workspace context to continue the interview. Be concise and ask one focused follow-up.",
        },
      }),
    );
  }
}

function sendWorkspaceContextItem(
  session: InterviewSession,
  reason: string,
): void {
  const ws = session.sideband;

  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(
    JSON.stringify({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: [
              reason,
              "",
              renderWorkspaceForModel(session.workspace, session.type),
            ].join("\n"),
          },
        ],
      },
    }),
  );
}

function recordWorkspaceEvent(
  session: InterviewSession,
  reason: WorkspaceSyncReason,
): void {
  const now = new Date().toISOString();
  session.workspaceSequence += 1;
  session.workspaceEvents.push({
    sequence: session.workspaceSequence,
    type: reason,
    summary: summarizeWorkspace(session.workspace, session.type),
    createdAt: now,
  });

  if (session.workspaceEvents.length > 200) {
    session.workspaceEvents.splice(0, session.workspaceEvents.length - 200);
  }
}

function parseWorkspaceFocus(argumentsJson: unknown): string {
  if (typeof argumentsJson !== "string") {
    return "all";
  }

  try {
    const parsed = JSON.parse(argumentsJson) as unknown;

    if (isRecord(parsed) && typeof parsed.focus === "string") {
      return parsed.focus;
    }
  } catch {
    return "all";
  }

  return "all";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
