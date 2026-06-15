import {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  type S3Client,
} from "@aws-sdk/client-s3";
import {
  EVALUATION_RUBRICS,
  INTERVIEW_LABELS,
  INTERVIEW_TYPES,
  type EvaluationRecommendation,
  type InterviewType,
} from "@repo/ai-config/prompts";
import type { AppConfig } from "./env";
import { getR2Client } from "./storage";
import type { InterviewSession } from "./types";

const PROGRESS_PREFIX = "progress/";
const MAX_WEAK_TOPICS = 12;

export interface ProgressRecord {
  callId: string;
  type: InterviewType;
  label: string;
  date: string;
  durationSeconds: number;
  overallScore: number;
  recommendation: EvaluationRecommendation;
  axisScores: Record<string, number>;
  topicsToReview: string[];
  transcriptKey?: string;
}

export interface ProgressTypeSummary {
  type: InterviewType;
  label: string;
  count: number;
  averageScore: number;
  bestScore: number;
  latestScore: number;
}

export interface ProgressTrendPoint {
  date: string;
  callId: string;
  type: InterviewType;
  overallScore: number;
}

export interface ProgressAxisAverage {
  key: string;
  label: string;
  average: number;
}

export interface ProgressTopic {
  topic: string;
  count: number;
}

export interface ProgressSummary {
  totalInterviews: number;
  averageScore: number;
  byType: ProgressTypeSummary[];
  trend: ProgressTrendPoint[];
  axisAverages: ProgressAxisAverage[];
  weakTopics: ProgressTopic[];
}

const AXIS_LABELS = buildAxisLabels();

export async function writeProgressRecord(
  session: InterviewSession,
  config: AppConfig,
): Promise<void> {
  if (!session.evaluation) {
    return;
  }

  const record: ProgressRecord = {
    callId: session.callId,
    type: session.type,
    label: session.label,
    date: session.endedAt ?? session.updatedAt ?? session.createdAt,
    durationSeconds: computeDurationSeconds(session),
    overallScore: session.evaluation.overallScore,
    recommendation: session.evaluation.recommendation,
    axisScores: Object.fromEntries(
      session.evaluation.axes.map((axis) => [axis.key, axis.score]),
    ),
    topicsToReview: session.evaluation.topicsToReview,
    transcriptKey: session.storage.markdownKey,
  };

  const s3 = getR2Client(config);

  await s3.send(
    new PutObjectCommand({
      Bucket: config.r2Bucket,
      Key: progressKey(session),
      Body: JSON.stringify(record, null, 2),
      ContentType: "application/json; charset=utf-8",
    }),
  );
}

export async function getProgressSummary(
  config: AppConfig,
): Promise<ProgressSummary> {
  const records = await listProgressRecords(config);
  return summarizeProgress(records);
}

