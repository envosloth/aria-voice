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
  /\b(use|using|ask|via|with|through)\s+(the\s+)?(agent|harness|coder\b|codex|claude\s*code)|^\s*(?:hey |ok |okay )?(agent|harness)\b[,\s:]|\blet (?:the )?(?:agent|coder\b|harness)\b|\bhand (?:this|it|that) (?:over )?to the (?:agent|harness|coder\b)\b|\buse (?:your|the) (?:tools?|abilities|computer)\b|\bwith (?:your|the) tools\b/i;
const EXPLICIT_LLM =
  /\b(just\s+(chat|talk|answer)|no\s+(agent|harness|code|tools|web search|search|lookup)|don'?t\s+use\s+the\s+(agent|harness)|without (?:the )?(?:agent|tools))\b/i;

// Rule 2: writing FOR the user is chat. The nouns name a deliverable a chat
// model produces inline — as opposed to a machine change, which rule 5 claims.
const CREATIVE_WRITE =
  /\b(?:write|draft|compose|tell|make up|give me)\b[^.]{0,30}\b(?:story|poem|haiku|song|lyrics|joke|paragraph|essay|letter|monologue|scene|speech|toast|blurb|caption|tweet|blog post|regex|regular expression|subject line|synonym|outline|draft|rhyme|verse|limerick|riddle|card message|birthday message|ideas?)\b/i;

// Fixing someone's GRAMMAR is a writing task for the user, not a machine
// change — "fix my grammar" must not ride in on "fix the bug".
const LANGUAGE_FIX =
  /\bfix (?:my |the )?(?:grammar|spelling|typos?|punctuation|wording|phrasing|sentence|english)\b|\bcorrect (?:my|the) (?:grammar|spelling|sentence|wording)\b|\bfix (?:my|this) (?:text|email|message|essay|paragraph)\b/i;
// …unless the thing being fixed is a FILE in a repo ("fix the typo in the
// readme and commit it"), which is machine work.
const FILE_WORK_FIX = /\b(?:readme|file|repo|repository|commit|branch|code|script|log|config|test|build)\b/i;

// A negated tool request is the opposite of a tool request ("don't search,
// just give me your best guess").
const NEGATED_TOOL =
  /\b(?:don'?t|do not|no need to|without|stop)\b(?!\s+(?:forget|forgetting))[^.]{0,18}\b(?:search|searching|look(?:ing)? (?:it|that) up|google|google?ing|brows(?:e|ing)|check(?:ing)?|verify|verifying|using (?:the )?(?:tools?|agent|harness))\b/i;

// A negated ACTION is not an action either: "don't add anything to my calendar,
// I'm just thinking out loud".
const NEGATED_ACTION =
  /\b(?:don'?t|do not|no need to|not going to|won'?t)\b(?!\s+(?:forget|forgetting))[^.]{0,24}\b(?:add|put|send|post|schedule|create|make|set|book|order|buy|text|email|call|delete|move|change|turn|touch|mess with|run|execute|install|deploy|launch)\b/i;
const NEGATED_DEVICE =
  /\b(?:don'?t|do not|no need to)\b(?!\s+(?:forget|forgetting))[^.]{0,20}\b(?:turn (?:it|the)|dim|brighten|lock|restart|shut down|set)\b|\bcan you not\b|\bplease don'?t\b/i;

// A hypothetical, a hypothetical tool request, or a description of a system are
// explanations, not work: "how would you set a timer if you were a kitchen
// assistant", "pretend to search the web", "what would a reminder system store".
const HYPOTHETICAL =
  /\b(?:if you (?:were|are)|pretend(?:ing)? (?:to|that|you)|hypotheticall?y|in theory|theoretically|imagine (?:that|you)|suppos(?:e|ing) (?:i|we|that|you)|what would (?:you|a|an|the|it|happen)|how would you\b(?!\s+(?:like|you)))\b/i;

// Editing the user's OWN text (rewrite, polish, proofread) is chat. Producing a
// deliverable (a note, chart, letter, plan) is a machine change — unless the
// sentence negates the action ("I don't need you to send anything, just draft an
// apology", which is what the chat-model labelers meant).
// Grammar/tense/tone transformations of text the user supplies are chat.
const TEXT_TRANSFORM =
  /\b(?:make|turn|rewrite|reword|put)\b[^.]{0,30}\b(?:sound|read|more formal|less formal|friendlier|shorter|longer|into (?:the )?(?:past|present|future) tense|passive|active|questions?|plural|singular|spanish|french|german|japanese)\b|\bmake (?:this|that|the) \w+ (?:sound|read)\b|\bturn\b[^.]{0,30}\binto (?:past|present|future|passive|active)\b/i;

const EDIT_TEXT =
  /\b(?:rewrite|reword|polish|proofread|tighten|shorten|edit|improve)\b[^.]{0,25}\b(?:my|this|that|the)\b[^.]{0,20}\b(?:text|e?mail|message|essay|paragraph|sentence|reply|note|bio|resume)\b|\bmake (?:it|this|that) (?:shorter|longer|friendlier|more formal|clearer)\b/i;
const WRITE_DELIVERABLE =
  /\b(?:write|draft|compose|create|make|put together|prepare)\b[^.]{0,25}\b(?:note|letter|e?mail|list|chart|plan|itinerary|checklist|invitation|menu|schedule for|essay|report|summary|document|contract|form)\b/i;

// Rule 3: the user is pointing at their screen. Only the agent can see it, so a
// description of WHAT is on screen must never come from the chat model's
// imagination.
// Only the hard cues ("on my screen", "this window") decide the route on their
// own. "I'm looking at" is softer — a chat model can still summarize a document
// the user is describing — so it counts when the same sentence asks for an
// ACTION on it (see DEICTIC_ACTION); otherwise the knowledge/advice rules win.
const ON_SCREEN =
  /\b(?:on my screen|on the screen|on my display|in front of me|what am i looking at|what'?s on my screen|highlighted (?:text|code)|this window|that window|error dialog on my screen)\b|\bi(?:'m| am) looking at\b[^.]{0,40}\b(?:fix|click|copy|read|edit|paste|open|close)\b|\bwhat does (?:this|that) say\b|\bread (?:me )?(?:that|this|it|the last part)\b[^.]{0,20}\b(?:out loud|aloud|again)\b/i;

// Rule 4: imperative orders at the start of the message. Start-anchored so a
// noun mid-sentence can't trigger it, with a bounded action-verb vocabulary.
const ACTION =
  /^\s*(?:please\s+|can you\s+|could you\s+|would you\s+|go ahead and\s+|hey aria[,\s]+)*(open|launch|play|pause|resume|skip|mute|unmute|turn|set|send|text|email|call|remind|schedule|book|order|buy|reserve|navigate|download|install|uninstall|update|upgrade|enable|disable|check|find|search|look up|lookup|google|bing|search the web|show me|get me|pull up|bring up|take a|start|stop|go to|switch|toggle|change|adjust|raise|lower|increase|decrease|run|re-?run|execute|build|re-?build|compile|deploy|commit|push|pull|merge|rebase|revert|edit|rename|delete|create|write|add|save|copy|paste|move|grep|click|press|type|select|scroll|compute|calculate|fix|patch|refactor|kill|restart|shut down|lock|clear|wipe|screenshot|cancel|dismiss|connect|disconnect|undo|dim|brighten|warm|douse|put|note|log|record|jot|print|scan|snap|photograph)\b/i;

// Rule 4 (deictic): a verb applied to "this/that <thing>", which only makes
// sense as an instruction about something the machine is showing.
const DEICTIC_ACTION =
  /\b(?:read|click|press|copy|paste|highlight|open|fix|patch|refactor|run|grep|check|edit|delete|remove|rename|merge|rebase|scroll|select|type|compute|calculate|inspect|translate)\b[^.]{0,24}\b(?:this|that|the) (?:error|code|message|log|stack ?trace|trace|document|doc|page|window|dialog|screenshot|chart|image|graph|text|button|regex|function|snippet|script|file|output|config)\b/i;

// Rule 5: machine / account changes a chat model cannot perform. These outrank
// a knowledge framing because the user is asking to change a system.
const MACHINE_CHANGE =
  /^\s*(?:please\s+|can you\s+|could you\s+|would you\s+|go ahead and\s+|hey aria[,\s]+)*(?:write|create|make|generate|add|save|set up|rename|delete|remove|move|copy)\b[^.]{0,45}\b(file|files|folder|directory|note|notes|doc|document|script|branch|commit|tag|key|keys|ssh key|config|config file|cron job|cron|calendar invite|calendar event|invite|event|reminder|alarm|timer|task|tarball|archive|backup|symlink|env file|\.txt|\.md|\.json|\.sh|\.py|\.js|\.ya?ml|\.toml|\.csv)\b|\b(?:write|create|add|make)\b[^.]{0,30}\ba (?:test|tests|check|route|endpoint|function|class|method)\b[^.]{0,30}\b(?:file|repo|repository|module|parser|handler|codebase|app|server)\b|\badd\b[^.]{0,30}\bto (?:my|the) (?:shopping )?list\b/i;

// Rule 6: knowledge framing — the user wants to understand something.
const CHAT_KNOWLEDGE =
  /^\s*(?:can you |could you |could you please |please |quick question[,\s]*|so )*(?:explain|describe|teach me|walk me through|talk me through|help me understand|define|summari[sz]e|tell me about|give me (?:an? )?(?:overview|summary) of)\b|\bwhat does (?:the )?(?:word|term|phrase|acronym) .{1,40}\bmean\b|\bwhat(?:'s| is) .{1,40}\bused for\b|\bwhat does .{1,40}\b(?:do|return|mean|set|use|stand for)\b|\bwhat(?:'s| is) the difference between\b|\bwhat are the differences\b|\bwhy (?:is|are|does|do|did|can'?t|would|won'?t|should)\b|\bwhen (?:was|were|did)(?!\s+(?:i|we)\b)\b|\bwhat (?:was|were)\b|\bwhen (?:is|are|does|do)\b[^.]{0,40}\b(?:usually|typically|generally|normally|every (?:year|week|day|month|season)|around here|in general|in (?:january|february|march|april|may|june|july|august|september|october|november|december))\b|\bhow (?:does|do|did) \w+|\bhow (?:would|might) (?:a|an|the|you|one|that) \w+|\bwho (?:invented|wrote|discovered|created|was the)\b|\bteach me (?:about|how)\b|\bexplain (?:to me )?(?:how|why|what)\b/i;

// Rule 6 exception: the question is about a failure or result of MY system, so
// answering it means looking at the machine, not reciting knowledge.
const MY_SYSTEM_TROUBLE =
  /\bmy (?:build|deploy|deployment|benchmark|test|tests|test suite|pipeline|container|cluster|branch|repo|repository|app|application|server|machine|disk|drive|backup|code|script|loop|function|program|query|database|python|node)\b[^.]{0,40}\b(?:fail|failed|failing|broke|broken|crash|crashed|error|errors|down|stuck|hung|slow)\b|\bwhy (?:did|does) my\b[^.]{0,30}\b(?:fail|break|crash|hang|stop working)\b|\bexplain (?:the )?(?:results|output|numbers) of my\b|\bwhat(?:'s| is) wrong with my\b/i;

// A knowledge framing still means live data when the sentence asks about NOW —
// "explain what the weather is right now" wants the agent, not a lecture.
const KNOWLEDGE_LIVE_OVERRIDE =
  /\b(?:right now|currently|at the moment|today|tonight|tomorrow|last night|yesterday|this morning|this (?:week|weekend|month)|latest|most recent|near me|nearby|in my area)\b/i;

// Rule 7: live world data.
const LIVE_DATA =
  /\b(?:weather|forecast|temperature|humidity|raining|rain|snowing|snow|sunny|cloudy|windy|storm|umbrella|sunrise|sunset|uv index|air quality|pollen|news|headlines|breaking news|stock price|stock market|share price|scores?|standings|exchange rate|(?:bitcoin|ethereum|crypto|btc|eth)\b[^.]{0,20}\b(?:price|worth|value|rate|doing|at)|price of|how much is|market cap|this week|this weekend|right now|currently|the latest|most recent|newest|up[- ]?to[- ]?date|current version|latest version|what'?s happening|what'?s going on in the world)\b/i;

// Rule 7: navigation / proximity / place lookups.
// A question about a specific place's opening/reservation behaviour is a live
// lookup ("does that place take reservations").
const PLACE_LOOKUP =
  /\b(?:does|do|is|are) (?:that|this|the) (?:\w+ )?(?:place|restaurant|store|shop|hotel|gym|clinic|venue|cafe|bar)\b[^.]{0,25}\b(?:open|take|accept|have|allow|serve|close|deliver|book)\b/i;

// Habits and replays: "do the usual" repeats a routine, which needs the agent.
const REPEAT_ROUTINE = /\b(?:do the usual|same as (?:last time|before|always|usual)|like last time|the usual please)\b/i;

// Questions about the user's own live state — messages, plans, deliveries,
// spending — are lookups in the same sense as the weather.
const CHECK_MY_STUFF =
  /\b(?:any (?:new )?(?:texts?|messages?|e?mails?|calls?|voicemails?|notifications?|updates?)\b|do (?:we|i) have (?:anything|any)\b|what'?s (?:on|coming up on) (?:my|the) (?:calendar|schedule)|how much (?:did|have) (?:we|i) spent?\b|who'?s (?:picking up|dropping off|driving|coming|taking|bringing)\b|is (?:the|my) (?:train|bus|flight|order|package|delivery|appointment|reservation|table|booking)\b[^.]{0,30}\b(?:delayed|late|ready|confirmed|shipped|arrived|cancelled|still)\b)/i;

// "See if the library has X" and "read the PDF in my downloads" both mean: go
// look at something, then tell me.
// Questions only the user's own data can answer: how far they walked, when they
// last did something, how long until an event, what something cost last month.
const MY_DATA_QUESTION =
  /\bhow many (?:steps|calories|miles|kilometers|km|hours|minutes|days) (?:did|have) i\b|\bdid i (?:already )?(?:take|do|finish|send|pay|call|walk|water|log|book|order|schedule)\b|\bwhat did i (?:have|eat|do|say|buy|order|send)\b|\bwhen did i (?:last|first)\b|\bhow many days (?:until|till|to)\b|\bhow long until (?:my|the|our)\b|\bwhat did .{0,25}\bcost (?:last|this)\b|\b(?:last|this) (?:month|year|week),?\s*how much\b|\bhow much (?:did|have) (?:we|i) (?:pay|spend|spent)\b|\bpercent(?:age)? of my\b|\bof my (?:remaining )?(?:budget|balance|account|savings|paycheck)\b|\bhow long (?:is|until|till) my\b|\bmy (?:flight|train|bus|drive|trip|route)\b[^.]{0,25}\b(?:long|time|hours|leave|leaves|depart|departs|arrive|arrives)\b/i;

// A statement about the user's own habits is conversation, not a request.
const HABIT_STATEMENT =
  /^(?:every (?:morning|day|week|night|evening)|most (?:mornings|days|evenings)|i (?:usually|always|often|normally|sometimes|tend to|like to)|we (?:usually|always|often|normally))\b/i;

// "just say if it clashes" is still a question about the user's calendar.
const CALENDAR_CHECK = /\b(?:calendar|schedule|agenda|plans?)\b[^.]{0,30}\b(?:clash(?:es)?|conflicts?|double[- ]booked|overlaps?)\b|\b(?:clash(?:es)?|conflicts?|overlaps?)\b[^.]{0,30}\b(?:calendar|schedule|plans?)\b/i;

// "how's it going with that thing I asked about" is a follow-up on an earlier
// request, which only the agent that ran it can answer.
const FOLLOWUP_STATUS = /\b(?:that|the|this) (?:thing|stuff|task|job|request|email|order|booking) (?:i|we) (?:asked|mentioned|sent|requested|ordered)\b/i;

// A named document on this machine ("summarize this PDF", "the draft in my
// folder") is work even when the verb sounds like a knowledge request.
const DOCUMENT_ON_MACHINE = /\b(?:pdf|docx?|spreadsheet|attachment|folder|downloads|the (?:file|document|draft) (?:in my|named|on disk|saved)|my (?:drafts|files|documents|downloads))\b/i;

// Capability questions are conversation ("what can you actually do with my
// calendar", "do you have access to my email").
const CAPABILITY_QUESTION =
  /\bwhat can you (?:actually )?(?:do|see|access|read)\b|\b(?:do|can) you (?:have|get) access to\b|\bcan you (?:see|access|read) my\b|\bwhat (?:are|is) your (?:capabilities|limits)\b/i;

// A definition of a term inside some domain is knowledge, not a system action.
const TEXTBOOK_QUESTION = /\bwhat(?:'s| is) a\b[^.]{0,40}\bin (?:an?|the) \w+\b/i;

// An appliance mentioned as broken is a request only when the user also asks.
const ASK_CUE = /\b(?:can|could|would) you\b|\bplease\b|\?|\bhelp\b|\bwhat should i\b|\bfix it\b|\bdo something\b|\bdeal with it\b|\bwould you mind\b/i;

const SEE_IF = /\bsee if (?:the|my|they|it|there|that)\b/i;
const READ_FILE = /\b(?:read|summari[sz]e|translate|open|scan)\b[^.]{0,25}\b(?:pdf|docx?|spreadsheet|attachment|report|article)\b|\b(?:read|summari[sz]e|translate)\b[^.]{0,25}\b(?:in my (?:downloads|drafts|documents|files|folder)|that file|the file i)\b|\bsave (?:it|that|this|the (?:summary|translation|file))\b/i;
// Sending an artifact to someone is an action.
const SEND_ARTIFACT = /\b(?:email|send|share|forward|text) (?:it|this|that|them|the [\w-]+) (?:to|over to)\b/i;

// Outdoor events depend on the sky right now.
const SKY_EVENT = /\b(?:meteor|eclipse|aurora|comet|fireworks?|planet|stars?)\b[^.]{0,30}\b(?:tonight|today|tomorrow|this (?:evening|weekend)|visible|clear enough)\b|\bsky\b[^.]{0,25}\b(?:clear|cloudy|cloud cover)\b/i;

const NAVIGATE =
  // "best ROUTE from here" only — "the best way to back up my files" is advice,
  // and letting the bare "best way to" match here silently hijacked it.
  /\b(?:best|fastest|quickest) (?:route|way) (?:from here|from there|home)\b|\b(?:directions? to|take me to|drive me to|route to|how (?:do i|can i|do you) get to|how far (?:is|away|to|from)|nearest|closest|near me|nearby|around here|in my area|open now|open today|store hours|business hours|is .{1,30} open)\b/i;

// Rule 7: time / date about now.
const TIME_DATE =
  /\b(?:what time(?! ?zone| ?difference)|what'?s the time|time is it|time it is|current time|tell me the time|got the time|what day|what'?s the date|what is the date|today'?s date|current date|date today|what'?s today|what month|what year is it)\b/i;

// Rule 8: advice framing is chat even when it names a device or a file.
const CHAT_ADVICE =
  /\b(?:the|a|any|my) (?:best|good|better|smartest|cheapest|quickest) (?:way|option|approach|choice|place)\b|\bwhat(?:'s| is) a good\b|\bwhat are (?:some )?good\b|\brecommend (?:a|some|any|me)\b|\bshould i\b|\bwould you (?:recommend|suggest)\b|\b(is|are|does) (?:it|this|that) (?:healthy|safe|ok|okay|fine|better|worth|normal|a good idea)\b|\bhow (?:can|do) i (?:get better|learn|improve|become|train|start|avoid)\b|\bhelp me (?:decide|choose|think|plan|understand)\b|\bwhat should i\b|\bdo (?:i|we) need\b|\bis it worth\b|\b(?:nicer|better|politer|kinder|softer|more formal|less blunt) way to (?:say|phrase|word|put)\b|\btips for\b|\badvice\b|\bhow (?:do|can|would|should|might) i\b|\bhow do you\b/i;

// Rule 9: implicit asks. Real speech often describes a state and expects the
// machine to act.
const IMPLICIT_DEVICE =
  /\b(?:make it|turn it|bump|lower|raise|crank|set it|put the) (?:up|down|higher|lower|warmer|cooler|quieter|louder|brighter|dimmer|darker)\b|\bbump[^.]{0,20}\b(?:heat|temperature|volume|thermostat)\b|\b(?:too|really|so) (?:loud|quiet|hot|cold|bright|dark|dim)\b|\bpitch (?:dark|black)\b|\b(?:thermostat|air conditioning)\b|\bit'?s freezing in here\b/i;
const IMPLICIT_MESSAGE =
  /\b(?:let|get|keep|have) (?:my )?(?:mom|mum|dad|sister|brother|wife|husband|partner|boss|team|family|him|her|them|everyone)\b[^.]{0,24}\b(?:know|in the loop|posted|updated|ahead|aware|informed)\b|\b(?:tell|let) (?:him|her|them|mom|dad|the team|my boss) (?:that|i'?m|i am)\b|\bi'?m (?:running late|on my way|running behind)\b/i;
const IMPLICIT_REMIND = /\b(?:don'?t let me forget|make sure i (?:don'?t forget|remember))\b/i;
// A device or appliance reported as broken/stuck is a request to deal with it.
const IMPLICIT_BROKEN =
  /\b(?:printer|dishwasher|washer|dryer|oven|fridge|freezer|tv|router|modem|computer|laptop|phone|car|thermostat|doorbell|camera)\b[^.]{0,35}\b(?:jam(?:med)?|stuck|broken|not (?:working|responding|printing)|won'?t|can'?t|frozen|dead|offline|beeping|unreachable|error|again and)\b/i;
const GET_STARTED = /\bget (?:the|my|that)\b[^.]{0,25}\b(?:started|going|running|ready|done|booked|scheduled|ordered|fixed|printed)\b|\b(?:handle|take care of|deal with|sort out) (?:it|that|this)\b|\b(?:do|fix|check) it\b|\bforget (?:the|that|all that)\b[^.]{0,25}\bjust\b|\bread out\b|\bread (?:me )?(?:my|the) (?:last|latest|previous|next) (?:message|text|email|note)\b/i;
const IMPLICIT_ORDER = /\b(?:i'?m|im) (?:out of|running low on|all out of)\b[^.]{0,30}\b(?:get|order|buy|pick up|add|grab)\b|\bget me (?:some|more|another|a|an)\b/i;
const IMPLICIT_LOOKUP =
  /\b(?:look (?:that|it|this) up|search for it)\b[^.]{0,15}\b(?:online|on the web|on the internet)\b|\bgo look (?:that|it) up\b|\bgo online\b|\b(?:check|look) (?:that|this|it) (?:up )?online\b/i;

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

    // news / finance / sports (live)
    'news', 'headlines', 'stock', 'stocks', 'shares', 'market', 'crypto',
    'price of', 'how much is', 'exchange rate', 'currency',
    'score', 'scores', 'standings', 'latest score', 'final score',
    // search / web / research
    'search', 'search for', 'look up', 'lookup', 'google', 'bing', 'wikipedia',
    'browse', 'website', 'on the internet',
    // navigation / places (live)
    'directions', 'navigate', 'route to', 'nearest', 'nearby', 'near me',
    'traffic', 'how long to get', 'how long until',
    // device / system actions
    'volume', 'brightness', 'mute', 'flashlight', 'wifi', 'bluetooth',
    'battery', 'screenshot', 'screen', 'what.s on my',
    // comms / productivity
    'email', 'emails', 'messages', 'inbox', 'inboxes', 'whatsapp', 'slack', 'calendar',
    'meeting', 'meetings', 'appointment', 'appointments',
    'schedule a', 'set a timer', 'set an alarm',
    'alarm', 'alarms', 'timer', 'timers', 'reminder', 'reminders', 'shopping list', 'add to my',
    // commerce
    'calculate', 'book a', 'place an order', 'reserve a',
  ].join('|') + ')\\b',
  'i',
);

// The previous reply's subject is still live ("what about tomorrow?").
const REALTIME =
  /\b(?:right now|currently|the latest|most recent|newest|up[- ]?to[- ]?date|current version|latest version|near me|nearby|around here|in my area|my area|local events?|open now|open today|store hours|business hours|this (week|weekend|month|year)|what time(?! ?zone| ?difference)|what'?s the time|what day|what'?s the date|what is the (weather|time|forecast|date|temperature|score|price)|events? (today|tonight|tomorrow|yesterday|last night|near me|in my area)|fireworks? (show|shows|event|events|happened|near|tonight|tomorrow|yesterday|last night)|happened (yesterday|last night)|(did|has|have) .{1,60}\b(win|won|beat|lose|lost)\b (today|tonight|yesterday|last night)|who (?:won|is winning|'s winning|are they playing)\b[^.]{0,40}\b(last night|tonight|today|yesterday|right now|currently|just now|the (?:game|match|series)|this (?:week|evening|afternoon|season)))\b/i;

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

export interface RouteDecision {
  target: Target;
  /** False when no rule recognised the message: the broad keyword list matched
   *  nothing specific, or nothing matched at all. Those are the messages worth a
   *  second opinion from the chat model (see turn-classifier.ts). */
  confident: boolean;
  reason: string;
}

/**
 * Choose a target for `message` given availability + mode, and say how sure the
 * rules are. Falls back to whichever target is configured if the preferred one
 * isn't.
 */
export function routeDetailed(message: string, cfg: RouteConfig): RouteDecision {
  // Honor a hard mode override (still falling back if that one isn't configured).
  if (cfg.mode === 'llm') return { target: cfg.hasLlm ? 'llm' : 'harness', confident: true, reason: 'forced-llm-mode' };
  if (cfg.mode === 'harness') return { target: cfg.hasHarness ? 'harness' : 'llm', confident: true, reason: 'forced-harness-mode' };

  // auto: only one configured -> use it.
  if (cfg.hasHarness && !cfg.hasLlm) return { target: 'harness', confident: true, reason: 'only-agent-configured' };
  if (cfg.hasLlm && !cfg.hasHarness) return { target: 'llm', confident: true, reason: 'only-chat-configured' };
  if (!cfg.hasLlm && !cfg.hasHarness) return { target: 'llm', confident: true, reason: 'nothing-configured' };

  const text = message || '';

  // 1. Explicit asks win outright.
  if (EXPLICIT_LLM.test(text)) return { target: 'llm', confident: true, reason: 'explicit-chat' };
  if (EXPLICIT_HARNESS.test(text)) return { target: 'harness', confident: true, reason: 'explicit-agent' };

  // 2. Writing something FOR the user (poem, regex, grammar fix, text) is chat,
  // whatever nouns it contains; and a negated tool request is not a tool request.
  const machineArtifact = /\b(?:calendar (?:invite|event|entry|appointment)|invite in my calendar|event in my calendar|the (?:file|document|draft) (?:in my|named|on disk|saved)|my (?:drafts|files|documents|downloads))\b/i.test(text);
  if ((CREATIVE_WRITE.test(text) || TEXT_TRANSFORM.test(text)) && !machineArtifact) {
    return { target: 'llm', confident: true, reason: 'writing-for-user' };
  }
  // "Every morning I check the traffic before leaving" describes a habit; it
  // asks for nothing.
  if (HABIT_STATEMENT.test(text) && !/\?|\b(?:can you|could you|please|remind me|set|add|check if)\b/i.test(text)) {
    return { target: 'llm', confident: true, reason: 'habit-statement' };
  }
  const openDocument = /\b(?:in my (?:drafts|files|documents|folder|downloads)|i have open|attached|saved|in the file|in the document)\b/i.test(text);
  if (LANGUAGE_FIX.test(text) && !FILE_WORK_FIX.test(text) && !openDocument) {
    return { target: 'llm', confident: true, reason: 'language-fix' };
  }
  // A negation loses when the same sentence also carries a positive instruction
  // ("don't just tell me, actually add it to my calendar", "don't guess, just
  // look it up online") and never covers "don't let me forget" (a reminder).
  const negated = (NEGATED_TOOL.test(text) || NEGATED_ACTION.test(text) || NEGATED_DEVICE.test(text))
    && !/\b(?:actually|instead|but)\b/i.test(text)
    && !/\bjust (?:look|add|set|send|do|check|go|tell)\b/i.test(text)
    && !/\b(?:let me forget|forget to)\b/i.test(text)
    && !/\b(?:clash(?:es)?|conflicts?|double[- ]booked|overlaps?)\b/i.test(text);
  if (NEGATED_TOOL.test(text) || NEGATED_ACTION.test(text) || NEGATED_DEVICE.test(text)) {
    if (negated) return { target: 'llm', confident: true, reason: 'negated-action' };
    // "don't run anything, just tell me" — the second half is the request.
    if (/\b(?:don'?t|do not|no need to)\b[^.]{0,30}\bjust (?:tell|say|explain|talk|chat|answer)\b/i.test(text)
        && !/\b(?:actually|instead|but)\b/i.test(text)
        && !/\b(?:clash(?:es)?|conflicts?|overlaps?)\b/i.test(text)) {
      return { target: 'llm', confident: true, reason: 'negated-then-chat' };
    }
  }
  // …but a hypothetical that also carries a real request is still a request
  // ("pretend you're my assistant and book a table for two at seven").
  const HYPOTHETICAL_ASK = /\b(?:book|order|buy|reserve|set|create|add|send|schedule|call|email|text|remind|check)\b/i;
  if (HYPOTHETICAL.test(text) && !(HYPOTHETICAL_ASK.test(text) && !/\b(?:i asked you to|what would you need|what would that take)\b/i.test(text))) {
    return { target: 'llm', confident: true, reason: 'hypothetical' };
  }
  // A word problem with a hypothesis and no live data is arithmetic.
  if (/\bif i\b/i.test(text) && /\bhow (?:much|many)\b/i.test(text) && !LIVE_DATA.test(text) && !MY_DATA_QUESTION.test(text)) {
    return { target: 'llm', confident: true, reason: 'arithmetic' };
  }
  // Editing text the user has OPEN or saved is machine work; editing prose they
  // pasted or described is chat.
  if (EDIT_TEXT.test(text) && !openDocument) return { target: 'llm', confident: true, reason: 'edit-user-text' };

  // 3. Anything the user points at on screen belongs to the agent, which is the
  // only target that can see or touch it ("summarize the document I'm looking at"
  // must not be answered out of the chat model's imagination).
  // A bare "summarize this" is about something in front of the user; "summarize
  // this function in one sentence" is a question about a snippet.
  const bareDeictic = (text.trim().split(/\s+/).length <= 4
      && /^(?:please |can you )?(?:summari[sz]e|read|explain|translate|fix|check|look at)\s+(?:this|that|it)\s*[.!?]?$/i.test(text.trim()))
    || /^(?:please |hey aria )?(?:what'?s|what is|who'?s|who is|what does) (?:this|that)\s*[.!?]?$/i.test(text.trim())
    || /\bis (?:it|that|this) far (?:from here|away)\b/i.test(text);
  if (ON_SCREEN.test(text) || bareDeictic) return { target: 'harness', confident: true, reason: 'on-screen' };

  // 4. An imperative is an order, even when the rest of the sentence reads like a
  // question ("google who invented the telescope") or the object is deictic
  // ("fix this regex", "read this error to me").
  const recallAsk = /^\s*(?:please\s+)?remind me\s+(?:how|what|when|where|who|why|if|whether|about|of|that)\b/i.test(text);
  if ((ACTION.test(text) && !recallAsk) || TIMER_COMMAND.test(text) || DEVICE_STATE.test(text)) {
    return { target: 'harness', confident: true, reason: 'imperative' };
  }
  if (DEICTIC_ACTION.test(text)) return { target: 'harness', confident: true, reason: 'deictic-imperative' };

  // 5. A machine or account change the chat model cannot perform — including
  // producing a deliverable document, unless the action was negated.
  if (MACHINE_CHANGE.test(text)) return { target: 'harness', confident: true, reason: 'machine-change' };
  const howTo = /\bhow (?:do|would|can|should) i\b|\bhow (?:do|would) you\b/i.test(text);
  if (!howTo && WRITE_DELIVERABLE.test(text) && !NEGATED_ACTION.test(text) && !NEGATED_TOOL.test(text)) {
    return { target: 'harness', confident: true, reason: 'write-deliverable' };
  }

  // 6. Knowledge framing is chat — unless the question is about my own system
  // failing (that needs the agent to look), or asks for NOW data.
  // A live-data word inside a question about habits, history or another world is
  // still knowledge: "what's the weather usually like in Denver in May",
  // "what is the weather like on Jupiter", "when was the kitchen timer invented".
  const LEGACY = /\b(?:usually|typically|generally|normally|on average|in general|these days|at this time of year|historically|in \d{4}|in (?:january|february|march|april|may|june|july|august|september|october|november|december)|on (?:mars|jupiter|venus|saturn|the moon)|in (?:space|history)|centur(?:y|ies)|ancient|medieval|invented|history of)\b/i;
  const TIMELESS = /\b(?:usually|typically|generally|normally|on average|in general|these days|at this time of year|historically|every (?:year|week|day|month|season)|in \d{4}|in (?:january|february|march|april|may|june|july|august|september|october|november|december)|on (?:mars|jupiter|venus|saturn|the moon)|in (?:space|history)|centur(?:y|ies)|ancient|medieval|invented|history of|around here|school year|ever in|of all time|in history|ever at)\b/i;
  if (CHAT_KNOWLEDGE.test(text) && !MY_SYSTEM_TROUBLE.test(text) && !KNOWLEDGE_LIVE_OVERRIDE.test(text)
      && !DOCUMENT_ON_MACHINE.test(text)
      && (!NAVIGATE.test(text) || TIMELESS.test(text))) {
    return { target: 'llm', confident: true, reason: 'knowledge-framing' };
  }
  if (LIVE_DATA.test(text) && TIMELESS.test(text) && !KNOWLEDGE_LIVE_OVERRIDE.test(text)) {
    return { target: 'llm', confident: true, reason: 'timeless-knowledge' };
  }
  if (MY_SYSTEM_TROUBLE.test(text)) return { target: 'harness', confident: true, reason: 'my-system-trouble' };

  // Hypothesised arithmetic ("if I double the recipe, how much is three quarter
  // cups") is maths, even though it contains "how much is".
  if (/\bif i\b/i.test(text) && /\bhow (?:much|many)\b/i.test(text)
      && !MY_DATA_QUESTION.test(text) && !/\b(?:price|cost|worth|rate|dollars?|euros?|pounds?)\b/i.test(text)) {
    return { target: 'llm', confident: true, reason: 'arithmetic' };
  }

  // 7. Proximity / navigation and device-state questions are live lookups.
  if (NAVIGATE.test(text)) return { target: 'harness', confident: true, reason: 'navigation' };

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
  // A phrasing question that happens to contain a first-person status line is
  // not a task ("what's a polite way to say I'm running late").
  const phrasingQuestion = /\b(?:way to (?:say|phrase|word|put)|how (?:do|would) i (?:say|tell|phrase|word)|how to say)\b/i.test(text);
  if (CAPABILITY_QUESTION.test(text) || TEXTBOOK_QUESTION.test(text)) {
    return { target: 'llm', confident: true, reason: 'knowledge-question' };
  }
  if ((CHAT_ADVICE.test(text) || phrasingQuestion) && !liveNow) {
    return { target: 'llm', confident: true, reason: 'advice' };
  }

  // 9. Remaining live-data lookups: time, weather, news, prices.
  if (TIME_DATE.test(text) || LIVE_DATA.test(text) || SKY_EVENT.test(text)) {
    return { target: 'harness', confident: true, reason: 'live-data' };
  }
  if (PLACE_LOOKUP.test(text) || REPEAT_ROUTINE.test(text)) {
    return { target: 'harness', confident: true, reason: 'place-or-routine' };
  }
  if (CHECK_MY_STUFF.test(text) || GET_STARTED.test(text)) {
    return { target: 'harness', confident: true, reason: 'check-my-stuff' };
  }
  if (SEE_IF.test(text) || READ_FILE.test(text) || SEND_ARTIFACT.test(text) || MY_DATA_QUESTION.test(text) || CALENDAR_CHECK.test(text)) {
    return { target: 'harness', confident: true, reason: 'live-state-lookup' };
  }
  // "is that still on for tomorrow" continues an earlier booking question.
  if (/\b(?:still (?:on|happening|going ahead)|on for (?:tomorrow|today|tonight))\b/i.test(text)) {
    return { target: 'harness', confident: true, reason: 'followup-live' };
  }
  if (FOLLOWUP_STATUS.test(text)) return { target: 'harness', confident: true, reason: 'followup-status' };
  if (CURRENCY_CONVERT.test(text) || SHOPPING_COMPARE.test(text)) {
    return { target: 'harness', confident: true, reason: 'money-or-shopping' };
  }

  // 10. Implicit asks — a described state plus an expected action.
  if (IMPLICIT_DEVICE.test(text) || IMPLICIT_MESSAGE.test(text) || IMPLICIT_REMIND.test(text)) {
    return { target: 'harness', confident: true, reason: 'implicit-ask' };
  }
  if (IMPLICIT_BROKEN.test(text) && ASK_CUE.test(text)) {
    return { target: 'harness', confident: true, reason: 'broken-device-ask' };
  }
  // Lights, music, fans: an ask phrased around the device.
  const deviceAsk = /\b(?:lights?|lamps?|fan|music|tv|volume|thermostat|heat|air conditioning)\b/i.test(text)
    && /\b(?:turn(?:ing)?|switch(?:ing)?|shut(?:ting)?|dim(?:ming)?|lower(?:ing)?|raise|raising|off|down|on)\b/i.test(text);
  if ((ASK_CUE.test(text) && /\b(?:turn(?:ing)?|switch(?:ing)?|shut(?:ting)?|dim(?:ming)?|lower(?:ing)?|raise|raising)\b[^.]{0,25}\b(?:lights?|lamp|fan|music|tv|volume|screen|heat)\b/i.test(text)) || deviceAsk) {
    return { target: 'harness', confident: true, reason: 'device-ask' };
  }
  if (GET_STARTED.test(text)) return { target: 'harness', confident: true, reason: 'get-started' };
  if (IMPLICIT_ORDER.test(text) || IMPLICIT_LOOKUP.test(text)) {
    return { target: 'harness', confident: true, reason: 'implicit-order-or-lookup' };
  }

  // 11. Broad agentic / tool keyword list.
  // The broad keyword list matches NOUNS; a hit here is a hint, not a decision,
  // so the caller is invited to double-check these with the chat model.
  if (AGENTIC.test(text) || REALTIME.test(text)) {
    return { target: 'harness', confident: false, reason: 'keyword-only' };
  }

  // 12. Stickiness: if the agent handled the previous turn, keep this turn on the
  // agent when it's a continuation — a short follow-up OR an answer to a question
  // the agent just asked. Explicit "just chat" above already escapes this.
  if (cfg.lastTarget === 'harness' && (cfg.lastWasQuestion || isContinuation(text))) {
    return { target: 'harness', confident: true, reason: 'sticky-continuation' };
  }

  // 13. Default: chat — nothing recognised the message, which is exactly the
  // case worth a second opinion.
  return { target: 'llm', confident: false, reason: 'no-rule-matched' };
}

/** Choose a target. Thin wrapper over routeDetailed for callers that only need it. */
export function route(message: string, cfg: RouteConfig): Target {
  return routeDetailed(message, cfg).target;
}
