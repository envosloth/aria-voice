// Routing logic for the LLM <-> agent-harness coordinator. Pure + unit-testable.
//
// Decides whether a user message should go to the regular conversational LLM or
// the agent harness. Explicit phrasing wins; otherwise an agentic-intent
// heuristic routes coding/tool/file/system tasks to the harness.

export type Target = 'llm' | 'harness';

// Explicit "use the agent/harness" (or the opposite) phrasing.
const EXPLICIT_HARNESS = /\b(use|using|ask|via|with|through)\s+(the\s+)?(agent|harness|coder?|codex|claude\s*code)\b|^\s*(agent|harness)[,:]/i;
const EXPLICIT_LLM = /\b(just\s+(chat|talk|answer)|no\s+(agent|harness|code)|don'?t\s+use\s+the\s+(agent|harness))\b/i;

// Agentic-intent keywords (coding / files / system) AND real-time/tool intent
// (live data the harness can fetch via tools, which a plain LLM cannot). The
// real-time group fixes the "give me the weather -> go ask Alexa" failure: such
// queries need tools, so they belong on the harness.
const AGENTIC = new RegExp(
  '\\b(' + [
    // coding / files / system
    'code', 'coding', 'refactor', 'refactoring', 'debug', 'debugging', 'bug', 'fix',
    'implement', 'implementation', 'function', 'class', 'method', 'variable',
    'file', 'files', 'directory', 'folder', 'repo', 'repository', 'commit', 'branch',
    'pull request', 'merge', 'diff', 'git',
    'run', 'execute', 'build', 'compile', 'deploy', 'install', 'script', 'command',
    'terminal', 'shell', 'test', 'tests', 'lint', 'package', 'dependency',
    'api', 'endpoint', 'database', 'query', 'sql', 'server', 'docker',
    'edit', 'rename', 'delete', 'create a', 'write a', 'add a',
    // real-time / tools (needs live data or actions a plain LLM cannot do)
    'weather', 'forecast', 'temperature', 'humidity', 'raining',
    'news', 'headlines', 'stock', 'crypto', 'price of', 'exchange rate',
    'score', 'scores', 'search for', 'look up', 'lookup', 'google',
    'browse', 'website', 'email', 'calendar', 'schedule a', 'remind me',
    'open the', 'screen', 'screenshot', 'what.s on my',
  ].join('|') + ')\\b',
  'i',
);

export interface RouteConfig {
  mode: 'auto' | 'llm' | 'harness';
  hasLlm: boolean;       // a conversational LLM endpoint is configured
  hasHarness: boolean;   // an agent harness endpoint is configured
  lastTarget?: Target | null; // which target handled the previous turn (for stickiness)
  lastWasQuestion?: boolean;  // the previous reply ended with a question (awaiting an answer)
}

// A short reply with no fresh intent is treated as a continuation of the current
// turn (e.g. answering the harness's "where are you?" with "Austin, Texas").
function isContinuation(text: string): boolean {
  const words = text.trim().split(/\s+/).filter(Boolean);
  return words.length > 0 && words.length <= 8;
}

/**
 * Choose a target for `message` given availability + mode.
 * Falls back to whichever is configured if the preferred one isn't.
 */
export function route(message: string, cfg: RouteConfig): Target {
  // Honor a hard mode override (still falling back if that one isn't configured).
  if (cfg.mode === 'llm') return cfg.hasLlm ? 'llm' : 'harness';
  if (cfg.mode === 'harness') return cfg.hasHarness ? 'harness' : 'llm';

  // auto: only one configured -> use it.
  if (cfg.hasHarness && !cfg.hasLlm) return 'harness';
  if (cfg.hasLlm && !cfg.hasHarness) return 'llm';
  if (!cfg.hasLlm && !cfg.hasHarness) return 'llm';

  // Both configured: decide by intent.
  const text = message || '';
  if (EXPLICIT_LLM.test(text)) return 'llm';
  if (EXPLICIT_HARNESS.test(text)) return 'harness';
  if (AGENTIC.test(text)) return 'harness';
  // Stickiness: if the agent harness handled the previous turn, keep this turn on
  // the harness when it's a continuation — either a short follow-up OR an answer
  // to a question the harness just asked (e.g. it asked "where are you?" and the
  // user replies with their location). This keeps the multi-turn task on one
  // target with full context instead of dropping the answer to the LLM. Explicit
  // "just chat" above already escapes this.
  if (cfg.lastTarget === 'harness' && (cfg.lastWasQuestion || isContinuation(text))) return 'harness';
  return 'llm';
}
