import {
  INTERVIEW_TYPES,
  MAX_CUSTOM_QUESTION_LENGTH,
  type InterviewType,
  type QuestionSettings,
} from "@repo/ai-config/prompts";
import {
  clearSessionCookie,
  createSessionToken,
  getSessionToken,
  isAuthenticated,
  isPasswordValid,
  revokeSessionToken,
  sessionCookie,
} from "./auth";
import { type AppConfig, loadConfig } from "./env";
import {
  createRealtimeInterview,
  endInterviewSession,
  getInterviewSession,
} from "./realtime";
import { getMarkdownTranscript, listMarkdownTranscripts } from "./storage";
import { toPublicSession } from "./transcript";

const config = loadConfig();

const server = Bun.serve({
  port: config.port,
  async fetch(request) {
    if (request.method === "OPTIONS") {
      return withCors(request, new Response(null, { status: 204 }), config);
    }

    try {
      return await route(request, config);
    } catch (error) {
      console.error(error);
      return json(
        request,
        {
          error:
            error instanceof Error ? error.message : "Unexpected server error",
        },
        { status: 500 },
        config,
      );
    }
  },
});

console.log(`Interview server listening on http://localhost:${server.port}`);

async function route(
  request: Request,
  appConfig: AppConfig,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/health") {
    return json(
      request,
      {
        ok: true,
        service: "simple-interview-server",
        r2Bucket: appConfig.r2Bucket,
      },
      undefined,
      appConfig,
    );
  }

  if (url.pathname === "/api/session" && request.method === "GET") {
    return json(
      request,
      { authenticated: isAuthenticated(request) },
      undefined,
      appConfig,
    );
  }

  if (url.pathname === "/api/login" && request.method === "POST") {
    const body = await parseJsonBody<{ password?: unknown }>(request);
    const password = typeof body.password === "string" ? body.password : "";

    if (!isPasswordValid(password, appConfig)) {
      return json(
        request,
        { error: "Invalid password" },
        { status: 401 },
        appConfig,
      );
    }

    const token = createSessionToken();
    return json(
      request,
      { ok: true },
      {
        headers: {
          "Set-Cookie": sessionCookie(token, appConfig),
        },
      },
      appConfig,
    );
  }

  if (url.pathname === "/api/logout" && request.method === "POST") {
    revokeSessionToken(getSessionToken(request));
    return json(
      request,
      { ok: true },
      {
        headers: {
          "Set-Cookie": clearSessionCookie(appConfig),
        },
      },
      appConfig,
    );
  }

  if (!isAuthenticated(request)) {
    return json(request, { error: "Unauthorized" }, { status: 401 }, appConfig);
  }

  if (
    url.pathname === "/api/transcripts/markdown" &&
    request.method === "GET"
  ) {
    const key = url.searchParams.get("key");

    if (key) {
      try {
        return json(
          request,
          await getMarkdownTranscript(key, appConfig),
          undefined,
          appConfig,
        );
      } catch (error) {
        if (
          error instanceof Error &&
          error.message === "Invalid markdown transcript key"
        ) {
          return json(
            request,
            { error: error.message },
            { status: 400 },
            appConfig,
          );
        }

        throw error;
      }
    }

    return json(
      request,
      await listMarkdownTranscripts(appConfig),
      undefined,
      appConfig,
    );
  }

  if (url.pathname === "/api/realtime/session" && request.method === "POST") {
    const interviewType = parseInterviewType(url.searchParams.get("type"));
    const questionSettings = parseQuestionSettings(
      url.searchParams,
      request.headers,
    );

    if (!interviewType) {
      return json(
        request,
        { error: "Invalid interview type" },
        { status: 400 },
        appConfig,
      );
    }

    if ("error" in questionSettings) {
      return json(
        request,
        { error: questionSettings.error },
        { status: 400 },
        appConfig,
      );
    }

    const sdp = await request.text();

    if (!sdp.trim()) {
      return json(
        request,
        { error: "Missing SDP offer" },
        { status: 400 },
        appConfig,
      );
    }

    const result = await createRealtimeInterview(
      interviewType,
      questionSettings.value,
      sdp,
      appConfig,
    );

    return withCors(
      request,
      new Response(result.sdp, {
        status: 200,
        headers: {
          "Content-Type": "application/sdp",
          "X-Interview-Id": result.session.id,
          "X-Call-Id": result.session.callId,
        },
      }),
      appConfig,
    );
  }

  const interviewMatch = url.pathname.match(/^\/api\/interviews\/([^/]+)$/);

  if (interviewMatch?.[1] && request.method === "GET") {
    const session = getInterviewSession(interviewMatch[1]);

    if (!session) {
      return json(
        request,
        { error: "Interview not found" },
        { status: 404 },
        appConfig,
      );
    }

    return json(request, toPublicSession(session), undefined, appConfig);
  }

  const endMatch = url.pathname.match(/^\/api\/interviews\/([^/]+)\/end$/);

  if (endMatch?.[1] && request.method === "POST") {
    const session = getInterviewSession(endMatch[1]);

    if (!session) {
      return json(
        request,
        { error: "Interview not found" },
        { status: 404 },
        appConfig,
      );
    }

    await endInterviewSession(session, appConfig);
    return json(request, toPublicSession(session), undefined, appConfig);
  }

  return json(request, { error: "Not found" }, { status: 404 }, appConfig);
}

function parseInterviewType(value: string | null): InterviewType | undefined {
  if (!value) {
    return undefined;
  }

  return INTERVIEW_TYPES.find((type) => type === value);
}

function parseQuestionSettings(
  searchParams: URLSearchParams,
  headers: Headers,
): { value: QuestionSettings; error?: undefined } | { error: string } {
  const mode =
    headers.get("X-Question-Mode") ??
    searchParams.get("questionMode") ??
    "random";

  if (mode === "random") {
    return { value: { mode: "random" } };
  }

  if (mode !== "specific") {
    return { error: "Invalid question mode" };
  }

  const text = decodeQuestion(
    headers.get("X-Custom-Question") ?? searchParams.get("question") ?? "",
  ).trim();

  if (!text) {
    return { error: "Specific question is required" };
  }

  if (text.length > MAX_CUSTOM_QUESTION_LENGTH) {
    return {
      error: `Specific question must be ${MAX_CUSTOM_QUESTION_LENGTH} characters or fewer`,
    };
  }

  return { value: { mode: "specific", text } };
}

function decodeQuestion(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function parseJsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

function json(
  request: Request,
  body: unknown,
  init: ResponseInit | undefined,
  appConfig: AppConfig,
): Response {
  return withCors(
    request,
    Response.json(body, {
      ...init,
      headers: {
        ...init?.headers,
        "Content-Type": "application/json",
      },
    }),
    appConfig,
  );
}

function withCors(
  request: Request,
  response: Response,
  appConfig: AppConfig,
): Response {
  const origin = request.headers.get("origin");
  const headers = new Headers(response.headers);

  if (origin && appConfig.allowedOrigins.includes(origin.replace(/\/$/, ""))) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Vary", "Origin");
  }

  headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  headers.set(
    "Access-Control-Allow-Headers",
    "Content-Type,Accept,X-Question-Mode,X-Custom-Question",
  );
  headers.set("Access-Control-Expose-Headers", "X-Interview-Id,X-Call-Id");

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
