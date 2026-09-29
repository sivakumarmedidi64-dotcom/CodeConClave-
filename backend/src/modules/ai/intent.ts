/**
 * CodeConClave — canonical task-intent classifier (Model Routing 2026).
 *
 * Deterministic + lightweight. It NEVER invokes a model for classification
 * (consistent with conversations/intent.ts philosophy): model selection is the
 * router's job over the classified intent, not an extra AI round-trip.
 *
 * The taxonomy maps a request to an internal TaskType with capability hints.
 * It is internal orchestration ONLY — it is never exposed as cluttered UI.
 */
import { TaskType, type TaskType as TaskTypeType } from '@codeconclave/shared';

export type { TaskTypeType };

export interface IntentSignals {
  text: string;
  /** Attachments present on the request (e.g. image/file/audio/terminal). */
  hasImage?: boolean;
  hasAttachment?: boolean;
  hasFile?: boolean;
  /** Explicit mode declared by the caller (e.g. COWORK). */
  mode?: string | null;
  /** Explicit task type hint (e.g. from a coworker definition or autonomous step). */
  taskTypeHint?: TaskTypeType | null;
  /** Explicit capability requirement hint (e.g. needsTools). */
  capabilityHints?: Partial<{
    needsTools: boolean;
    needsVision: boolean;
    needsFunctionCalling: boolean;
    needsImageGeneration: boolean;
    needsImageEditing: boolean;
    needsReasoning: boolean;
    needsCoding: boolean;
    needsStructuredOutput: boolean;
    needsAutonomousAgent: boolean;
  }>;
}

export interface ClassifiedIntent {
  taskType: TaskTypeType;
  /** Capability requirements derived honestly — never invented. */
  capabilityHints: Required<IntentSignals['capabilityHints']>;
  /** Ranked candidate task types (first is final). */
  candidates: TaskTypeType[];
  reason: string;
}

function caps(over: Partial<IntentSignals['capabilityHints']> = {}): Partial<IntentSignals['capabilityHints']> {
  return { ...over };
}

/** Normalizes a partial hints object to the required-shape capability set. */
function fullCaps(over: Partial<IntentSignals['capabilityHints']> = {}): Required<IntentSignals['capabilityHints']> {
  return {
    needsTools: over.needsTools ?? false,
    needsVision: over.needsVision ?? false,
    needsFunctionCalling: over.needsFunctionCalling ?? false,
    needsImageGeneration: over.needsImageGeneration ?? false,
    needsImageEditing: over.needsImageEditing ?? false,
    needsReasoning: over.needsReasoning ?? false,
    needsCoding: over.needsCoding ?? false,
    needsStructuredOutput: over.needsStructuredOutput ?? false,
    needsAutonomousAgent: over.needsAutonomousAgent ?? false,
  };
}

const RULES: Array<{ type: TaskTypeType; patterns: RegExp; caps: Partial<IntentSignals['capabilityHints']> }> = [
  {
    type: TaskType.DEEP_REASONING,
    patterns: /(prove|deduce|derive|compare and contrast|why does this happen|deep reasoning|mathematical proof|philosophical|analyze the tradeoffs|think step by step)/i,
    caps: caps({ needsReasoning: true }),
  },
  {
    type: TaskType.REFACTORING,
    patterns: /(refactor|restructure the code|improve code structure|reduce duplication|clean up the code)/i,
    caps: caps({ needsCoding: true, needsTools: true }),
  },
  {
    type: TaskType.DEBUGGING,
    patterns: /(debug|bug |traceback|stack trace|why is.*(failing|broken|not working)|fix the error|exception|segfault)/i,
    caps: caps({ needsCoding: true, needsReasoning: true }),
  },
  {
    type: TaskType.CODE_REVIEW,
    patterns: /(code review|review the code|review this pr|review pull request|security review|audit the code)/i,
    caps: caps({ needsCoding: true, needsReasoning: true }),
  },
  {
    type: TaskType.TEST_GENERATION,
    patterns: /(write tests|unit test|test coverage|add tests|integration test|test generation)/i,
    caps: caps({ needsCoding: true, needsFunctionCalling: true }),
  },
  {
    type: TaskType.ARCHITECTURE,
    patterns: /(architecture|architect|system design|design the system|technical design|how should we structure)/i,
    caps: caps({ needsCoding: true, needsReasoning: true }),
  },
  {
    type: TaskType.IMAGE_GENERATION,
    patterns: /(generate an image|create an image|draw a picture|make an illustration|render an image|image generation|create a logo)/i,
    caps: caps({ needsImageGeneration: true }),
  },
  {
    type: TaskType.IMAGE_EDITING,
    patterns: /(edit this image|modify the image|remove the background|change the colors in|retouch|image editing)/i,
    caps: caps({ needsImageEditing: true, needsVision: true }),
  },
  {
    type: TaskType.SUMMARIZATION,
    patterns: /(summarize|summary of|tl;dr|condense|short version of)/i,
    caps: caps({}),
  },
  {
    type: TaskType.MEMORY_RECALL,
    patterns: /(what did i|what happened|recall|remember when|what is stored|fetch my|from our history)/i,
    caps: caps({}),
  },
  {
    type: TaskType.MEMORY_SYNTHESIS,
    patterns: /(synthesize|combine my knowledge|create a knowledge summary|memorize this|save to memory)/i,
    caps: caps({ needsReasoning: true }),
  },
  {
    type: TaskType.DOCUMENTATION,
    patterns: /(documentation|write docs|document the|readme|user guide|api docs|explain how to use)/i,
    caps: caps({ needsCoding: true }),
  },
  {
    type: TaskType.TASK_PLANNING,
    patterns: /(plan the implementation|make a plan|break down this task|create a roadmap|which steps)/i,
    caps: caps({ needsReasoning: true }),
  },
  {
    type: TaskType.AUTONOMOUS_ENGINEERING,
    patterns: /(autonomously|autonomous|work on this independently|take over as an engineer|full task from start to finish)/i,
    caps: caps({ needsAutonomousAgent: true }),
  },
  {
    type: TaskType.TERMINAL_EXECUTION,
    patterns: /(run this command|execute|terminal|shell command|npm install|build and run|run the script|what happens if i run)/i,
    caps: caps({ needsTools: true, needsFunctionCalling: true }),
  },
  {
    type: TaskType.TOOL_USE,
    patterns: /(use the (git|fetch|search|filesystem|tool)|call a tool|invoke|plugin action)/i,
    caps: caps({ needsTools: true, needsFunctionCalling: true }),
  },
  {
    type: TaskType.BACKGROUND_TASK,
    patterns: /(in the background|async task|scheduled task|nightly|automatic job|cron)/i,
    caps: caps({}),
  },
  {
    type: TaskType.CODING,
    patterns: /(write code|implement|code this|function|component|class|fix|develop|program)/i,
    caps: caps({ needsCoding: true }),
  },
];

