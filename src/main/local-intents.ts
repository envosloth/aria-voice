// Local instant intents. Pure + unit-testable (mirrors router.ts).
//
// Bare time/date questions and timer/alarm/reminder commands are answered
// entirely in the main process — no LLM or harness round-trip — so "what time
// is it" speaks in ~150ms instead of a multi-second agent turn. Only exact,
// full-utterance phrasings match; anything with extra context ("what time is
// it in Tokyo", "remind me when the game starts") falls through to normal
// routing, and an explicit "ask the agent…" is never intercepted.

import { EXPLICIT_HARNESS } from './router';

export type LocalIntent =
  | { kind: 'time' }
  | { kind: 'date' }
  | { kind: 'timer_set'; ms: number; label: string }
  | { kind: 'alarm_set'; hour: number; minute: number; explicitMeridiem: boolean }
  | { kind: 'reminder_set'; text: string; ms?: number; hour?: number; minute?: number; explicitMeridiem?: boolean }
  | { kind: 'timer_list' }
  | { kind: 'timer_cancel'; what: 'timer' | 'alarm' | 'reminder' | 'all' };

// STT text arrives with sentence punctuation and filler; normalize to a bare
// lowercase utterance so the full-string-anchored patterns below can match.
function normalize(message: string): string {
  let t = (message || '').toLowerCase().trim();
  t = t.replace(/[.!?]+$/, '').trim();          // trailing punctuation
  // Strip leading filler words repeatedly (a ^-anchored replace only fires
  // once, so "hey aria what time is it" needs the loop to shed both words).
  const FILLER = /^(?:hey|ok|okay|please|aria|jarvis)[,\s]+/;
  while (FILLER.test(t)) t = t.replace(FILLER, '');
  t = t.replace(/[,\s]+please$/, '');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

const TIME_RES = [
  /^(?:do you know |can you tell me )?what time (?:is it|it is)(?: right now| now| today)?$/,
  /^what(?:'s| is) the (?:current )?time(?: right now| now)?$/,
  /^(?:can you )?tell me the time$/,
  /^(?:have you )?got the time$/,
];

const DATE_RES = [
  /^what(?:'s| is) (?:the |today's )?date(?: today)?$/,
  /^what day is it(?: today)?$/,
  /^what day of the week is it$/,
  /^what(?:'s| is) today's date$/,
];

// ---- duration parsing ("10 minutes", "an hour and a half", "1 minute 30 seconds")
const NUM_WORDS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7,
  eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30,
  'forty five': 45, sixty: 60, ninety: 90, half: 0.5, 'half a': 0.5, 'half an': 0.5,
};
const UNIT_MS: Record<string, number> = { second: 1000, minute: 60000, hour: 3600000 };
const DUR_PART = /(\d+(?:\.\d+)?|forty five|half an?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|sixty|ninety)\s+(second|minute|hour)s?/;

export function parseDuration(text: string): number | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  // "an hour and a half" special-case, then one or two "<n> <unit>" parts.
  const halfMatch = t.match(/^(?:an?|one) (hour|minute) and a half$/);
  if (halfMatch) return UNIT_MS[halfMatch[1]] * 1.5;
  const re = new RegExp(`^${DUR_PART.source}(?:\\s+and\\s+${DUR_PART.source})?$`);
  const m = t.match(re);
  if (!m) return null;
  const val = (numStr: string) => NUM_WORDS[numStr] ?? parseFloat(numStr);
  let ms = val(m[1]) * UNIT_MS[m[2]];
  if (m[3] && m[4]) ms += val(m[3]) * UNIT_MS[m[4]];
  if (!isFinite(ms) || ms < 1000) return null;
  return Math.min(ms, 24 * 3600000); // clamp to 24h — beyond that, use an alarm
}

// ---- clock-time parsing ("7am", "7:30 pm", "noon")
function parseClock(text: string): { hour: number; minute: number; explicitMeridiem: boolean } | null {
  const t = text.trim().toLowerCase().replace(/[.!?]+$/, '');
  if (t === 'noon' || t === 'midday') return { hour: 12, minute: 0, explicitMeridiem: true };
  if (t === 'midnight') return { hour: 0, minute: 0, explicitMeridiem: true };
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?(?:\s+o'?clock)?$/);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = m[2] ? parseInt(m[2], 10) : 0;
  if (hour < 1 || hour > 23 || minute > 59) return null;
  const mer = m[3] ? m[3][0] : '';
  if (mer === 'p' && hour < 12) hour += 12;
  if (mer === 'a' && hour === 12) hour = 0;
  return { hour, minute, explicitMeridiem: !!mer };
}

// Next wall-clock occurrence of hour:minute after `now`. Without an explicit
// am/pm, a 1-12 hour means "the soonest matching time" (asking for "8" at
// 9am → 8pm tonight, not 8am tomorrow).
export function nextOccurrence(hour: number, minute: number, explicitMeridiem: boolean, now: Date): number {
  const candidates: number[] = [];
  const mk = (h: number, dayOffset: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + dayOffset);
    d.setHours(h, minute, 0, 0);
    return d.getTime();
  };
  if (explicitMeridiem || hour === 0 || hour > 12) {
    candidates.push(mk(hour, 0), mk(hour, 1));
  } else {
    candidates.push(mk(hour, 0), mk(hour + 12, 0), mk(hour, 1)); // am today, pm today, am tomorrow
  }
  const future = candidates.filter((t) => t > now.getTime()).sort((a, b) => a - b);
  return future[0];
}

export function matchLocalIntent(message: string): LocalIntent | null {
  const raw = message || '';
  if (EXPLICIT_HARNESS.test(raw)) return null; // "ask the agent what time it is"
  const t = normalize(raw);
  if (!t) return null;

  for (const re of TIME_RES) if (re.test(t)) return { kind: 'time' };
  for (const re of DATE_RES) if (re.test(t)) return { kind: 'date' };

  // Timers: "set a timer for 10 minutes" / "start a 5 minute timer" / "timer for 30 seconds"
  let m = t.match(/^(?:set|start) (?:a |the )?timer for (.+)$/) || t.match(/^timer for (.+)$/);
  if (m) {
    const ms = parseDuration(m[1]);
    if (ms) return { kind: 'timer_set', ms, label: humanizeMs(ms) };
    return null; // "set a timer for my meeting" — not parseable, let the harness try
  }
  m = t.match(/^(?:set|start) a (.+?) timer$/);
  if (m) {
    const ms = parseDuration(m[1]);
    if (ms) return { kind: 'timer_set', ms, label: humanizeMs(ms) };
    return null;
  }

  // Alarms: "set an alarm for 7am" / "wake me up at 7:30"
  m = t.match(/^(?:set (?:an |the )?alarm for|wake me (?:up )?at) (.+)$/);
  if (m) {
    const c = parseClock(m[1]);
    if (c) return { kind: 'alarm_set', ...c };
    return null;
  }

  // Reminders: "remind me to <text> in <duration>" / "… at <time>". The text
  // capture is GREEDY so the split lands on the LAST " in "/" at " — "remind me
  // to put the turkey in the oven in 20 minutes" keeps "in the oven" in the
  // reminder text instead of failing to parse.
  m = t.match(/^remind me (?:to |that |about )?(.+) in (.+)$/);
  if (m) {
    const ms = parseDuration(m[2]);
    if (ms) return { kind: 'reminder_set', text: m[1], ms };
    return null;
  }
  m = t.match(/^remind me (?:to |that |about )?(.+) at (.+)$/);
  if (m) {
    const c = parseClock(m[2]);
    if (c) return { kind: 'reminder_set', text: m[1], ...c };
    return null;
  }

  // Cancel / list
  m = t.match(/^(?:cancel|stop|clear|delete) (?:the |my |all )?(timer|alarm|reminder)s?$/);
  if (m) return { kind: 'timer_cancel', what: m[1] as 'timer' | 'alarm' | 'reminder' };
  if (/^(?:cancel|clear|delete) everything$/.test(t)) return { kind: 'timer_cancel', what: 'all' };
  if (
    /^list (?:my )?(?:timers|alarms|reminders)$/.test(t) ||
    /^what (?:timers|alarms|reminders) do i have$/.test(t) ||
    /^do i have any (?:timers|alarms|reminders)$/.test(t)
  ) return { kind: 'timer_list' };

  return null;
}

// ---- spoken-answer rendering --------------------------------------------

const ORDINALS = ['zeroth', 'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh',
  'eighth', 'ninth', 'tenth', 'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth',
  'sixteenth', 'seventeenth', 'eighteenth', 'nineteenth', 'twentieth', 'twenty-first',
  'twenty-second', 'twenty-third', 'twenty-fourth', 'twenty-fifth', 'twenty-sixth',
  'twenty-seventh', 'twenty-eighth', 'twenty-ninth', 'thirtieth', 'thirty-first'];

export function formatClock(d: Date): string {
  let h = d.getHours();
  const mer = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  const min = d.getMinutes();
  return min === 0 ? `${h} ${mer}` : `${h}:${String(min).padStart(2, '0')} ${mer}`;
}

export function humanizeMs(ms: number): string {
  const parts: string[] = [];
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.round((ms % 60000) / 1000);
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s && !h) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' and ') || '0 seconds';
}

export function answerFor(intent: LocalIntent, now: Date): string {
  const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  if (intent.kind === 'time') return `It's ${formatClock(now)}.`;
  if (intent.kind === 'date') {
    return `It's ${days[now.getDay()]}, ${months[now.getMonth()]} ${ORDINALS[now.getDate()]}, ${now.getFullYear()}.`;
  }
  return '';
}
