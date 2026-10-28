// Scam routing, narrow widening (scam.needsCheck / checkPlan): an OUTSIDE PARTY asking for something to be handed over or done, and doing it right now.
// The two held-out scams the cheap filter let through (S010 pension + "give my bank number", S130 computer support + "type in the address ... about to
// press enter") are REGRESSION cases from here on, not fresh evidence: the filter was changed after seeing them. The variants below were written
// separately, in different words, AFTER the change was designed; they are development cases too, not a blind test. Pure, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../scam');

const ROOT = path.join(__dirname, '..');
const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'scam-testset.json'), 'utf8')).items;
const chat = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', 'ordinary-chat-lines.json'), 'utf8')).lines;
const byId = (id) => items.find((i) => i.id === id);

const VARIANTS = [
 'A woman rang from the benefits office and said my payments will be cancelled unless I read her my account digits.',
 'Someone from the pension service phoned. They say there was an error and I must confirm my bank sort code and number to get it fixed.',
 'The tax people called and said I need to give them my national insurance number today or there will be trouble.',
 'A young man is on the line saying my broadband is hacked. He wants me to open a page and type in the code he is reading to me.',
 'The man from computer support told me to click the link he emailed and I am clicking it now.',
 'He has taken over my screen to fix a virus and now he wants me to log in to my bank so he can check it.',
 'The lady from the electricity company says I am owed a refund and asked me to put in my card details on a page she sent.',
 'My grandson rang in a state. He said do not tell mum, he needs money sent to a friend straight away.',
 'The bank called and said my account is not safe and I should move my savings to a new account they will give me.',
 'He said to stay on the phone while I go to the shop and he is still talking to me now.',
 'A text says there is a parcel fee and I am about to tap the link and enter my card number.',
 'The man says the council will take me to court, and he is waiting while I type my details in.',
 'Somebody phoned about my pension being stopped, and they want my date of birth and bank details to restart it.',
 'The engineer on the phone asked me to download a small program so he can see what is wrong, and I am downloading it now.',
];
const ORDINARY = [
 'I called the bank to ask about opening hours and they were very helpful.',
 'My daughter asked me to send her the recipe for the apple cake.',
 'I gave my address to the florist so they can deliver the flowers.',
 'The council changed the bin collection to Tuesdays.',
 'I paid the window cleaner this morning, he did a lovely job.',
 'My son phoned and we talked about his holiday plans.',
 'I opened the website to check the weather and it is going to rain.',
 'The nurse rang to remind me about my appointment on Thursday.',
 'I am going to the post office to send a parcel to my sister.',
 'He told me to take my time with the crossword, so I did.',
 'I read the newspaper and then had my lunch.',
 'The computer is slow today so I just watched television instead.',
 'My grandson showed me how to press the button to take a photo.',
 'I went to the cash machine and took out some money for the market.',
 'The pension came in on Friday as usual and I bought some flowers.',
 'I need to give the plumber a ring about the tap.',
 'My neighbour asked me to look after her cat while she is away.',
 'I typed a letter to my cousin on the computer this afternoon.',
 'They said on the radio that the buses will be late tomorrow.',
 'I am so tired today, I think I will have an early night.',
 'The insurance renewal arrived in the post and I read through it with my daughter.',
 'I enjoy visiting the garden centre, there is a nice café there.',
 'I told my friend about the film and she wants to see it too.',
 'My phone battery is almost flat so I put it on charge.',
];

test('regression: the two held-out scams the filter missed are now worth a check, and the one in progress is awaited', () => {
  assert.equal(S.needsCheck(byId('S010').text), true, 'pension stopped, give my bank number');
  assert.equal(S.needsCheck(byId('S130').text), true, 'computer support, type in the address, about to press enter');
  assert.deepEqual(S.checkPlan(byId('S130').text), { check: true, await: true });
});

test('regression: all 76 scam items (dev and held-out) are routed to a check, and the filter-level cost is stated honestly', () => {
  const scams = items.filter((i) => i.label === 'scam');
  assert.equal(scams.length, 76);
  assert.deepEqual(scams.filter((i) => !S.needsCheck(i.text)).map((i) => i.id), []);
  // Cost side, for the record: written normal messages that still reach a check (a check that comes back "nothing"; never a warning by itself).
  const normals = items.filter((i) => i.label === 'normal');
  assert.ok(normals.filter((i) => S.needsCheck(i.text)).length <= 50, 'was 47 of 76 before this change, 48 after');
});

test('independently written variants (other words, other bodies: benefits, tax, broadband, remote support, parcel, council, a grandson in trouble) are all routed', () => {
  assert.equal(VARIANTS.length, 14);
  assert.deepEqual(VARIANTS.filter((t) => !S.needsCheck(t)), []);
});

test('ordinary talk stays cheap: the clean lines are not checked, and the list costs no more than before the change', () => {
  assert.equal(ORDINARY.length, 24);
  const hits = ORDINARY.filter((t) => S.needsCheck(t));
  assert.ok(hits.length <= 4, hits.join(' | '));      // 4 of 24 before this change, the same 4 after (a check that comes back "nothing")
  for (const t of ['I called the bank to ask about opening hours and they were very helpful.', 'My daughter asked me to send her the recipe for the apple cake.', 'I gave my address to the florist so they can deliver the flowers.', 'My son phoned and we talked about his holiday plans.', 'The pension came in on Friday as usual and I bought some flowers.', 'I typed a letter to my cousin on the computer this afternoon.', 'I need to give the plumber a ring about the tap.']) assert.equal(S.needsCheck(t), false, t);
  assert.ok(chat.filter(S.needsCheck).length <= 2, 'the 30 everyday chat lines still cost at most 2 checks');
});

test('doing it as they speak is "happening now": progressive actions and a caller still waiting are awaited, only when a check is wanted at all', () => {
  for (const t of ['The man from computer support is on the line and I am typing the code he gave me in now.', 'A woman rang about my pension and she is still on the line waiting while I read my account digits out.', 'The bank called to say my account is unsafe and I am just about to press enter on the page they told me to open.']) {
    const plan = S.checkPlan(t); assert.equal(plan.check, true, t); assert.equal(plan.await, true, t);
  }
  assert.deepEqual(S.checkPlan('I am typing a letter to my cousin.'), { check: false, await: false });
  assert.equal(S.checkPlan('The council changed the bin day and my neighbour is waiting for the bus.').await, false, 'waiting alone, with nothing to check, awaits nothing');
});
