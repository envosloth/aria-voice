// Routing logic for the LLM <-> agent-harness coordinator. Pure + unit-testable.
//
// Decides whether a user message goes to the regular conversational LLM or the
// agent harness. The order below IS the design — a decision list, highest
// priority first, each rule anchored to a phrasing a person says out loud:
//
//   1. explicit "use the agent" / "just chat" phrasing wins outright
//   2. writing FOR the user (poem, song, regex, grammar, an email draft),
//      hypotheticals ("pretend to search", "if you were a…") and negated tool
//      asks ("don't search, just guess") are chat; changing the machine is rule 5
//   3. an explicit reference to the screen ("on my screen", "I'm looking at")
//      belongs to the agent: it is the only target that can see or touch it
//   4. an imperative order — including a deictic one ("read this error", "fix
//      this regex") — beats a question framing ("google who invented the
//      telescope" is an order, not a question)
//   5. a machine or account change (file, branch, key, timer, calendar, order)
//   6. KNOWLEDGE framing ("explain…", "why is…", "what does this code do") is
//      chat — unless it is about MY system failing, which needs the agent to look
//   7. navigation / proximity lookups ("near me", "how do I get to…")
//   8. advice framing ("what's the best way to…", "should I…", "how do I…") is chat
//   9. remaining live-data lookups: time, weather, news, prices, money conversion
//  10. implicit asks from real life ("my hands are full, can you make it
//      quieter", "don't let me forget to call the dentist")
//  11. the broad keyword list (coding / files / tools / live nouns)
//  12. stickiness on the previous target for short continuations
//  13. default: chat
//
// Rules 6 and 8 exist because the broad keyword list in rule 10 matches NOUNS.
// "How do I take a screenshot on a Mac?", "what does this code do" and "what's
// the best way to back up my files" are knowledge questions that happen to
// contain tool words; 6/8 run first so the question framing wins.

export type Target = 'llm' | 'harness';

// Explicit "use the agent/harness" (or the opposite) phrasing. Exported so the
// local-intent layer (local-intents.ts) never hijacks an explicit agent ask.
export const EXPLICIT_HARNESS =
  /\b(use|using|ask|via|with|through)\s+(the\s+)?(agent|harness|coder\b|codex|claude\s*code)|^\s*(agent|harness)[,:]|\blet (?:the )?(?:agent|coder\b|harness)\b|\bhand (?:this|it|that) (?:over )?to the (?:agent|harness|coder\b)\b|\buse (?:your|the) (?:tools?|abilities|computer)\b|\bwith (?:your|the) tools\b/i;
