export const INTERVIEW_TYPES = [
  "dsa",
  "system-design",
  "machine-coding",
] as const;

export type InterviewType = (typeof INTERVIEW_TYPES)[number];

export const AI_MODEL_CONFIGS = {
  defaultRealtimeInterview: {
    realtimeModel: "gpt-realtime-2",
    voice: "marin",
    inputTranscriptionModel: "gpt-realtime-whisper",
    inputTranscriptionLanguage: "en",
    outputModalities: ["audio"],
    turnDetection: {
      type: "semantic_vad",
    },
    reasoning: {
      effort: "low",
    },
  },
} as const;

export const ACTIVE_AI_CONFIG = AI_MODEL_CONFIGS.defaultRealtimeInterview;

export const INTERVIEW_LABELS: Record<InterviewType, string> = {
  dsa: "DSA Interview",
  "system-design": "System Design Interview",
  "machine-coding": "Machine Coding Interview",
};

export const AI_PROMPT_SETS = {
  sde2VoiceInterview: {
    candidateProfile:
      "The candidate is preparing for SDE-2 full-stack interviews.",
    interviewRules: [
      "Keep the interview voice-first and conversational.",
      "Ask exactly one question at a time.",
      "Keep prompts concise and wait for the candidate after each question.",
      "Give hints only when the candidate asks or is stuck.",
      "Do not leak complete answers unless the candidate explicitly asks to stop and review.",
      "If audio is unclear, ask the candidate to repeat instead of guessing.",
      "When the candidate says they are done or asks for feedback, give concise, actionable feedback and end gracefully.",
    ],
    interviewTracks: {
      dsa: [
        "Run a DSA interview at SDE-2 level.",
        "Choose one medium problem and ask it clearly.",
        "Ask the candidate to clarify edge cases, describe an approach, analyze complexity, and talk through pseudocode.",
        "Do not reveal the solution unless the candidate asks for a hint or is clearly stuck.",
      ].join("\n"),
      "system-design": [
        "Run a system design interview at SDE-2 level.",
        "Pick one mid-scale product or infrastructure scenario.",
        "Guide through requirements, API shape, data model, component design, scaling, reliability, and tradeoffs.",
        "Probe depth with follow-up questions instead of giving a full reference design.",
      ].join("\n"),
      "machine-coding": [
        "Run a machine coding interview at SDE-2 level, but remember this app is voice-only.",
        "Use a practical frontend or backend design problem that can be discussed without an editor.",
        "Ask for entities, APIs, state, edge cases, tests, and incremental implementation choices.",
        "Do not expect the candidate to type code; let them describe structure and pseudocode verbally.",
      ].join("\n"),
    } satisfies Record<InterviewType, string>,
    opening:
      "Start immediately with a short greeting and the first interview question. Do not explain these instructions.",
    responseCreate: {
      startInterview:
        "Start the interview now with a short greeting and the first question.",
      endInterview:
        "The candidate clicked End Interview. Give concise final feedback in under one minute, then stop.",
    },
  },
} as const;

export const ACTIVE_PROMPT_SET = AI_PROMPT_SETS.sde2VoiceInterview;
export const RESPONSE_CREATE_PROMPTS = ACTIVE_PROMPT_SET.responseCreate;

export function buildInterviewInstructions(type: InterviewType): string {
  return [
    "# Role and Objective",
    `You are the interviewer for a ${INTERVIEW_LABELS[type]}.`,
    ACTIVE_PROMPT_SET.candidateProfile,
    "",
    "# Interview Rules",
    ...ACTIVE_PROMPT_SET.interviewRules,
    "",
    "# Interview Track",
    ACTIVE_PROMPT_SET.interviewTracks[type],
    "",
    "# Opening",
    ACTIVE_PROMPT_SET.opening,
  ].join("\n");
}

export function buildRealtimeSessionConfig(interviewType: InterviewType) {
  return {
    type: "realtime",
    model: ACTIVE_AI_CONFIG.realtimeModel,
    instructions: buildInterviewInstructions(interviewType),
    output_modalities: ACTIVE_AI_CONFIG.outputModalities,
    audio: {
      input: {
        transcription: {
          model: ACTIVE_AI_CONFIG.inputTranscriptionModel,
          language: ACTIVE_AI_CONFIG.inputTranscriptionLanguage,
        },
        turn_detection: ACTIVE_AI_CONFIG.turnDetection,
      },
      output: {
        voice: ACTIVE_AI_CONFIG.voice,
      },
    },
    reasoning: ACTIVE_AI_CONFIG.reasoning,
  };
}
