import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { AppConfig } from "./env";
import type { InterviewSession } from "./types";

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

export async function persistTranscript(
  session: InterviewSession,
  config: AppConfig,
): Promise<void> {
  const jsonKey = `${session.transcriptKeyPrefix}.json`;
  const markdownKey = `${session.transcriptKeyPrefix}.md`;
  const persistedAt = new Date().toISOString();
  const body = buildJsonTranscript(session, persistedAt);
  const markdown = buildMarkdownTranscript(session, persistedAt);
  const s3 = getClient(config);

  try {
    await Promise.all([
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
    ]);

    session.storage = {
      jsonKey,
      markdownKey,
      lastPersistedAt: persistedAt,
    };
  } catch (error) {
    session.storage = {
      ...session.storage,
      jsonKey,
      markdownKey,
      lastError: error instanceof Error ? error.message : String(error),
    };
    throw error;
  }
}

function buildJsonTranscript(session: InterviewSession, persistedAt: string) {
  return {
    metadata: {
      id: session.id,
      callId: session.callId,
      type: session.type,
      label: session.label,
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
