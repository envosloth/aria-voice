// Routing logic for the LLM <-> agent-harness coordinator. Pure + unit-testable.
//
// Decides whether a user message should go to the regular conversational LLM or
// the agent harness. Explicit phrasing wins; otherwise an agentic-intent
// heuristic routes coding/tool/file/system tasks to the harness.

export type Target = 'llm' | 'harness';

// Explicit "use the agent/harness" (or the opposite) phrasing.
const EXPLICIT_HARNESS = /\b(use|using|ask|via|with|through)\s+(the\s+)?(agent|harness|coder?|codex|claude\s*code)\b|^\s*(agent|harness)[,:]/i;
const EXPLICIT_LLM = /\b(just\s+(chat|talk|answer)|no\s+(agent|harness|code)|don'?t\s+use\s+the\s+(agent|harness))\b/i;

// Agentic-intent keywords (coding / files / system / tools).
const AGENTIC = new RegExp(
  '\\b(' + [
    'code', 'coding', 'refactor', 'refactoring', 'debug', 'debugging', 'bug', 'fix',
    'implement', 'implementation', 'function', 'class', 'method', 'variable',
    'file', 'files', 'directory', 'folder', 'repo', 'repository', 'commit', 'branch',
    'pull request', 'merge', 'diff', 'git',
    'run', 'execute', 'build', 'compile', 'deploy', 'install', 'script', 'command',
    'terminal', 'shell', 'test', 'tests', 'lint', 'package', 'dependency',
    'api', 'endpoint', 'database', 'query', 'sql', 'server', 'docker',
    'edit', 'rename', 'delete', 'create a', 'write a', 'add a',
  ].join('|') + ')\\b',
  'i',
);

export interface RouteConfig {
  mode: 'auto' | 'llm' | 'harness';
  hasLlm: boolean;       // a conversational LLM endpoint is configured
  hasHarness: boolean;   // an agent harness endpoint is configured
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
  return 'llm';
}
