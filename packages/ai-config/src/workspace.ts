import type { InterviewType } from "./prompts.js";

export type WorkspaceKind = "code" | "diagram";
export type WorkspaceSyncReason =
  | "client_sync"
  | "manual_share"
  | "tool_read"
  | "session_start";

export interface CodeFile {
  id: string;
  name: string;
  language: CodeLanguage;
  content: string;
}

export type CodeLanguage = "cpp" | "javascript";

export interface CodeRunResult {
  status: "idle" | "running" | "passed" | "failed";
  output: string;
  ranAt?: string;
}

export interface CodeWorkspace {
  version: 1;
  kind: "code";
  activeFileId: string;
  files: CodeFile[];
  runResult: CodeRunResult;
  updatedAt: string;
}

export interface DiagramWorkspace {
  version: 1;
  kind: "diagram";
  elements: unknown[];
  appState: Record<string, unknown>;
  files: Record<string, unknown>;
  updatedAt: string;
}

export type InterviewWorkspace = CodeWorkspace | DiagramWorkspace;

export interface WorkspaceTimelineEvent {
  sequence: number;
  type: WorkspaceSyncReason;
  summary: string;
  createdAt: string;
}

export const WORKSPACE_SYNC_DEBOUNCE_MS = 2200;
export const WORKSPACE_CONTEXT_MAX_CHARS = 9000;
export const WORKSPACE_CODE_MAX_CHARS = 14000;
export const WORKSPACE_RUN_OUTPUT_MAX_CHARS = 4000;
export const WORKSPACE_DIAGRAM_ELEMENTS_MAX = 350;

const CODE_FILE_ID = "main";

const WORKSPACE_INTERVIEW_LABELS: Record<InterviewType, string> = {
  dsa: "DSA Interview",
  "system-design": "System Design Interview",
  "machine-coding": "Machine Coding Interview",
};

export function workspaceKindForInterviewType(
  type: InterviewType,
): WorkspaceKind {
  return type === "system-design" ? "diagram" : "code";
}

export function createInitialWorkspace(
  type: InterviewType,
): InterviewWorkspace {
  const now = new Date().toISOString();

  if (workspaceKindForInterviewType(type) === "diagram") {
    return {
      version: 1,
      kind: "diagram",
      elements: [],
      appState: {
        viewBackgroundColor: "#17130f",
      },
      files: {},
      updatedAt: now,
    };
  }

  return {
    version: 1,
    kind: "code",
    activeFileId: CODE_FILE_ID,
    files: [
      {
        id: CODE_FILE_ID,
        name: codeFileNameForInterview(type),
        language: codeLanguageForInterview(type),
        content: initialCodeForInterview(type),
      },
    ],
    runResult: {
      status: "idle",
      output: "",
    },
    updatedAt: now,
  };
}

export function normalizeWorkspace(
  value: unknown,
  type: InterviewType,
): InterviewWorkspace {
  if (!isRecord(value)) {
    return createInitialWorkspace(type);
  }

  if (value.kind === "diagram") {
    return normalizeDiagramWorkspace(value);
  }

  if (value.kind === "code") {
    return normalizeCodeWorkspace(value, type);
  }

  return createInitialWorkspace(type);
}

export function renderWorkspaceForModel(
  workspace: InterviewWorkspace | undefined,
  type: InterviewType,
): string {
  if (!workspace) {
    return "No workspace state has been shared yet.";
  }

  const rendered =
    workspace.kind === "code"
      ? renderCodeWorkspace(workspace, type)
      : renderDiagramWorkspace(workspace, type);

  return truncate(rendered, WORKSPACE_CONTEXT_MAX_CHARS);
}

export function summarizeWorkspace(
  workspace: InterviewWorkspace | undefined,
  type: InterviewType,
): string {
  if (!workspace) {
    return `${WORKSPACE_INTERVIEW_LABELS[type]} workspace not initialized.`;
  }

  if (workspace.kind === "diagram") {
    const textCount = workspace.elements.filter(hasText).length;
    return `Diagram workspace with ${workspace.elements.length} elements and ${textCount} text labels.`;
  }

  const activeFile = activeCodeFile(workspace);
  const lineCount = activeFile.content.split("\n").length;
  return `Code workspace ${activeFile.name}, ${lineCount} lines, run status ${workspace.runResult.status}.`;
}