async function listProgressRecords(
  config: AppConfig,
): Promise<ProgressRecord[]> {
  const s3 = getR2Client(config);
  const keys: string[] = [];
  let continuationToken: string | undefined;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.r2Bucket,
        Prefix: PROGRESS_PREFIX,
        ContinuationToken: continuationToken,
      }),
    );

    for (const object of response.Contents ?? []) {
      if (object.Key && object.Key.endsWith(".json")) {
        keys.push(object.Key);
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  const records = await Promise.all(
    keys.map((key) => readProgressRecord(s3, config, key)),
  );

  return records.filter(
    (record): record is ProgressRecord => record !== undefined,
  );
}

async function readProgressRecord(
  s3: S3Client,
  config: AppConfig,
  key: string,
): Promise<ProgressRecord | undefined> {
  try {
    const response = await s3.send(
      new GetObjectCommand({
        Bucket: config.r2Bucket,
        Key: key,
      }),
    );
    const text = response.Body ? await response.Body.transformToString() : "";

    return normalizeProgressRecord(JSON.parse(text) as unknown);
  } catch (error) {
    console.error(`Failed to read progress record ${key}`, error);
    return undefined;
  }
}

function summarizeProgress(records: ProgressRecord[]): ProgressSummary {
  const sorted = [...records].sort((a, b) => a.date.localeCompare(b.date));
  const totalInterviews = sorted.length;
  const averageScore = totalInterviews
    ? Math.round(
        sorted.reduce((sum, record) => sum + record.overallScore, 0) /
          totalInterviews,
      )
    : 0;

  const byType = INTERVIEW_TYPES.map((type) =>
    summarizeType(
      type,
      sorted.filter((record) => record.type === type),
    ),
  ).filter((summary): summary is ProgressTypeSummary => summary !== undefined);

  const trend: ProgressTrendPoint[] = sorted.map((record) => ({
    date: record.date,
    callId: record.callId,
    type: record.type,
    overallScore: record.overallScore,
  }));

  return {
    totalInterviews,
    averageScore,
    byType,
    trend,
    axisAverages: computeAxisAverages(sorted),
    weakTopics: computeWeakTopics(sorted),
  };
}

function summarizeType(
  type: InterviewType,
  records: ProgressRecord[],
): ProgressTypeSummary | undefined {
  if (records.length === 0) {
    return undefined;
  }

  const scores = records.map((record) => record.overallScore);

  return {
    type,
    label: INTERVIEW_LABELS[type],
    count: records.length,
    averageScore: Math.round(
      scores.reduce((sum, score) => sum + score, 0) / records.length,
    ),
    bestScore: Math.max(...scores),
    latestScore: records[records.length - 1]!.overallScore,
  };
}

function computeAxisAverages(
  records: ProgressRecord[],
): ProgressAxisAverage[] {
  const totals = new Map<string, { sum: number; count: number }>();

  for (const record of records) {
    for (const [key, score] of Object.entries(record.axisScores)) {
      const entry = totals.get(key) ?? { sum: 0, count: 0 };
      entry.sum += score;
      entry.count += 1;
      totals.set(key, entry);
    }
  }

  const averages: ProgressAxisAverage[] = [];

  for (const [key, label] of AXIS_LABELS) {
    const entry = totals.get(key);

    if (entry && entry.count > 0) {
      averages.push({ key, label, average: round1(entry.sum / entry.count) });
    }
  }

  for (const [key, entry] of totals) {
    if (!AXIS_LABELS.has(key) && entry.count > 0) {
      averages.push({ key, label: key, average: round1(entry.sum / entry.count) });
    }
  }

  return averages;
}

function computeWeakTopics(records: ProgressRecord[]): ProgressTopic[] {
  const counts = new Map<string, ProgressTopic>();

  for (const record of records) {
    for (const raw of record.topicsToReview) {
      const topic = raw.trim();

      if (!topic) {
        continue;
      }

      const lookupKey = topic.toLowerCase();
      const entry = counts.get(lookupKey) ?? { topic, count: 0 };
      entry.count += 1;
      counts.set(lookupKey, entry);
    }
  }

  return [...counts.values()]
    .sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic))
    .slice(0, MAX_WEAK_TOPICS);
}

function normalizeProgressRecord(value: unknown): ProgressRecord | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const type = INTERVIEW_TYPES.find((candidate) => candidate === value.type);

  if (!type || typeof value.overallScore !== "number") {
    return undefined;
  }

  const axisScores: Record<string, number> = {};

  if (isRecord(value.axisScores)) {
    for (const [key, score] of Object.entries(value.axisScores)) {
      if (typeof score === "number") {
        axisScores[key] = score;
      }
    }
  }

  const topicsToReview = Array.isArray(value.topicsToReview)
    ? value.topicsToReview.filter(
        (topic): topic is string => typeof topic === "string",
      )
    : [];

  return {
    callId: typeof value.callId === "string" ? value.callId : "",
    type,
    label: typeof value.label === "string" ? value.label : INTERVIEW_LABELS[type],
    date: typeof value.date === "string" ? value.date : "",
    durationSeconds:
      typeof value.durationSeconds === "number" ? value.durationSeconds : 0,
    overallScore: value.overallScore,
    recommendation: isRecommendation(value.recommendation)
      ? value.recommendation
      : "lean_no",
    axisScores,
    topicsToReview,
    transcriptKey:
      typeof value.transcriptKey === "string" ? value.transcriptKey : undefined,
  };
}

function progressKey(session: InterviewSession): string {
  const safeTimestamp = session.createdAt.replace(/[:.]/g, "-");
  return `${PROGRESS_PREFIX}${session.type}/${safeTimestamp}-${session.callId}.json`;
}

function computeDurationSeconds(session: InterviewSession): number {
  const start = Date.parse(session.createdAt);
  const end = Date.parse(
    session.endedAt ?? session.updatedAt ?? session.createdAt,
  );

  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    return 0;
  }

  return Math.round((end - start) / 1000);
}

function buildAxisLabels(): Map<string, string> {
  const labels = new Map<string, string>();

  for (const axes of Object.values(EVALUATION_RUBRICS)) {
    for (const axis of axes) {
      if (!labels.has(axis.key)) {
        labels.set(axis.key, axis.label);
      }
    }
  }

  return labels;
}

function isRecommendation(value: unknown): value is EvaluationRecommendation {
  return (
    value === "strong_no" ||
    value === "lean_no" ||
    value === "lean_yes" ||
    value === "strong_yes"
  );
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
