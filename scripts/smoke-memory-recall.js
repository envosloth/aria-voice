#!/usr/bin/env node
/* Memory retrieval benchmark (roadmap P0.2 gate: recall >= 90% on 50 facts).
 *
 * 50 stored facts spanning preferences, projects, routines, people, facts.
 * 50 later questions, each labeled with the fact it needs, phrased the way a
 * user would ask — not by copying the fact's words. Recall@budget = the needed
 * fact is inside the block that would be sent (selectMemories, 1200 chars).
 * With 50 short facts nearly everything fits the budget, which would make the
 * test trivial, so it is also scored at a tight 300-char budget (~6 facts) —
 * that one measures ranking, and it is the number reported as the bar.
 */
const path = require('path');
const M = require(path.join(__dirname, '..', 'dist', 'main', 'user-memory'));

const FACTS = [
  ['f1', 'I prefer metric units'], ['f2', 'my dog is named Biscuit'], ['f3', "I'm allergic to peanuts"],
  ['f4', "I'm working on a Blender short called Moth"], ['f5', 'I go to the gym every Tuesday and Thursday morning'],
  ['f6', 'my sister Maria lives in Denver'], ['f7', 'my favourite coffee is a flat white'], ['f8', 'I use Fedora Linux on my laptop'],
  ['f9', 'my YouTube channel is about Blender animation'], ['f10', 'I upload a new video every Friday'],
  ['f11', "I'm vegetarian"], ['f12', 'my boss is named Priya'], ['f13', 'I live in Longmont, Colorado'],
  ['f14', 'I study at the community college on Monday evenings'], ['f15', 'my car is a 2014 Honda Fit'],
  ['f16', 'I hate cilantro'], ['f17', 'my wifi router is in the hallway closet'], ['f18', "my mom's birthday is March 3rd"],
  ['f19', 'I prefer dark mode everywhere'], ['f20', 'my render machine has a Radeon RX 9060 XT'],
  ['f21', 'I wake up at 6:30 on weekdays'], ['f22', 'my cat is called Pixel'], ['f23', 'I play guitar badly'],
  ['f24', 'my partner Sam works night shifts'], ['f25', 'I want replies short and to the point'],
  ['f26', "I'm learning Spanish on Duolingo"], ['f27', 'my bank is Elevations Credit Union'],
  ['f28', 'I take my medication at 9pm every night'], ['f29', 'my favourite band is Radiohead'],
  ['f30', "I'm building a voice assistant called ARIA"], ['f31', 'my landlord is Mr. Okafor'],
  ['f32', 'I drink oat milk'], ['f33', 'my passport expires in 2029'], ['f34', 'I run 5k on Sunday mornings'],
  ['f35', 'my best friend Jordan lives in Portland'], ['f36', 'I prefer window seats on flights'],
  ['f37', "I'm saving for a new graphics tablet"], ['f38', 'my dentist appointment is every six months at Smile Dental'],
  ['f39', 'the spare house key is under the blue flowerpot'], ['f40', 'I edit videos in DaVinci Resolve'],
  ['f41', 'my shoe size is 10'], ['f42', "I'm writing a script for episode 12 about lighting"],
  ['f43', 'my brother Luis is a nurse'], ['f44', 'I prefer Celsius for weather'], ['f45', 'I grocery shop on Saturday afternoons'],
  ['f46', "my son's school is Blue Mountain Elementary"], ['f47', 'I like lo-fi music while I work'],
  ['f48', 'my phone is a Pixel 8'], ['f49', 'I back up my projects to a microSD card'], ['f50', "I'm trying to cut back on sugar"],
];
const QUESTIONS = [
  ['f1', 'how far is it to Boulder?'], ['f2', 'what should I name the treat jar for my dog?'], ['f3', 'is this satay sauce safe for me?'],
  ['f4', 'how is my Moth animation coming along, any tips on the short?'], ['f5', 'can I book a dentist slot Tuesday morning or am I at the gym?'],
  ['f6', 'when I visit my sister what city am I flying to?'], ['f7', 'order me my usual coffee'], ['f8', 'how do I install OBS on my laptop?'],
  ['f9', 'give me video ideas for my channel'], ['f10', 'when is my next upload due?'],
  ['f11', 'suggest a dinner recipe, keep in mind I am vegetarian'], ['f12', 'draft an email to my boss about Friday'],
  ['f13', "what's the weather like where I live?"], ['f14', 'am I free Monday evening?'], ['f15', 'what tire size does my car need?'],
  ['f16', 'is there cilantro in pico de gallo? I want to avoid it'], ['f17', 'where is my router so I can reboot it?'],
  ['f18', 'when is my mom\'s birthday again?'], ['f19', 'should this new app use a light or dark theme?'],
  ['f20', 'which GPU is in my render machine?'], ['f21', 'set my alarm for my usual weekday wake-up time'],
  ['f22', 'what is my cat called?'], ['f23', 'recommend a beginner guitar song'], ['f24', 'is Sam awake right now? my partner works nights'],
  ['f25', 'explain quantum computing'], ['f26', 'help me practice my Spanish'], ['f27', 'which bank do I use?'],
  ['f28', 'remind me about my medication tonight'], ['f29', 'is my favourite band touring?'], ['f30', 'what should the next ARIA assistant feature be?'],
  ['f31', 'write a note to my landlord about the heater'], ['f32', 'add milk to the shopping list, the kind I drink'],
  ['f33', 'do I need to renew my passport soon?'], ['f34', 'plan my Sunday morning run'], ['f35', 'what city does Jordan live in?'],
  ['f36', 'book my flight seat'], ['f37', 'how much have I saved toward the graphics tablet?'], ['f38', 'when is my next dentist visit?'],
  ['f39', "I'm locked out, where's the spare key?"], ['f40', 'how do I color grade in my video editor?'],
  ['f41', 'order running shoes in my size'], ['f42', 'what was the episode 12 script about?'], ['f43', 'what does my brother Luis do for work?'],
  ['f44', 'is it cold outside in degrees?'], ['f45', 'when do I usually go grocery shopping?'], ['f46', 'what school does my son go to?'],
  ['f47', 'put on some music while I work'], ['f48', 'how do I take a screenshot on my phone?'], ['f49', 'where do I back up my projects?'],
  ['f50', 'suggest a dessert, I am cutting back on sugar'],
];

const items = FACTS.map(([id, text], i) => ({ id, text, kind: M.classifyMemory(text), createdAt: 1000 + i, updatedAt: 1000 + i, source: 'explicit', sourceText: text }));
function recall(budget) {
  const misses = [];
  for (const [need, q] of QUESTIONS) {
    const sel = M.selectMemories(items, q, budget);
    if (!sel.some((m) => m.id === need)) misses.push(`${need}: "${q}"`);
  }
  return { recall: (QUESTIONS.length - misses.length) / QUESTIONS.length, misses };
}
const wide = recall(1200);
const tight = recall(300);
console.log(`recall @1200 chars (production budget): ${(wide.recall * 100).toFixed(0)}%`);
console.log(`recall @300 chars  (ranking test):      ${(tight.recall * 100).toFixed(0)}%`);
for (const m of tight.misses) console.log('  miss @300: ' + m);
const pass = wide.recall >= 0.9 && tight.recall >= 0.9;
console.log(`\n=== RESULT: ${pass ? 'PASS' : 'FAIL'} ===`);
process.exit(pass ? 0 : 1);