export function activeCodeFile(workspace: CodeWorkspace): CodeFile {
  return (
    workspace.files.find((file) => file.id === workspace.activeFileId) ??
    workspace.files[0] ?? {
      id: CODE_FILE_ID,
      name: "solution.cpp",
      language: "cpp",
      content: "",
    }
  );
}

function normalizeCodeWorkspace(
  value: Record<string, unknown>,
  type: InterviewType,
): CodeWorkspace {
  const fallback = createInitialWorkspace(type);

  if (fallback.kind !== "code") {
    return createInitialWorkspace("dsa") as CodeWorkspace;
  }

  const rawFiles = Array.isArray(value.files) ? value.files : fallback.files;
  const files = rawFiles
    .slice(0, 4)
    .map((file) => normalizeCodeFile(file, type))
    .filter((file): file is CodeFile => Boolean(file));
  const normalizedFiles = files.length > 0 ? files : fallback.files;
  const activeFileId =
    typeof value.activeFileId === "string" &&
    normalizedFiles.some((file) => file.id === value.activeFileId)
      ? value.activeFileId
      : normalizedFiles[0]!.id;

  return {
    version: 1,
    kind: "code",
    activeFileId,
    files: normalizedFiles,
    runResult: normalizeRunResult(value.runResult),
    updatedAt: stringOrNow(value.updatedAt),
  };
}

function normalizeCodeFile(
  value: unknown,
  type: InterviewType,
): CodeFile | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const id = safeIdentifier(value.id, CODE_FILE_ID);
  const language = normalizeCodeLanguage(value.language, type);
  const name = truncate(
    normalizeCodeFileName(stringValue(value.name), type, language),
    80,
  );
  const content = truncate(
    stringValue(value.content),
    WORKSPACE_CODE_MAX_CHARS,
  );

  return {
    id,
    name,
    language,
    content,
  };
}

function normalizeRunResult(value: unknown): CodeRunResult {
  if (!isRecord(value)) {
    return { status: "idle", output: "" };
  }

  const status =
    value.status === "running" ||
    value.status === "passed" ||
    value.status === "failed"
      ? value.status
      : "idle";

  return {
    status,
    output: truncate(stringValue(value.output), WORKSPACE_RUN_OUTPUT_MAX_CHARS),
    ranAt: typeof value.ranAt === "string" ? value.ranAt : undefined,
  };
}

function normalizeDiagramWorkspace(
  value: Record<string, unknown>,
): DiagramWorkspace {
  return {
    version: 1,
    kind: "diagram",
    elements: Array.isArray(value.elements)
      ? value.elements.slice(0, WORKSPACE_DIAGRAM_ELEMENTS_MAX)
      : [],
    appState: pickDiagramAppState(value.appState),
    files: isRecord(value.files) ? value.files : {},
    updatedAt: stringOrNow(value.updatedAt),
  };
}

function pickDiagramAppState(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    return { viewBackgroundColor: "#17130f" };
  }

  return {
    viewBackgroundColor:
      typeof value.viewBackgroundColor === "string"
        ? value.viewBackgroundColor
        : "#17130f",
  };
}

