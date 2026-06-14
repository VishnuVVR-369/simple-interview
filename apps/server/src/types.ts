import type { InterviewType, QuestionSettings } from "@repo/ai-config/prompts";

export type TranscriptRole = "assistant" | "user" | "system";

export interface TranscriptTurn {
  sequence: number;
  role: TranscriptRole;
  text: string;
  itemId?: string;
  responseId?: string;
  eventType: string;
  createdAt: string;
}

export interface RawTranscriptEvent {
  sequence: number;
  receivedAt: string;
  type: string;
  event: unknown;
}

export interface StorageState {
  jsonKey?: string;
  markdownKey?: string;
  evaluationKey?: string;
  lastPersistedAt?: string;
  lastError?: string;
}

export interface RubricAxis {
  key: string;
  label: string;
  score: number;
  comment: string;
}

export interface InterviewEvaluation {
  overallScore: number;
  recommendation: "strong_no" | "lean_no" | "lean_yes" | "strong_yes";
  summary: string;
  axes: RubricAxis[];
  strengths: string[];
  improvements: string[];
  modelAnswerOutline: string;
  topicsToReview: string[];
  generatedAt: string;
  evalModel: string;
}

export interface InterviewSession {
  id: string;
  callId: string;
  type: InterviewType;
  label: string;
  model: string;
  voice: string;
  question: QuestionSettings;
  status:
    | "created"
    | "sideband_connected"
    | "active"
    | "ending"
    | "ended"
    | "error";
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  transcriptKeyPrefix: string;
  sequence: number;
  turns: TranscriptTurn[];
  rawTranscriptEvents: RawTranscriptEvent[];
  partials: Map<string, string>;
  storage: StorageState;
  evaluation?: InterviewEvaluation;
  sideband?: import("ws").WebSocket;
}

export interface PublicInterviewSession {
  id: string;
  callId: string;
  type: InterviewType;
  label: string;
  model: string;
  voice: string;
  question: QuestionSettings;
  status: InterviewSession["status"];
  createdAt: string;
  updatedAt: string;
  endedAt?: string;
  turns: TranscriptTurn[];
  storage: StorageState;
  evaluation?: InterviewEvaluation;
}
