#!/usr/bin/env node
/* Unit test for local instant intents (local-intents.ts) + the timer scheduler
 * (timers.ts). Pure-node: JsonStore falls back to $HOME/.aria outside Electron,
 * so HOME is pointed at a temp dir BEFORE the modules load. */
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aria-timers-test-'));
process.env.HOME = tmpHome;

const { matchLocalIntent, answerFor, nextOccurrence, parseDuration, humanizeMs, formatClock } =
  require('../dist/main/local-intents');

let pass = true;
function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) pass = false;
  console.log(`[${name}] ${ok ? 'PASS' : `FAIL: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`}`);
}
function kindOf(msg) { const m = matchLocalIntent(msg); return m ? m.kind : null; }

// --- time/date (positive) ---
check('time-basic', kindOf('What time is it?'), 'time');
check('time-current', kindOf("what's the current time"), 'time');
check('time-know', kindOf('do you know what time it is'), 'time');
check('time-tell', kindOf('tell me the time'), 'time');
check('time-now', kindOf('what time is it right now'), 'time');
check('time-hey', kindOf('Hey, what time is it?'), 'time');
check('date-basic', kindOf("what's the date today?"), 'date');
check('date-day', kindOf('what day is it'), 'date');
check('date-todays', kindOf("what's today's date"), 'date');

// --- time/date (negative: context tails, explicit agent, chit-chat) ---
check('time-tokyo', kindOf('what time is it in Tokyo'), null);
check('time-agent', kindOf('ask the agent what time it is'), null);
check('how-are-you', kindOf('how are you today'), null);
check('time-history', kindOf('what time is it useful to study history'), null);

// --- timers ---
check('timer-10m', matchLocalIntent('set a timer for 10 minutes'), { kind: 'timer_set', ms: 600000, label: '10 minutes' });
check('timer-90s', matchLocalIntent('Set a timer for 90 seconds.'), { kind: 'timer_set', ms: 90000, label: '1 minute and 30 seconds' });
check('timer-adj', matchLocalIntent('start a 5 minute timer'), { kind: 'timer_set', ms: 300000, label: '5 minutes' });
check('timer-compound', matchLocalIntent('set a timer for 1 hour and 30 minutes'), { kind: 'timer_set', ms: 5400000, label: '1 hour and 30 minutes' });
check('timer-word', matchLocalIntent('set a timer for five minutes'), { kind: 'timer_set', ms: 300000, label: '5 minutes' });
check('timer-vague', kindOf('set a timer for my meeting'), null); // falls to harness

// --- alarms ---
check('alarm-7am', matchLocalIntent('set an alarm for 7am'), { kind: 'alarm_set', hour: 7, minute: 0, explicitMeridiem: true });
check('alarm-730pm', matchLocalIntent('set an alarm for 7:30 pm'), { kind: 'alarm_set', hour: 19, minute: 30, explicitMeridiem: true });
check('alarm-wake', matchLocalIntent('wake me up at 6:15 am'), { kind: 'alarm_set', hour: 6, minute: 15, explicitMeridiem: true });
check('alarm-bare-8', matchLocalIntent('set an alarm for 8'), { kind: 'alarm_set', hour: 8, minute: 0, explicitMeridiem: false });

// --- reminders ---
check('remind-in', matchLocalIntent('remind me to call mom in 20 minutes'), { kind: 'reminder_set', text: 'call mom', ms: 1200000 });
check('remind-at', matchLocalIntent('remind me to take the pizza out at 6:30 pm'), { kind: 'reminder_set', text: 'take the pizza out', hour: 18, minute: 30, explicitMeridiem: true });
check('remind-noon', matchLocalIntent('remind me about the meeting at noon'), { kind: 'reminder_set', text: 'the meeting', hour: 12, minute: 0, explicitMeridiem: true });
check('remind-vague', kindOf('remind me when the game starts'), null); // falls to harness
// Greedy text split: " in "/" at " inside the reminder text must not break the parse
check('remind-in-in', matchLocalIntent('remind me to put the turkey in the oven in 20 minutes'), { kind: 'reminder_set', text: 'put the turkey in the oven', ms: 1200000 });
check('remind-at-at', matchLocalIntent('remind me to look at the roast at 6 pm'), { kind: 'reminder_set', text: 'look at the roast', hour: 18, minute: 0, explicitMeridiem: true });
// Stacked leading filler (wake-phrase echoes) is stripped repeatedly
check('time-hey-aria', kindOf('Hey aria, what time is it?'), 'time');
check('time-jarvis', kindOf('jarvis what time is it'), 'time');