function renderCodeWorkspace(
  workspace: CodeWorkspace,
  type: InterviewType,
): string {
  const activeFile = activeCodeFile(workspace);
  const otherFiles = workspace.files
    .filter((file) => file.id !== activeFile.id)
    .map((file) => file.name);

  return [
    `# ${WORKSPACE_INTERVIEW_LABELS[type]} Workspace`,
    "",
    "## Active code file",
    `Name: ${activeFile.name}`,
    `Language: ${activeFile.language}`,
    otherFiles.length > 0 ? `Other files: ${otherFiles.join(", ")}` : undefined,
    "",
    `\`\`\`${codeFenceForLanguage(activeFile.language)}`,
    activeFile.content.trim() || noCodePlaceholder(activeFile.language),
    "```",
    "",
    "## Latest run result",
    `Status: ${workspace.runResult.status}`,
    workspace.runResult.ranAt
      ? `Ran at: ${workspace.runResult.ranAt}`
      : undefined,
    workspace.runResult.output
      ? ["", "```text", workspace.runResult.output.trim(), "```"].join("\n")
      : "No run output captured yet.",
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function renderDiagramWorkspace(
  workspace: DiagramWorkspace,
  type: InterviewType,
): string {
  const elementTypes = new Map<string, number>();
  const labels: string[] = [];

  for (const element of workspace.elements) {
    if (!isRecord(element)) {
      continue;
    }

    const elementType = stringValue(element.type) || "unknown";
    elementTypes.set(elementType, (elementTypes.get(elementType) ?? 0) + 1);

    const text = stringValue(element.text).trim();

    if (text) {
      labels.push(text);
    }
  }

  const compactElements = workspace.elements
    .slice(0, 80)
    .map(compactDiagramElement)
    .filter(Boolean);

  return [
    `# ${WORKSPACE_INTERVIEW_LABELS[type]} Workspace`,
    "",
    "## Diagram summary",
    `Element count: ${workspace.elements.length}`,
    `Element types: ${
      Array.from(elementTypes)
        .map(([key, count]) => `${key}=${count}`)
        .join(", ") || "none"
    }`,
    labels.length > 0
      ? `Text labels: ${labels.slice(0, 60).join(" | ")}`
      : "Text labels: none",
    "",
    "## Compact diagram JSON",
    "```json",
    JSON.stringify(compactElements, null, 2),
    "```",
  ].join("\n");
}

function compactDiagramElement(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const compact: Record<string, unknown> = {
    type: value.type,
    x: value.x,
    y: value.y,
    width: value.width,
    height: value.height,
  };

  const text = stringValue(value.text).trim();

  if (text) {
    compact.text = truncate(text, 500);
  }

  return compact;
}

function hasText(value: unknown): boolean {
  return isRecord(value) && stringValue(value.text).trim().length > 0;
}

function initialCodeForInterview(type: InterviewType): string {
  if (type === "dsa") {
    return [
      "// Talk through your approach, then code the core logic here.",
      "",
      "#include <bits/stdc++.h>",
      "using namespace std;",
      "",
      "class Solution {",
      "public:",
      "  vector<int> solve(vector<int>& nums) {",
      "    return nums;",
      "  }",
      "};",
      "",
      "int main() {",
      "  vector<int> nums = {1, 2, 3};",
      "  Solution solution;",
      "  vector<int> result = solution.solve(nums);",
      "",
      "  for (int value : result) {",
      "    cout << value << \" \";",
      "  }",
      "  cout << '\\n';",
      "  return 0;",
      "}",
    ].join("\n");
  }

  if (type === "machine-coding") {
    return [
      "// Implement the requested module here.",
      "// Use console.log(...) for quick checks, then click Run.",
      "",
      "class Solution {",
      "  constructor() {",
      "    this.items = new Map();",
      "  }",
      "",
      "  add(key, value) {",
      "    this.items.set(key, value);",
      "  }",
      "",
      "  get(key) {",
      "    return this.items.get(key);",
      "  }",
      "}",
      "",
      "const solution = new Solution();",
      'solution.add("example", 42);',
      'console.log(solution.get("example"));',
    ].join("\n");
  }

  return "";
}

function codeLanguageForInterview(type: InterviewType): CodeLanguage {
  return type === "dsa" ? "cpp" : "javascript";
}

function codeFileNameForInterview(type: InterviewType): string {
  return type === "dsa" ? "solution.cpp" : "module.js";
}

function normalizeCodeLanguage(
  value: unknown,
  type: InterviewType,
): CodeLanguage {
  if (type === "dsa") {
    return "cpp";
  }

  return value === "cpp" || value === "javascript"
    ? value
    : codeLanguageForInterview(type);
}

function normalizeCodeFileName(
  value: string,
  type: InterviewType,
  language: CodeLanguage,
): string {
  const trimmed = value.trim();

  if (type === "dsa" && (!trimmed || trimmed.endsWith(".js"))) {
    return "solution.cpp";
  }

  if (!trimmed) {
    return language === "cpp" ? "solution.cpp" : "module.js";
  }

  return trimmed;
}

function codeFenceForLanguage(language: CodeLanguage): string {
  return language === "cpp" ? "cpp" : "javascript";
}

function noCodePlaceholder(language: CodeLanguage): string {
  return language === "cpp"
    ? "// No C++ code written yet."
    : "// No code written yet.";
}

function safeIdentifier(value: unknown, fallback: string): string {
  const raw = stringValue(value).trim();

  if (!raw) {
    return fallback;
  }

  return raw.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 48) || fallback;
}

function stringOrNow(value: unknown): string {
  return typeof value === "string" ? value : new Date().toISOString();
}

function stringValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return "";
}

function truncate(value: string, maxLength: number): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n[truncated ${value.length - maxLength} characters]`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
