import type {
  InterviewSession,
  PublicInterviewSession,
  TranscriptRole,
  TranscriptTurn,
} from "./types";

const USER_DELTA = "conversation.item.input_audio_transcription.delta";
const USER_DONE = "conversation.item.input_audio_transcription.completed";
const ASSISTANT_DELTA = "response.output_audio_transcript.delta";
const ASSISTANT_DONE = "response.output_audio_transcript.done";

const LEGACY_ASSISTANT_DELTA = "response.audio_transcript.delta";
const LEGACY_ASSISTANT_DONE = "response.audio_transcript.done";

export function toPublicSession(
  session: InterviewSession,
): PublicInterviewSession {
  return {
    id: session.id,
    callId: session.callId,
    type: session.type,
    label: session.label,
    model: session.model,
    voice: session.voice,
    question: session.question,
    status: session.status,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    endedAt: session.endedAt,
    turns: session.turns,
    storage: session.storage,
    evaluation: session.evaluation,
  };
}

export function ingestRealtimeEvent(
  session: InterviewSession,
  event: unknown,
): TranscriptTurn | undefined {
  if (!isRecord(event) || typeof event.type !== "string") {
    return undefined;
  }

  const type = event.type;

  if (!isTranscriptEvent(type, event)) {
    return undefined;
  }

  const sequence = nextSequence(session);
  const receivedAt = new Date().toISOString();
  session.rawTranscriptEvents.push({
    sequence,
    receivedAt,
    type,
    event,
  });

  if (type === USER_DELTA) {
    addPartial(session, partialKey("user", event), stringValue(event.delta));
    return undefined;
  }

  if (type === USER_DONE) {
    return appendTurn(session, {
      sequence,
      role: "user",
      text:
        stringValue(event.transcript) ||
        takePartial(session, partialKey("user", event)),
      itemId: stringValue(event.item_id),
      eventType: type,
      createdAt: receivedAt,
    });
  }

  if (type === ASSISTANT_DELTA || type === LEGACY_ASSISTANT_DELTA) {
    addPartial(
      session,
      partialKey("assistant", event),
      stringValue(event.delta),
    );
    return undefined;
  }

  if (type === ASSISTANT_DONE || type === LEGACY_ASSISTANT_DONE) {
    return appendTurn(session, {
      sequence,
      role: "assistant",
      text:
        stringValue(event.transcript) ||
        takePartial(session, partialKey("assistant", event)),
      itemId: stringValue(event.item_id),
      responseId: stringValue(event.response_id),
      eventType: type,
      createdAt: receivedAt,
    });
  }

  return undefined;
}

function isTranscriptEvent(
  type: string,
  event: Record<string, unknown>,
): boolean {
  if (
    type === USER_DELTA ||
    type === USER_DONE ||
    type === ASSISTANT_DELTA ||
    type === ASSISTANT_DONE ||
    type === LEGACY_ASSISTANT_DELTA ||
    type === LEGACY_ASSISTANT_DONE
  ) {
    return true;
  }

  return typeof event.transcript === "string" && type.includes("transcript");
}

function appendTurn(
  session: InterviewSession,
  turn: Omit<TranscriptTurn, "text"> & { text: string },
): TranscriptTurn | undefined {
  const text = turn.text.trim();

  if (!text) {
    return undefined;
  }

  const normalizedTurn = {
    ...turn,
    text,
  };
  session.turns.push(normalizedTurn);
  session.updatedAt = normalizedTurn.createdAt;

  return normalizedTurn;
}

function partialKey(
  role: TranscriptRole,
  event: Record<string, unknown>,
): string {
  const itemId = stringValue(event.item_id);
  const responseId = stringValue(event.response_id);
  const contentIndex = stringValue(event.content_index);
  const outputIndex = stringValue(event.output_index);

  return [role, responseId, itemId, outputIndex, contentIndex]
    .filter(Boolean)
    .join(":");
}

function addPartial(
  session: InterviewSession,
  key: string,
  value: string,
): void {
  if (!value) {
    return;
  }

  session.partials.set(key, `${session.partials.get(key) ?? ""}${value}`);
}

function takePartial(session: InterviewSession, key: string): string {
  const value = session.partials.get(key) ?? "";
  session.partials.delete(key);
  return value;
}

function nextSequence(session: InterviewSession): number {
  session.sequence += 1;
  return session.sequence;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