// --- cancel / list ---
check('cancel-timer', matchLocalIntent('cancel the timer'), { kind: 'timer_cancel', what: 'timer' });
check('cancel-alarms', matchLocalIntent('cancel my alarms'), { kind: 'timer_cancel', what: 'alarm' });
check('list-timers', kindOf('what timers do I have?'), 'timer_list');
check('list-reminders', kindOf('list my reminders'), 'timer_list');

// --- answers / helpers (fixed clock: Thu 2026-07-09 15:42) ---
const now = new Date(2026, 6, 9, 15, 42, 0);
check('answer-time', answerFor({ kind: 'time' }, now), "It's 3:42 PM.");
check('answer-date', answerFor({ kind: 'date' }, now), "It's Thursday, July ninth, 2026.");
check('clock-noon', formatClock(new Date(2026, 6, 9, 12, 0)), '12 PM');
check('dur-half-hour', parseDuration('half an hour'), 1800000);
check('humanize-1h', humanizeMs(3600000), '1 hour');

// nextOccurrence: explicit 7am asked at 15:42 -> tomorrow 07:00; bare "8" -> 8pm today
const next7am = new Date(nextOccurrence(7, 0, true, now));
check('next-7am-tomorrow', [next7am.getDate(), next7am.getHours()], [10, 7]);
const next8 = new Date(nextOccurrence(8, 0, false, now));
check('next-bare-8-tonight', [next8.getDate(), next8.getHours()], [9, 20]);

// --- timers.ts: schedule -> fire -> removed; persistence on disk; cancel ---
const timers = require('../dist/main/timers');
(async () => {
  let fired = null;
  timers.initTimers((text) => { fired = text; });

  timers.createTimer('timer', '1 second', Date.now() + 300);
  const persisted = JSON.parse(fs.readFileSync(path.join(tmpHome, '.aria', 'timers.json'), 'utf8'));
  check('timer-persisted', persisted.items.length, 1);

  await new Promise((r) => setTimeout(r, 700));
  check('timer-fired', fired, 'Your 1 second timer is done.');
  check('timer-removed', timers.listTimers().length, 0);

  timers.createTimer('reminder', 'stretch', Date.now() + 60000);
  timers.createTimer('alarm', '7 AM', Date.now() + 60000);
  check('cancel-kind', timers.cancelTimers('reminder'), 1);
  check('cancel-all', timers.cancelTimers('all'), 1);
  check('list-empty', timers.listTimers().length, 0);

  // Missed-fire on init: a rec 5s in the past announces once with the prefix.
  fs.writeFileSync(path.join(tmpHome, '.aria', 'timers.json'), JSON.stringify({
    items: [{ id: 'x', kind: 'reminder', label: 'take out the trash', fireAt: Date.now() - 5000, createdAt: Date.now() - 10000 }],
  }));
  delete require.cache[require.resolve('../dist/main/timers')];
  delete require.cache[require.resolve('../dist/main/json-store')];
  const timers2 = require('../dist/main/timers');
  let missed = null;
  timers2.initTimers((text) => { missed = text; });
  check('missed-announced', missed, "While I was closed — Here's your reminder: take out the trash.");
  check('missed-removed', timers2.listTimers().length, 0);

  fs.rmSync(tmpHome, { recursive: true, force: true });
  console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
  process.exit(pass ? 0 : 1);
})();
