import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import {
  INTERVIEW_LABELS,
  INTERVIEW_TYPES,
  type InterviewType,
} from "@repo/ai-config/prompts";
import { renderWorkspaceForModel } from "@repo/ai-config/workspace";
import type { AppConfig } from "./env";
import type { InterviewSession } from "./types";

export interface MarkdownTranscriptListItem {
  key: string;
  type: InterviewType;
  label: string;
  date: string;
  callId: string;
  startedAt?: string;
  lastModified?: string;
  size?: number;
}

export type MarkdownTranscriptGroups = Record<
  InterviewType,
  MarkdownTranscriptListItem[]
>;

let client: S3Client | undefined;

function getClient(config: AppConfig): S3Client {
  if (!client) {
    client = new S3Client({
      region: "auto",
      endpoint: `https://${config.r2AccountId}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: config.r2AccessKeyId,
        secretAccessKey: config.r2SecretAccessKey,
      },
      forcePathStyle: true,
    });
  }

  return client;
}

export function getR2Client(config: AppConfig): S3Client {
  return getClient(config);
}

export async function persistTranscript(
  session: InterviewSession,
  config: AppConfig,
): Promise<void> {
  const jsonKey = `${session.transcriptKeyPrefix}.json`;
  const markdownKey = `${session.transcriptKeyPrefix}.md`;
  const evaluationKey = session.evaluation
    ? `${session.transcriptKeyPrefix}.evaluation.json`
    : undefined;
  const persistedAt = new Date().toISOString();
  const body = buildJsonTranscript(session, persistedAt);
  const markdown = buildMarkdownTranscript(session, persistedAt);
  const s3 = getClient(config);

  try {
    const writes = [
      s3.send(
        new PutObjectCommand({
          Bucket: config.r2Bucket,
          Key: jsonKey,
          Body: JSON.stringify(body, null, 2),
          ContentType: "application/json; charset=utf-8",
        }),
      ),
      s3.send(
        new PutObjectCommand({
          Bucket: config.r2Bucket,
          Key: markdownKey,
          Body: markdown,
          ContentType: "text/markdown; charset=utf-8",
        }),
      ),
    ];

    if (evaluationKey && session.evaluation) {
      writes.push(
        s3.send(
          new PutObjectCommand({
            Bucket: config.r2Bucket,
            Key: evaluationKey,
            Body: JSON.stringify(session.evaluation, null, 2),
            ContentType: "application/json; charset=utf-8",
          }),
        ),
      );
    }

    await Promise.all(writes);

    session.storage = {
      jsonKey,
      markdownKey,
      evaluationKey,
      lastPersistedAt: persistedAt,
    };
  } catch (error) {
    session.storage = {
      ...session.storage,
      jsonKey,
      markdownKey,
      evaluationKey,
      lastError: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

export async function listMarkdownTranscripts(
  config: AppConfig,
): Promise<{ groups: MarkdownTranscriptGroups; total: number }> {
  const s3 = getClient(config);
  const groups = emptyTranscriptGroups();
  let continuationToken: string | undefined;
  let total = 0;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: config.r2Bucket,
        Prefix: "transcripts/",
        ContinuationToken: continuationToken,
      }),
    );

    for (const object of response.Contents ?? []) {
      const item = parseMarkdownTranscriptKey(
        object.Key,
        object.LastModified,
        object.Size,
      );

      if (!item) {
        continue;
      }

      groups[item.type].push(item);
      total += 1;
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  for (const type of INTERVIEW_TYPES) {
    groups[type].sort(compareMarkdownTranscripts);
  }

  return { groups, total };
}

export async function getMarkdownTranscript(
  key: string,
  config: AppConfig,
): Promise<{ key: string; markdown: string }> {
  if (!isSafeMarkdownTranscriptKey(key)) {
    throw new Error("Invalid markdown transcript key");
  }

  const s3 = getClient(config);
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: config.r2Bucket,
      Key: key,
    }),
  );

  return {
    key,
    markdown: response.Body ? await response.Body.transformToString() : "",
  };
}

export async function deleteMarkdownTranscript(
  key: string,
  config: AppConfig,
): Promise<{ key: string; deleted: string[] }> {
  if (!isSafeMarkdownTranscriptKey(key)) {
    throw new Error("Invalid markdown transcript key");
  }

  const prefix = key.slice(0, -".md".length);
  const keys = [`${prefix}.md`, `${prefix}.json`, `${prefix}.evaluation.json`];

  const s3 = getClient(config);
  await s3.send(
    new DeleteObjectsCommand({
      Bucket: config.r2Bucket,
      Delete: {
        Objects: keys.map((Key) => ({ Key })),
        Quiet: true,
      },
    }),
  );

  return { key, deleted: keys };
}

function emptyTranscriptGroups(): MarkdownTranscriptGroups {
  return {
    dsa: [],
    "system-design": [],
    "machine-coding": [],
  };
}

function parseMarkdownTranscriptKey(
  key: string | undefined,
  lastModified: Date | undefined,
  size: number | undefined,
): MarkdownTranscriptListItem | undefined {
  if (!key || !isSafeMarkdownTranscriptKey(key)) {
    return undefined;
  }

  const match = key.match(
    /^transcripts\/([^/]+)\/(\d{4}-\d{2}-\d{2})\/(.+)\.md$/,
  );

  if (!match) {
    return undefined;
  }

  const type = parseInterviewType(match[1]);

  if (!type) {
    return undefined;
  }

  const filename = match[3] ?? "";
  const startedAt = parseStartedAt(filename);

  return {
    key,
    type,
    label: INTERVIEW_LABELS[type],
    date: match[2] ?? "",
    callId: parseCallId(filename),
    startedAt,
    lastModified: lastModified?.toISOString(),
    size,
  };
}

function isSafeMarkdownTranscriptKey(key: string): boolean {
  return (
    key.startsWith("transcripts/") &&
    key.endsWith(".md") &&
    !key.includes("..") &&
    !key.includes("\\")
  );
}

function parseInterviewType(
  value: string | undefined,
): InterviewType | undefined {
  return INTERVIEW_TYPES.find((type) => type === value);
}

function parseStartedAt(filename: string): string | undefined {
  const match = filename.match(
    /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)-/,
  );

  if (!match?.[1]) {
    return undefined;
  }

  return match[1].replace(
    /^(.+T)(\d{2})-(\d{2})-(\d{2})-(\d{3}Z)$/,
    "$1$2:$3:$4.$5",
  );
}

function parseCallId(filename: string): string {
  const match = filename.match(
    /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(.+)$/,
  );

  return match?.[1] ?? filename;
}

function compareMarkdownTranscripts(
  a: MarkdownTranscriptListItem,
  b: MarkdownTranscriptListItem,
): number {
  const aTime = a.startedAt ?? a.lastModified ?? "";
  const bTime = b.startedAt ?? b.lastModified ?? "";

  return bTime.localeCompare(aTime);
}

function buildJsonTranscript(session: InterviewSession, persistedAt: string) {
  return {
    metadata: {
      id: session.id,
      callId: session.callId,
      type: session.type,
      label: session.label,
      question: session.question,
      model: session.model,
      voice: session.voice,
      status: session.status,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      endedAt: session.endedAt,
      persistedAt,
    },
    orderedTurns: session.turns,
    rawTranscriptBearingEvents: session.rawTranscriptEvents,
    workspace: session.workspace,
    workspaceEvents: session.workspaceEvents,
    evaluation: session.evaluation,
    storage: session.storage,
  };
}

function buildMarkdownTranscript(
  session: InterviewSession,
  persistedAt: string,
): string {
  const lines = [
    `# ${session.label}`,
    "",
    `- Interview ID: ${session.id}`,
    `- Call ID: ${session.callId}`,
    `- Type: ${session.type}`,
    `- Question Mode: ${session.question.mode}`,
    session.question.mode === "specific" && session.question.text
      ? `- Specific Question: ${session.question.text}`
      : undefined,
    `- Model: ${session.model}`,
    `- Voice: ${session.voice}`,
    `- Status: ${session.status}`,
    `- Started: ${session.createdAt}`,
    session.endedAt ? `- Ended: ${session.endedAt}` : undefined,
    `- Persisted: ${persistedAt}`,
    "",
    "## Transcript",
    "",
  ].filter((line): line is string => Boolean(line));

  if (session.turns.length === 0) {
    lines.push("_No transcript turns captured yet._");
  }

  for (const turn of session.turns) {
    lines.push(`### ${turn.sequence}. ${roleLabel(turn.role)}`);
    lines.push("");
    lines.push(turn.text.trim() || "_Empty transcript text._");
    lines.push("");
  }

  lines.push("## Workspace");
  lines.push("");
  lines.push("```text");
  lines.push(renderWorkspaceForModel(session.workspace, session.type));
  lines.push("```");
  lines.push("");

  if (session.workspaceEvents.length > 0) {
    lines.push("## Workspace Event Timeline");
    lines.push("");

    for (const event of session.workspaceEvents) {
      lines.push(
        `- ${event.sequence}. ${event.type} at ${event.createdAt}: ${event.summary}`,
      );
    }

    lines.push("");
  }

  if (session.evaluation) {
    lines.push("## Evaluation");
    lines.push("");
    lines.push(`- Overall Score: ${session.evaluation.overallScore}/100`);
    lines.push(
      `- Recommendation: ${formatRecommendation(
        session.evaluation.recommendation,
      )}`,
    );
    lines.push(`- Generated: ${session.evaluation.generatedAt}`);
    lines.push(`- Evaluation Model: ${session.evaluation.evalModel}`);
    lines.push("");
    lines.push("### Summary");
    lines.push("");
    lines.push(session.evaluation.summary);
    lines.push("");
    lines.push("### Rubric");
    lines.push("");

    for (const axis of session.evaluation.axes) {
      lines.push(`- ${axis.label}: ${axis.score}/5 - ${axis.comment.trim()}`);
    }

    lines.push("");
    lines.push("### Strengths");
    lines.push("");

    for (const strength of session.evaluation.strengths) {
      lines.push(`- ${strength}`);
    }

    lines.push("");
    lines.push("### Improvements");
    lines.push("");

    for (const improvement of session.evaluation.improvements) {
      lines.push(`- ${improvement}`);
    }

    lines.push("");
    lines.push("### Model Answer Outline");
    lines.push("");
    lines.push(session.evaluation.modelAnswerOutline);
    lines.push("");

    if (session.evaluation.topicsToReview.length > 0) {
      lines.push("### Topics To Review");
      lines.push("");

      for (const topic of session.evaluation.topicsToReview) {
        lines.push(`- ${topic}`);
      }

      lines.push("");
    }
  }

  lines.push("## Raw Transcript Event Count");
  lines.push("");
  lines.push(String(session.rawTranscriptEvents.length));
  lines.push("");

  return `${lines.join("\n")}\n`;
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

function formatRecommendation(recommendation: string): string {
  return recommendation
    .split("_")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}