const EXPLICIT_LLM =
  /\b(just\s+(chat|talk|answer)|no\s+(agent|harness|code|tools)|don'?t\s+use\s+the\s+(agent|harness)|without (?:the )?(?:agent|tools))\b/i;

// Rule 2: writing FOR the user is chat. The nouns name a deliverable a chat
// model produces inline — as opposed to a machine change, which rule 5 claims.
const CREATIVE_WRITE =
  /\b(?:write|draft|compose|tell|make up|give me)\b[^.]{0,30}\b(?:story|poem|haiku|song|lyrics|joke|paragraph|essay|letter|monologue|scene|speech|toast|blurb|caption|tweet|blog post|regex|regular expression|subject line|synonym|outline|draft)\b/i;

// Fixing someone's GRAMMAR is a writing task for the user, not a machine
// change — "fix my grammar" must not ride in on "fix the bug".
const LANGUAGE_FIX =
  /\bfix (?:my |the )?(?:grammar|spelling|typos?|punctuation|wording|phrasing|sentence|english)\b|\bcorrect (?:my|the) (?:grammar|spelling|sentence|wording)\b|\bfix (?:my|this) (?:text|email|message|essay|paragraph)\b/i;

// A negated tool request is the opposite of a tool request ("don't search,
// just give me your best guess").
const NEGATED_TOOL =
  /\b(?:don'?t|do not|no need to|without|stop)\s+(?:search(?:ing)?|look(?:ing)? (?:it|that) up|google|googl(?:e|ing)|brows(?:e|ing)|using (?:the )?(?:tools?|agent|harness))\b/i;

// A hypothetical, a hypothetical tool request, or a description of a system are
// explanations, not work: "how would you set a timer if you were a kitchen
// assistant", "pretend to search the web", "what would a reminder system store".
const HYPOTHETICAL =
  /\b(?:if you (?:were|are)|pretend(?:ing)? (?:to|that|you)|hypotheticall?y|in theory|theoretically|imagine (?:that|you)|what would (?:you|a|an|the|it|happen)|how would you\b(?!\s+(?:like|you)))\b/i;

// Composing text for the user (a draft, an email body, a note) is a writing
// task; SENDING it is rule 4/5.
const WRITE_TEXT =
  /\b(?:draft|write|compose|polish|rewrite|edit)\b[^.]{0,25}\b(?:e?mail|message|reply|note|letter|apology|invitation|caption|bio|resume|cover letter|text)\b/i;

// Rule 3: the user is pointing at their screen. Only the agent can see it, so a
// description of WHAT is on screen must never come from the chat model's
// imagination.
// Only the hard cues ("on my screen", "this window") decide the route on their
// own. "I'm looking at" is softer — a chat model can still summarize a document
// the user is describing — so it counts when the same sentence asks for an
// ACTION on it (see DEICTIC_ACTION); otherwise the knowledge/advice rules win.
const ON_SCREEN =
  /\b(?:on my screen|on the screen|on my display|in front of me|what am i looking at|what'?s on my screen|highlighted (?:text|code)|this window|that window|error dialog on my screen)\b|\bi(?:'m| am) looking at\b[^.]{0,40}\b(?:fix|click|copy|read|edit|paste|open|close)\b|\bwhat does (?:this|that) say\b|^(?:please |can you )?(?:summari[sz]e|read|explain|translate|fix|check|look at) (?:this|that|it)\b[^.]{0,25}$|\bread (?:me )?(?:that|this|it|the last part)\b[^.]{0,20}\b(?:out loud|aloud|again)\b/i;

// Rule 4: imperative orders at the start of the message. Start-anchored so a
// noun mid-sentence can't trigger it, with a bounded action-verb vocabulary.
const ACTION =
  /^\s*(?:please\s+|can you\s+|could you\s+|would you\s+|go ahead and\s+|hey aria[,\s]+)*(open|launch|play|pause|resume|skip|mute|unmute|turn|set|send|text|email|call|remind|schedule|book|order|buy|reserve|navigate|download|install|uninstall|update|upgrade|enable|disable|check|find|search|look up|lookup|google|bing|search the web|show me|get me|pull up|bring up|take a|start|stop|go to|switch|toggle|change|adjust|raise|lower|increase|decrease|run|re-?run|execute|build|re-?build|compile|deploy|commit|push|pull|merge|rebase|revert|edit|rename|delete|create|write|add|save|copy|paste|move|grep|click|press|type|select|scroll|compute|calculate|fix|patch|refactor|kill|restart|shut down|lock|clear|wipe|screenshot|cancel|dismiss|connect|disconnect|undo|dim|brighten|warm|douse|put)\b/i;

// Rule 4 (deictic): a verb applied to "this/that <thing>", which only makes
// sense as an instruction about something the machine is showing.
const DEICTIC_ACTION =
  /\b(?:read|click|press|copy|paste|highlight|open|fix|patch|refactor|run|grep|check|edit|delete|remove|rename|merge|rebase|scroll|select|type|compute|calculate|inspect)\b[^.]{0,24}\b(?:this|that|the) (?:error|code|message|log|stack ?trace|trace|document|doc|page|window|dialog|screenshot|chart|image|graph|text|button|regex|function|snippet|script|file|output|config)\b/i;

// Rule 5: machine / account changes a chat model cannot perform. These outrank
// a knowledge framing because the user is asking to change a system.
const MACHINE_CHANGE =
  /^\s*(?:please\s+|can you\s+|could you\s+|would you\s+|go ahead and\s+|hey aria[,\s]+)*(?:write|create|make|generate|add|save|set up|rename|delete|remove|move|copy)\b[^.]{0,45}\b(file|files|folder|directory|note|notes|doc|document|script|branch|commit|tag|key|keys|ssh key|config|config file|cron job|cron|calendar invite|calendar event|invite|event|reminder|alarm|timer|task|tarball|archive|backup|symlink|env file|\.txt|\.md|\.json|\.sh|\.py|\.js|\.ya?ml|\.toml|\.csv)\b|\b(?:write|create|add|make)\b[^.]{0,30}\ba (?:test|tests|check|route|endpoint|function|class|method)\b[^.]{0,30}\b(?:file|repo|repository|module|parser|handler|codebase|app|server)\b|\badd\b[^.]{0,30}\bto (?:my|the) (?:shopping )?list\b/i;

// Rule 6: knowledge framing — the user wants to understand something.
const CHAT_KNOWLEDGE =
  /^\s*(?:can you |could you |could you please |please |quick question[,\s]*|so )*(?:explain|describe|teach me|walk me through|talk me through|help me understand|define|summari[sz]e|tell me about|give me (?:an? )?(?:overview|summary) of)\b|\bwhat does (?:the )?(?:word|term|phrase|acronym) .{1,40}\bmean\b|\bwhat does .{1,40}\b(?:do|return|mean|set|use|stand for)\b|\bwhat(?:'s| is) the difference between\b|\bwhat are the differences\b|\bwhy (?:is|are|does|do|did|can'?t)\b|\bwhen (?:was|were|did)\b|\bwhat (?:was|were)\b|\bhow (?:does|do|did) \w+|\bwho (?:invented|wrote|discovered|created|was the)\b|\bteach me (?:about|how)\b|\bexplain (?:to me )?(?:how|why|what)\b/i;

// Rule 6 exception: the question is about a failure or result of MY system, so
// answering it means looking at the machine, not reciting knowledge.
const MY_SYSTEM_TROUBLE =
  /\bmy (?:build|deploy|deployment|benchmark|test|tests|test suite|pipeline|container|cluster|branch|repo|repository|app|application|server|machine|disk|drive|backup)\b[^.]{0,40}\b(?:fail|failed|failing|broke|broken|crash|crashed|error|errors|down|stuck|hung|slow)\b|\bwhy (?:did|does) my\b[^.]{0,30}\b(?:fail|break|crash|hang|stop working)\b|\bexplain (?:the )?(?:results|output|numbers) of my\b|\bwhat(?:'s| is) wrong with my\b/i;

// A knowledge framing still means live data when the sentence asks about NOW —
// "explain what the weather is right now" wants the agent, not a lecture.
const KNOWLEDGE_LIVE_OVERRIDE =
  /\b(?:right now|currently|at the moment|today|tonight|tomorrow|this (?:week|weekend|month)|latest|most recent|near me|nearby|in my area)\b/i;

// Rule 7: live world data.
const LIVE_DATA =
  /\b(?:weather|forecast|temperature|humidity|raining|rain|snowing|snow|sunny|cloudy|windy|storm|umbrella|sunrise|sunset|uv index|air quality|pollen|news|headlines|breaking news|stock price|stock market|share price|scores?|standings|who'?s winning|who is winning|who won|exchange rate|bitcoin|ethereum|crypto|price of|how much is|market cap|this week|this weekend|right now|currently|the latest|most recent|newest|up[- ]?to[- ]?date|current version|latest version|what'?s happening|what'?s going on in the world)\b/i;

// Rule 7: navigation / proximity / place lookups.
// A question about a specific place's opening/reservation behaviour is a live
// lookup ("does that place take reservations").
const PLACE_LOOKUP =
  /\b(?:does|do|is|are) (?:that|this|the) (?:\w+ )?(?:place|restaurant|store|shop|hotel|gym|clinic|venue|cafe|bar)\b[^.]{0,25}\b(?:open|take|accept|have|allow|serve|close|deliver|book)\b/i;

// Habits and replays: "do the usual" repeats a routine, which needs the agent.
const REPEAT_ROUTINE = /\b(?:do the usual|same as (?:last time|before|always|usual)|like last time|the usual please)\b/i;

const NAVIGATE =
  /\b(?:directions? to|take me to|drive me to|route to|how (?:do i|can i|do you) get to|how far (?:is|away|to|from)|nearest|closest|near me|nearby|around here|in my area|open now|open today|store hours|business hours|is .{1,30} open)\b/i;

// Rule 7: time / date about now.
const TIME_DATE =
  /\b(?:what time|what'?s the time|time is it|time it is|current time|tell me the time|got the time|what day|what'?s the date|what is the date|today'?s date|current date|date today|what'?s today|what month|what year is it)\b/i;

// Rule 8: advice framing is chat even when it names a device or a file.
const CHAT_ADVICE =
  /\b(?:the|a|any|my) (?:best|good|better|smartest|cheapest|quickest) (?:way|option|approach|choice|place)\b|\bwhat(?:'s| is) a good\b|\bwhat are (?:some )?good\b|\brecommend (?:a|some|any|me)\b|\bshould i\b|\bwould you (?:recommend|suggest)\b|\b(is|are|does) (?:it|this|that) (?:healthy|safe|ok|okay|fine|better|worth|normal|a good idea)\b|\bhow (?:can|do) i (?:get better|learn|improve|become|train|start|avoid)\b|\bhelp me (?:decide|choose|think|plan|understand)\b|\bwhat should i\b|\btips for\b|\badvice\b|\bhow (?:do|can|would|should|might) i\b|\bhow do you\b/i;

// Rule 9: implicit asks. Real speech often describes a state and expects the
// machine to act.
const IMPLICIT_DEVICE =
  /\b(?:make it|turn it|bump|lower|raise|crank|set it|put the) (?:up|down|higher|lower|warmer|cooler|quieter|louder|brighter|dimmer|darker)\b|\bbump[^.]{0,20}\b(?:heat|temperature|volume|thermostat)\b|\b(?:too|really|so) (?:loud|quiet|hot|cold|bright|dark|dim)\b|\bpitch (?:dark|black)\b|\b(?:thermostat|air conditioning)\b|\bit'?s freezing in here\b/i;
const IMPLICIT_MESSAGE =
  /\b(?:let|get|keep|have) (?:my )?(?:mom|mum|dad|sister|brother|wife|husband|partner|boss|team|family|him|her|them|everyone)\b[^.]{0,24}\b(?:know|in the loop|posted|updated|ahead|aware|informed)\b|\b(?:tell|let) (?:him|her|them|mom|dad|the team|my boss) (?:that|i'?m|i am)\b|\bi'?m (?:running late|on my way|running behind)\b/i;
const IMPLICIT_REMIND = /\b(?:don'?t let me forget|make sure i (?:don'?t forget|remember))\b/i;
const IMPLICIT_ORDER = /\b(?:i'?m|im) (?:out of|running low on|all out of)\b[^.]{0,30}\b(?:get|order|buy|pick up|add|grab)\b|\bget me (?:some|more|another|a|an)\b/i;
const IMPLICIT_LOOKUP =
  /\b(?:look (?:that|it|this) up|search for it)\b[^.]{0,15}\b(?:online|on the web|on the internet)\b|\bgo look (?:that|it) up\b/i;

// Money conversion and cross-store comparison are lookups the assistant is
// expected to perform (a live rate, three shop pages) rather than arithmetic.
const CURRENCY_CONVERT =
  /\b(?:dollars?|euros?|pounds?|yen|pesos?|francs?)\b[^.]{0,25}\b(?:to|in|into)\b[^.]{0,12}\b(?:dollars?|euros?|pounds?|yen|pesos?|francs?)\b|\bexchange rate\b|\bat today'?s rate\b/i;

const SHOPPING_COMPARE =
  /\bcompare\b[^.]{0,40}\b(?:stores?|prices?|retailers?|shops?|online)\b|\bfind (?:me )?the cheapest\b|\bcheapest (?:one|option|price)\b/i;

// Rule 11: the broad keyword list — coding / files / system AND tool / live
// intent. Deliberately generous: when a request plausibly needs a tool, prefer
// the tool-capable agent. Reached only after rules 2-9.
const AGENTIC = new RegExp(
  '\\b(' + [
    // coding / files / system
    'code', 'coding', 'refactor', 'refactoring', 'debug', 'debugging', 'bug',
    'implement', 'implementation', 'function', 'class', 'method', 'variable',
    'file', 'files', 'directory', 'folder', 'repo', 'repository', 'commit', 'branch',
    'pull request', 'merge', 'diff', 'git',
    'run', 'execute', 'build', 'compile', 'deploy', 'install', 'uninstall', 'script', 'command',
    'terminal', 'shell', 'lint', 'package', 'dependency',
    'api', 'endpoint', 'database', 'query', 'sql', 'server', 'docker',
    'edit', 'rename', 'delete', 'create a', 'write a', 'add a',
    // weather / environment (live)
    'weather', 'forecast', 'temperature', 'humidity', 'raining', 'rain', 'snow',
    'sunny', 'cloudy', 'windy', 'storm', 'umbrella', 'sunrise', 'sunset',
    'uv index', 'air quality', 'pollen',
    // time / date (live)
    'what time', 'time is it', 'time it is', 'do you know what time', 'tell me the time',
    'what day', 'what.s the date', 'todays date', "today's date", 'date today',
    'current time', 'current date',
    // news / finance / sports (live)
    'news', 'headlines', 'stock', 'stocks', 'shares', 'market', 'crypto',
    'bitcoin', 'ethereum', 'price of', 'how much is', 'exchange rate', 'currency',
    'score', 'scores', 'standings', 'latest score', 'final score',
    // search / web / research
    'search', 'search for', 'look up', 'lookup', 'google', 'bing', 'wikipedia',
    'browse', 'website', 'on the internet',
    // navigation / places (live)
    'directions', 'navigate', 'route to', 'nearest', 'nearby', 'near me',
    'traffic', 'how long to get',
    // device / system actions
    'volume', 'brightness', 'mute', 'flashlight', 'wifi', 'bluetooth',
    'battery', 'screenshot', 'screen', 'what.s on my',
    // comms / productivity
    'email', 'emails', 'messages', 'inbox', 'inboxes', 'whatsapp', 'slack', 'calendar',
    'meeting', 'meetings', 'appointment', 'appointments',
    'schedule a', 'remind me', 'reminder', 'set a timer', 'set an alarm',
    'alarm', 'alarms', 'timer', 'timers', 'reminder', 'reminders', 'shopping list', 'add to my',
    // commerce
    'calculate', 'book a', 'place an order', 'reserve a',
  ].join('|') + ')\\b',
  'i',
);

// The previous reply's subject is still live ("what about tomorrow?").
const REALTIME =
  /\b(?:right now|currently|the latest|most recent|newest|up[- ]?to[- ]?date|current version|latest version|near me|nearby|around here|in my area|my area|local events?|open now|open today|store hours|business hours|this (week|weekend|month|year)|what time|what'?s the time|what day|what'?s the date|what is the (weather|time|forecast|date|temperature|score|price)|events? (today|tonight|tomorrow|yesterday|last night|near me|in my area)|fireworks? (show|shows|event|events|happened|near|tonight|tomorrow|yesterday|last night)|happened (yesterday|last night)|(did|has|have) .{1,60}\b(win|won|beat|lose|lost)\b (today|tonight|yesterday|last night)|who (?:won|is winning|'s winning|are they playing)\b[^.]{0,40}\b(last night|tonight|today|yesterday|right now|currently|just now|the (?:game|match|series)|this (?:week|evening|afternoon|season)))\b/i;

// Device state read as a request rather than an imperative ("what's my battery
// at", "how much space is left").
const DEVICE_STATE =
  /\b(?:what'?s|whats|check|show|how much) (?:is )?(?:my|the) (?:battery|charge|volume|brightness|disk|storage|memory|cpu|gpu|ram)\b|\bbattery (?:level|percentage|life)\b|\b(?:wifi|wi-?fi|bluetooth|vpn|airplane mode) (?:on|off|connected|status)\b|\bis (?:the )?(?:wifi|bluetooth|vpn) (?:on|off|enabled)\b|\bhow much (?:disk|storage|space|memory) (?:is )?(?:left|free|used)\b/i;

// Timers / alarms / reminders — anchored at the start, so a question ABOUT
// reminders ("should I set a reminder for…") isn't captured.
const TIMER_COMMAND =
  /^\s*(?:please\s+|can you\s+|could you\s+)*(?:set|start|cancel|stop|clear|remove|delete|kill|snooze|dismiss)\b[^.]{0,30}\b(timer|alarm|reminder|countdown)\b|^\s*(?:please\s+)?remind me\b(?!\s+(?:what|when|where|who|why|how|if|whether|about|of|that))|^\s*(?:what|which|any|list)\b[^.]{0,20}\b(timers|alarms|reminders)\b/i;

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

  const text = message || '';

  // 1. Explicit asks win outright.
  if (EXPLICIT_LLM.test(text)) return 'llm';
  if (EXPLICIT_HARNESS.test(text)) return 'harness';

  // 2. Writing something FOR the user (poem, regex, grammar fix, text) is chat,
  // whatever nouns it contains; and a negated tool request is not a tool request.
  if (CREATIVE_WRITE.test(text) || LANGUAGE_FIX.test(text) || NEGATED_TOOL.test(text)) return 'llm';
  if (HYPOTHETICAL.test(text)) return 'llm';
  // "just draft me an apology" is writing; the same sentence WITH a send verb is
  // caught by the imperative rule above ("send the apology I drafted").
  if (WRITE_TEXT.test(text) && !/\b(?:send|post|publish|mail|deliver|submit|reply all)\b/i.test(text)) return 'llm';

  // 3. Anything the user points at on screen belongs to the agent, which is the
  // only target that can see or touch it ("summarize the document I'm looking at"
  // must not be answered out of the chat model's imagination).
  if (ON_SCREEN.test(text)) return 'harness';

  // 4. An imperative is an order, even when the rest of the sentence reads like a
  // question ("google who invented the telescope") or the object is deictic
  // ("fix this regex", "read this error to me").
  if (ACTION.test(text) || TIMER_COMMAND.test(text) || DEVICE_STATE.test(text)) return 'harness';
  if (DEICTIC_ACTION.test(text)) return 'harness';

  // 5. A machine or account change the chat model cannot perform.
  if (MACHINE_CHANGE.test(text)) return 'harness';

  // 6. Knowledge framing is chat — unless the question is about my own system
  // failing (that needs the agent to look), or asks for NOW data.
  // A live-data word inside a question about habits, history or another world is
  // still knowledge: "what's the weather usually like in Denver in May",
  // "what is the weather like on Jupiter", "when was the kitchen timer invented".
  const TIMELESS = /\b(?:usually|typically|generally|normally|on average|in general|these days|at this time of year|historically|in \d{4}|on (?:mars|jupiter|venus|saturn|the moon)|in (?:space|history)|centur(?:y|ies)|ancient|medieval|invented|history of)\b/i;
  if (CHAT_KNOWLEDGE.test(text) && !MY_SYSTEM_TROUBLE.test(text) && !KNOWLEDGE_LIVE_OVERRIDE.test(text) && !NAVIGATE.test(text)) {
    return 'llm';
  }
  if (LIVE_DATA.test(text) && TIMELESS.test(text) && !KNOWLEDGE_LIVE_OVERRIDE.test(text)) return 'llm';
  if (MY_SYSTEM_TROUBLE.test(text)) return 'harness';

  // 7. Proximity / navigation and device-state questions are live lookups.
  if (NAVIGATE.test(text)) return 'harness';

  // 8. Advice framing is chat even when it names a device, a file, or the
  // weather. A question ABOUT doing something ("how do I take a screenshot",
  // "how would I check the weather from a shell script") is advice, not an order
  // — someone who wants it done says "take a screenshot".
  // Advice framing loses to a live lookup that asks about now or about what is
  // about to happen ("is it going to rain, or should I bring the umbrella"),
  // but keeps it when the user asks HOW one would do it ("how would I check the
  // weather from a shell script").
  const liveNow = LIVE_DATA.test(text)
    && (KNOWLEDGE_LIVE_OVERRIDE.test(text) || /\b(?:is it|will it|going to|tonight|this (?:evening|afternoon|morning))\b/i.test(text));
  if (CHAT_ADVICE.test(text) && !liveNow) return 'llm';

  // 9. Remaining live-data lookups: time, weather, news, prices.
  if (TIME_DATE.test(text) || LIVE_DATA.test(text)) return 'harness';
  if (PLACE_LOOKUP.test(text) || REPEAT_ROUTINE.test(text)) return 'harness';
  if (CURRENCY_CONVERT.test(text) || SHOPPING_COMPARE.test(text)) return 'harness';

  // 10. Implicit asks — a described state plus an expected action.
  if (IMPLICIT_DEVICE.test(text) || IMPLICIT_MESSAGE.test(text) || IMPLICIT_REMIND.test(text)) return 'harness';
  if (IMPLICIT_ORDER.test(text) || IMPLICIT_LOOKUP.test(text)) return 'harness';

  // 11. Broad agentic / tool keyword list.
  if (AGENTIC.test(text) || REALTIME.test(text)) return 'harness';

  // 12. Stickiness: if the agent handled the previous turn, keep this turn on the
  // agent when it's a continuation — a short follow-up OR an answer to a question
  // the agent just asked. Explicit "just chat" above already escapes this.
  if (cfg.lastTarget === 'harness' && (cfg.lastWasQuestion || isContinuation(text))) return 'harness';

  // 13. Default: chat.
  return 'llm';
}