export function classifyIntent(signals: IntentSignals): ClassifiedIntent {
  const text = signals.text.trim();

  // Explicit capability hints (e.g. image attachment) dominate: multimodal.
  if (signals.hasImage || signals.capabilityHints?.needsVision) {
    return {
      taskType: TaskType.MULTIMODAL_ANALYSIS,
      capabilityHints: fullCaps({ needsVision: true }),
      candidates: [TaskType.MULTIMODAL_ANALYSIS, TaskType.GENERAL_CHAT],
      reason: 'Request contains image input; routed to a vision-capable model.',
    };
  }
  if (signals.capabilityHints?.needsImageGeneration) {
    return {
      taskType: TaskType.IMAGE_GENERATION,
      capabilityHints: fullCaps({ needsImageGeneration: true }),
      candidates: [TaskType.IMAGE_GENERATION],
      reason: 'Request explicitly requires image generation.',
    };
  }
  if (signals.capabilityHints?.needsAutonomousAgent) {
    return {
      taskType: TaskType.AUTONOMOUS_ENGINEERING,
      capabilityHints: fullCaps({ needsAutonomousAgent: true }),
      candidates: [TaskType.AUTONOMOUS_ENGINEERING],
      reason: 'Request explicitly targets the autonomous engineering path.',
    };
  }

  // Explicit task-type hint (from a coworker definition / autonomous step).
  if (signals.taskTypeHint) {
    const hint = RULES.find((r) => r.type === signals.taskTypeHint);
    if (hint) {
      return {
        taskType: signals.taskTypeHint,
        capabilityHints: fullCaps(hint.caps),
        candidates: [signals.taskTypeHint],
        reason: `Explicit task type provided by the caller (${signals.taskTypeHint}).`,
      };
    }
  }

  if (!text || text.length < 8) {
    return {
      taskType: TaskType.FAST_SIMPLE_QUERY,
      capabilityHints: fullCaps(),
      candidates: [TaskType.FAST_SIMPLE_QUERY, TaskType.GENERAL_CHAT],
      reason: 'Short/empty query classified as fast simple query.',
    };
  }

  for (const rule of RULES) {
    if (rule.patterns.test(text)) {
      return {
        taskType: rule.type,
        capabilityHints: fullCaps(rule.caps),
        candidates: [rule.type, TaskType.GENERAL_CHAT],
        reason: `Detected "${rule.type}" from request signals.`,
      };
    }
  }

  // Attachments but no vision hint => general chat with tool use possible.
  if (signals.hasAttachment || signals.hasFile) {
    return {
      taskType: TaskType.GENERAL_CHAT,
      capabilityHints: fullCaps({ needsTools: true }),
      candidates: [TaskType.GENERAL_CHAT],
      reason: 'General request with attached files; tool-capable model preferred.',
    };
  }

  return {
    taskType: TaskType.GENERAL_CHAT,
    capabilityHints: fullCaps(),
    candidates: [TaskType.GENERAL_CHAT],
    reason: 'No strong intent signals; routed as general chat.',
  };
}