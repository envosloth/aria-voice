// Routing logic for the LLM <-> agent-harness coordinator. Pure + unit-testable.
//
// Decides whether a user message should go to the regular conversational LLM or
// the agent harness. Explicit phrasing wins; otherwise an agentic-intent
// heuristic routes coding/tool/file/system tasks to the harness.

export type Target = 'llm' | 'harness';

// Explicit "use the agent/harness" (or the opposite) phrasing.
const EXPLICIT_HARNESS = /\b(use|using|ask|via|with|through)\s+(the\s+)?(agent|harness|coder?|codex|claude\s*code)\b|^\s*(agent|harness)[,:]/i;
const EXPLICIT_LLM = /\b(just\s+(chat|talk|answer)|no\s+(agent|harness|code)|don'?t\s+use\s+the\s+(agent|harness))\b/i;

// Agentic-intent keywords (coding / files / system) AND tool/real-time intent
// (live data or device actions the harness can do via tools, which a plain chat
// LLM cannot). Matched anywhere in the message. Deliberately broad: for a voice
// assistant, when a request plausibly needs a tool we prefer the tool-capable
// harness over the chat LLM — the old narrow list is what let clear tool
// requests ("what time is it", "set a timer", "will it rain tomorrow") fall
// through to the direct LLM. Ambiguous VERBS (open/play/send/…) live in ACTION
// below (start-anchored) so conversational filler ("in order to", "note that")
// doesn't trip them.
const AGENTIC = new RegExp(
  '\\b(' + [
    // coding / files / system
    'code', 'coding', 'refactor', 'refactoring', 'debug', 'debugging', 'bug', 'fix',
    'implement', 'implementation', 'function', 'class', 'method', 'variable',
    'file', 'files', 'directory', 'folder', 'repo', 'repository', 'commit', 'branch',
    'pull request', 'merge', 'diff', 'git',
    'run', 'execute', 'build', 'compile', 'deploy', 'install', 'uninstall', 'script', 'command',
    'terminal', 'shell', 'test', 'tests', 'lint', 'package', 'dependency',
    'api', 'endpoint', 'database', 'query', 'sql', 'server', 'docker',
    'edit', 'rename', 'delete', 'create a', 'write a', 'add a',
    // weather / environment (live)
    'weather', 'forecast', 'temperature', 'humidity', 'raining', 'rain', 'snow',
    'sunny', 'cloudy', 'windy', 'storm', 'umbrella', 'sunrise', 'sunset',
    'uv index', 'air quality', 'pollen',
    // time / date (live) — more phrasing variants so a paraphrased "what's the
    // current time" or "do you know what time it is" reliably routes to the
    // harness. The old list missed "do you know" / "can you tell me" prefixes,
    // so casual phrasings leaked to the chat LLM and got hallucinated answers.
    'what time', 'time is it', 'time it is', 'do you know what time', 'tell me the time',
    'what day', 'what.s the date', 'todays date', "today's date", 'date today',
    'current time', 'current date',
    // news / finance / sports (live)
    'news', 'headlines', 'stock', 'stocks', 'shares', 'market', 'crypto',
    'bitcoin', 'ethereum', 'price of', 'how much is', 'exchange rate', 'currency',
    'score', 'scores', 'who won', 'standings', 'who is winning', 'latest score',
    // search / web / research
    'search', 'search for', 'look up', 'lookup', 'google', 'bing', 'wikipedia',
    'browse', 'website', 'on the internet',
    // navigation / places (live)
    'directions', 'navigate', 'route to', 'nearest', 'nearby', 'near me',
    'traffic', 'how far', 'how long to get',
    // device / system actions
    'volume', 'brightness', 'mute', 'flashlight', 'wifi', 'bluetooth',
    'battery', 'screenshot', 'screen', 'what.s on my',
    // comms / productivity
    'email', 'inbox', 'whatsapp', 'slack', 'calendar', 'meeting', 'appointment',
    'schedule a', 'remind me', 'reminder', 'set a timer', 'set an alarm',
    'alarm', 'timer', 'shopping list', 'add to my',
    // conversions / utilities / commerce
    'convert', 'how many', 'translate', 'translation', 'calculate',
    'book a', 'place an order', 'reserve a',
  ].join('|') + ')\\b',
  'i',
);

// Strong real-time signals: when present, the answer depends on the live world,
// so it needs tools -> harness. Kept tight (no bare "today"/"tonight") so casual
// pleasantries like "how are you today" aren't misrouted. Added a few more
// variants (right now / currently / latest) and an explicit "what is the
// weather/temperature/forecast/time" so the common phrasings never fall through.
const REALTIME =
  /\b(right now|currently|the latest|up[- ]?to[- ]?date|near me|nearby|around here|in my area|my area|local events?|this (week|weekend|month|year)|what time|what'?s the time|what day|what'?s the date|what is the (weather|time|forecast|date|temperature|score|price)|events? (today|tonight|tomorrow|yesterday|last night|near me|in my area)|fireworks? (show|shows|event|events|happened|near|tonight|tomorrow|yesterday|last night)|happened (yesterday|last night))\b/i;

// Imperative device/tool actions at the START of the message -> harness. Limited
// to verbs that imply DOING something (not "tell/explain/describe/what/how",
// which are conversational), and start-anchored so they don't match mid-sentence
// filler. Added a few more common action verbs ("set", "start", "stop", "go to")
// so a paraphrased "go to wikipedia" or "set brightness to 50" reliably routes.
const ACTION =
  /^\s*(open|launch|play|pause|resume|skip|mute|unmute|turn|set|send|call|text|email|remind|schedule|book|order|buy|reserve|navigate|download|install|update|upgrade|enable|disable|check|find|search|look up|show me|get me|pull up|bring up|take a|start|stop|go to|switch|toggle|change|adjust|raise|lower|increase|decrease)\b/i;

// Screen-share vision detail. The OpenAI-compatible `image_url.detail` controls
// how hard the vision model works: "high" tiles the image into 512px tiles (many
// tokens, slow TTFT) while "low" is a single ~512px low-res pass (flat, fast). A
// general "what's on my screen / what am I looking at" glance doesn't need fine
// detail, so it goes "low" for a much faster reply; anything that implies READING
// fine content (text, code, an error) keeps "high" so legibility isn't lost. This
// is the main lever on the "every turn is slow while screen sharing" delay.
const VISION_GLANCE =
  /\b(what'?s on (my|the) (screen|display|monitor)|what am i (looking at|seeing|on)|what (app|window|program|tab|page|site)|which (app|window|program|tab)|what'?s this|what is this|what do you see|describe (my|the|this) (screen|display|page|window)|give me (a|an) (overview|summary) of (my|the) screen)\b/i;

export function visionDetailFor(message: string): 'low' | 'high' {
  return VISION_GLANCE.test(message || '') ? 'low' : 'high';
}

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
  if (AGENTIC.test(text) || REALTIME.test(text) || ACTION.test(text)) return 'harness';
  // Stickiness: if the agent harness handled the previous turn, keep this turn on
  // the harness when it's a continuation — either a short follow-up OR an answer
  // to a question the harness just asked (e.g. it asked "where are you?" and the
  // user replies with their location). This keeps the multi-turn task on one
  // target with full context instead of dropping the answer to the LLM. Explicit
  // "just chat" above already escapes this.
  if (cfg.lastTarget === 'harness' && (cfg.lastWasQuestion || isContinuation(text))) return 'harness';
  return 'llm';
}
