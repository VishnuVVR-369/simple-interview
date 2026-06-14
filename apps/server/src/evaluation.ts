import {
  EVALUATION_CONFIG,
  EVALUATION_JSON_SCHEMA,
  buildEvaluationMessages,
} from "@repo/ai-config/prompts";
import type { AppConfig } from "./env";
import type { InterviewEvaluation, InterviewSession } from "./types";

const MIN_EVALUATION_TURNS = 4;
const MIN_EVALUATION_TRANSCRIPT_CHARS = 200;

export async function generateEvaluation(
  session: InterviewSession,
  config: AppConfig,
): Promise<InterviewEvaluation | undefined> {
  const transcript = renderTranscript(session);

  if (
    session.turns.length < MIN_EVALUATION_TURNS ||
    transcript.trim().length < MIN_EVALUATION_TRANSCRIPT_CHARS
  ) {
    return undefined;
  }

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openAiApiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": "simple-interview-owner",
      },
      body: JSON.stringify({
        model: EVALUATION_CONFIG.model,
        messages: buildEvaluationMessages(
          session.type,
          session.question,
          transcript,
        ),
        response_format: {
          type: "json_schema",
          json_schema: EVALUATION_JSON_SCHEMA,
        },
        temperature: 0.2,
      }),
    });
    const responseText = await response.text();

    if (!response.ok) {
      console.error(
        `Evaluation generation failed (${response.status}): ${responseText}`,
      );
      return undefined;
    }

    const body = parseJson(responseText);
    const content = extractMessageContent(body);

    if (!content) {
      console.error("Evaluation response did not include message content");
      return undefined;
    }

    const parsedEvaluation = parseJson(content);
    const evaluation = normalizeEvaluation(parsedEvaluation);

    if (!evaluation) {
      console.error("Evaluation response did not match expected shape");
      return undefined;
    }

    return {
      ...evaluation,
      generatedAt: new Date().toISOString(),
      evalModel: EVALUATION_CONFIG.model,
    };
  } catch (error) {
    console.error("Evaluation generation failed", error);
    return undefined;
  }
}

function renderTranscript(session: InterviewSession): string {
  return session.turns
    .map((turn) => `${roleLabel(turn.role)}: ${turn.text}`)
    .join("\n");
}

function roleLabel(role: string): string {
  if (role === "assistant") {
    return "Interviewer";
  }

  if (role === "user") {
    return "Candidate";
  }

  return "System";
}

function extractMessageContent(body: unknown): string | undefined {
  if (!isRecord(body) || !Array.isArray(body.choices)) {
    return undefined;
  }

  const [choice] = body.choices;

  if (!isRecord(choice) || !isRecord(choice.message)) {
    return undefined;
  }

  return typeof choice.message.content === "string"
    ? choice.message.content
    : undefined;
}

function parseJson(value: string): unknown {
  return JSON.parse(value) as unknown;
}

function normalizeEvaluation(value: unknown): InterviewEvaluation | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const recommendation = value.recommendation;

  if (
    recommendation !== "strong_no" &&
    recommendation !== "lean_no" &&
    recommendation !== "lean_yes" &&
    recommendation !== "strong_yes"
  ) {
    return undefined;
  }

  if (
    typeof value.overallScore !== "number" ||
    typeof value.summary !== "string" ||
    !Array.isArray(value.axes) ||
    !Array.isArray(value.strengths) ||
    !Array.isArray(value.improvements) ||
    typeof value.modelAnswerOutline !== "string" ||
    !Array.isArray(value.topicsToReview)
  ) {
    return undefined;
  }

  const axes = value.axes.map(normalizeAxis);

  if (
    axes.some((axis) => axis === undefined) ||
    !value.strengths.every(isString) ||
    !value.improvements.every(isString) ||
    !value.topicsToReview.every(isString)
  ) {
    return undefined;
  }

  const normalizedAxes = axes.filter(
    (axis): axis is InterviewEvaluation["axes"][number] => axis !== undefined,
  );

  return {
    overallScore: value.overallScore,
    recommendation,
    summary: value.summary,
    axes: normalizedAxes,
    strengths: value.strengths,
    improvements: value.improvements,
    modelAnswerOutline: value.modelAnswerOutline,
    topicsToReview: value.topicsToReview,
    generatedAt: "",
    evalModel: "",
  };
}

function normalizeAxis(
  value: unknown,
): InterviewEvaluation["axes"][number] | undefined {
  if (
    !isRecord(value) ||
    typeof value.key !== "string" ||
    typeof value.label !== "string" ||
    typeof value.score !== "number" ||
    typeof value.comment !== "string"
  ) {
    return undefined;
  }

  return {
    key: value.key,
    label: value.label,
    score: value.score,
    comment: value.comment,
  };
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
