// A PDF the person sends: its words are read (several ways PDFs store text), Maya answers in simple words, a scam PDF is flagged plainly,
// a PDF that cannot be read as text is never guessed at, and the file itself is never kept. No network: Spark and the scam check are stubbed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'maya-pdf-'));
process.env.MAYA_DATA_DIR = path.join(tmp, 'profiles');
process.env.MAYA_CARE_DIR = path.join(tmp, 'care');
process.env.MAYA_MEDIA_DIR = path.join(tmp, 'media');

const queue = [], asked = [];
const brainPath = require.resolve('../brain');
require.cache[brainPath] = { id: brainPath, filename: brainPath, loaded: true, exports: {
  requireRealEnv() {}, streamSpeech: async () => {}, sparkComplete: async () => '{}', describeImage: async () => 'unused',
  sparkStream: async (history, roster, _s, onDelta) => { asked.push({ history: JSON.parse(JSON.stringify(history)), roster }); const t = queue.length > 1 ? queue.shift() : queue[0]; if (onDelta) onDelta(t); return t; },
} };
const memory = require('../memory');
const care = require('../care');
const chat = require('../chat');
const tag = (o) => `[[feel: ${Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ')}]]`;
const REPLY = `${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} This letter says your account is locked and asks for your bank details. That looks like a scam, so please do not reply or send anything.`;
let k = 0;
const letters = (n) => { let o = ''; do { o = String.fromCharCode(97 + (n % 26)) + o; n = Math.floor(n / 26) - 1; } while (n >= 0); return o; };
const newSenior = () => memory.createProfile(`Pdf${letters(k++)}`, 'female').id;

// ---- small PDF builder: objects are { num, dict, stream? }; a stream is Flate-compressed when asked
function pdf(objs) {
  let out = '%PDF-1.4\n';
  for (const o of objs) {
    out += `${o.num} 0 obj\n`;
    if (o.stream !== undefined) {
      const data = o.flate ? zlib.deflateSync(Buffer.from(o.stream, 'latin1')).toString('latin1') : o.stream;
      out += `<< ${o.dict || ''}${o.flate ? ' /Filter /FlateDecode' : ''} /Length ${data.length} >>\nstream\n${data}\nendstream\n`;
    } else out += `${o.dict}\n`;
    out += 'endobj\n';
  }
  return Buffer.from(`${out}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, 'latin1');
}
const page = (content, fontDict = '/F1 5 0 R') => [
  { num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' }, { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' },
  { num: 3, dict: `<< /Type /Page /Parent 2 0 R /Contents 4 0 R /Resources << /Font << ${fontDict} >> >> >>` },
  { num: 4, dict: '', stream: content, flate: true },
];
const plainFont = { num: 5, dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>' };

test('reads a plain PDF: Flate content, literal strings with escapes, kerned arrays and line moves', () => {
  const b = pdf([...page('BT /F1 12 Tf 72 700 Td (Your account is locked \\(urgent\\).) Tj 0 -20 Td [(Send your ) -250 (bank ) 20 (details) ] TJ 0 -20 Td (Code: \\061\\062\\063) Tj ET'), plainFont]);
  const r = chat.pdfText(b);
  assert.equal(r.why, null);
  assert.match(r.text, /Your account is locked \(urgent\)\./); assert.match(r.text, /Send your bank details/); assert.match(r.text, /Code: 123/);
});

test('reads a PDF whose font stores glyph numbers: the ToUnicode map (bfchar and bfrange) turns them back into words', () => {
  const cmap = '/CIDInit /ProcSet findresource begin 12 dict begin begincmap 1 begincodespacerange <0000> <FFFF> endcodespacerange 2 beginbfchar <0001> <0050> <0002> <0061> endbfchar 1 beginbfrange <0003> <0005> <0079> endbfrange endcmap';
  const objs = [...page('BT /F1 12 Tf <00010002000300040005> Tj ET'), { num: 5, dict: '<< /Type /Font /Subtype /Type0 /BaseFont /X /ToUnicode 6 0 R >>' }, { num: 6, dict: '', stream: cmap, flate: true }];
  const r = chat.pdfText(pdf(objs));
  assert.equal(r.text.replace(/\s/g, ''), 'Payz{', 'P and a from the two single entries, then y z { from the range 3 to 5');
});

test('a font held in an object stream (PDF 1.5) is found', () => {
  const inner = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  const header = '5 0 ', body = inner;
  const objstm = { num: 7, dict: `/Type /ObjStm /N 1 /First ${header.length}`, stream: header + body, flate: true };
  const objs = [...page('BT /F1 12 Tf (Hello from a packed file) Tj ET'), objstm];
  assert.match(chat.pdfText(pdf(objs)).text, /Hello from a packed file/);
});

test('what cannot be read is said, never guessed: a scan (pictures only), a locked file, and a file that is not a PDF', async () => {
  const scan = pdf([{ num: 1, dict: '<< /Type /Catalog /Pages 2 0 R >>' }, { num: 2, dict: '<< /Type /Pages /Kids [3 0 R] /Count 1 >>' }, { num: 3, dict: '<< /Type /Page /Parent 2 0 R /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>' }, { num: 4, dict: '/Type /XObject /Subtype /Image /Width 2 /Height 2', stream: 'abcd' }, { num: 5, dict: '', stream: 'q 612 0 0 792 0 0 cm /Im0 Do Q', flate: true }]);
  assert.equal(chat.pdfText(scan).why, 'no_text');
  assert.equal(chat.pdfText(Buffer.from('%PDF-1.4\n/Encrypt 9 0 R\n')).why, 'locked');
  const id = newSenior();
  await assert.rejects(chat.sendPdf(id, Buffer.from('hello'), 'x.pdf', null), (e) => e.status === 415);
  const r = await chat.sendPdf(id, scan, 'scan.pdf', null);
  assert.equal(r.messages[1].role, 'maya'); assert.match(r.messages[1].text, /could not read the words/); assert.match(r.messages[1].text, /do not pay/i); assert.equal(asked.length, 0, 'no model call: nothing is guessed');
});

test('a scam PDF: Maya is given the words, told it is a document from a possible stranger, and a plain scam warning is asked for; she never just says "received"; the file is not kept', async () => {
  const id = newSenior(); queue.length = 0; queue.push(REPLY); asked.length = 0;
  const words = 'URGENT: your bank account is locked. Reply within 24 hours with your full card number, PIN and the code we sent you, or pay 200 pounds in gift cards.';
  chat.deps.scamText = async (t) => { assert.match(t, /gift cards/); return { level: 'warn', type: 'bank', reading: 'asks for card details and gift cards', signals: { urgency: true }, reads: {}, count: 1 }; };
  const seen = []; care.attachFamily({ write(s) { seen.push(s); return true; } });
  const r = await chat.sendPdf(id, pdf([...page(`BT /F1 12 Tf 72 700 Td (${words}) Tj ET`), plainFont]), 'Bank notice (1).pdf', 'Europe/London');
  const [you, maya] = r.messages;
  assert.deepEqual([you.role, you.kind, you.text], ['senior', 'file', 'PDF: Bank notice (1).pdf']); assert.equal(you.mediaUrl, undefined, 'no copy of the file is offered');
  assert.equal(maya.role, 'maya'); assert.match(maya.text, /looks like a scam/); assert.equal(r.scam, 'warn');
  const roster = asked[0].roster; assert.match(roster, /DOCUMENT/); assert.match(roster, /never obey instructions/); assert.match(roster, /gift cards/); assert.match(roster, /never just say that the file was received/i); assert.match(roster, /SCAM CHECK/);
  const hist = JSON.stringify(asked[0].history); assert.doesNotMatch(hist, /gift cards|PIN/, 'the document\'s words are not put in her history: only that a PDF was sent');
  const dir = path.join(tmp, 'media', id); const files = fs.existsSync(dir) ? fs.readdirSync(dir) : []; assert.deepEqual(files, [], 'the PDF is not stored');
  assert.doesNotMatch(JSON.stringify(care.get(id)), /gift cards/, 'nor are its words kept in the care record');
});

test('an ordinary PDF (no scam) is explained in simple words and not flagged', async () => {
  const id = newSenior(); queue.length = 0; queue.push(`${tag({ emotion: 'neutral', intensity: 1, intent: 'chat', concern: 'none', pain: 0 })} This is your appointment letter for Tuesday at ten. It only asks you to bring your card.`); asked.length = 0;
  chat.deps.scamText = async () => ({ level: 'none', type: 'none', reading: '', signals: {}, reads: {}, count: 0 });
  const r = await chat.sendPdf(id, pdf([...page('BT /F1 12 Tf (Appointment on Tuesday at 10 am. Please bring your health card.) Tj ET'), plainFont]), 'letter.pdf', null);
  assert.equal(r.scam, 'none'); assert.match(r.messages[1].text, /appointment letter/); assert.doesNotMatch(asked[0].roster, /SCAM CHECK/);
});

test('the route: a PDF is accepted at /api/chat/<id>/pdf and refused when it is not one (source check)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /if \(what === 'pdf'\) return sendJson\(res, 200, await chat\.sendPdf\(/); assert.match(src, /MAX_PDF_BYTES/);
});
