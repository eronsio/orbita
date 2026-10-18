// Unit tests for Orbita's pure logic (parsing, location inference, merging, duplicates, CSV safety).
// Run with:  node tests/unit.test.js
//
// index.html is a single file, so this pulls the inline <script> out of it, drops the DOM-bound `Orbita`
// class, and exercises the top-level functions. All data below is synthetic: never paste real contacts here,
// this repo is public.
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
let src = html.slice(html.indexOf("<script>\n    'use strict'") + '<script>\n'.length, html.lastIndexOf('</script>'));
src = src.replace(/class Orbita \{[\s\S]*\n    \}\n\n    document\.addEventListener[\s\S]*$/, '');
if (/class Orbita/.test(src)) throw new Error('Could not strip the Orbita class: the extraction pattern needs updating');
src += `\nmodule.exports = { parsePhone, inferLocation, normalizePerson, contactKeys, fillMissing, rowToPerson, parseVCF,
  parseLocationText, applyInferredLocation, findDuplicateCandidates, mergeScore, csvSafe, esc, fold, SAMPLE_PEOPLE, threeWayMerge, mergeInto };`;
const sandbox = path.join(require('os').tmpdir(), `orbita_unit_${process.pid}.js`);
fs.writeFileSync(sandbox, src.replace("'use strict';", "'use strict'; const document = { getElementById() { return null; } }; const location = { hostname: 'example.com', search: '' }; const localStorage = { getItem() { return null; } };"));
const m = require(sandbox);
fs.unlinkSync(sandbox);

let failures = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) === JSON.stringify(want)) { console.log('ok  ', name); return; }
  failures++;
  console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
};
const person = (o) => m.normalizePerson({ name: 'X', ...o });

// ---- phone parsing ----
eq('es mobile, no plus', m.parsePhone('665 21 05 45'), { cc: 'ES', national: '665210545' });
eq('es dashed', m.parsePhone('608-362-142'), { cc: 'ES', national: '608362142' });
eq('+34', m.parsePhone('+34 600 111 222'), { cc: 'ES', national: '600111222' });
eq('00 prefix is international', m.parsePhone('00 33 1 23 45 67 89').cc, 'FR');
eq('us 10 digits', m.parsePhone('5855550123'), { cc: 'US', national: '5855550123' });
eq('us 1-xxx', m.parsePhone('1-412-555-0123'), { cc: 'US', national: '4125550123' });
eq('+216', m.parsePhone('+216 53 000 000').cc, 'TN');
eq('+86', m.parsePhone('+8613800000000').cc, 'CN');
eq('+54', m.parsePhone('+54 9 11 5555 5555').cc, 'AR');
eq('garbage', m.parsePhone('abc'), null);

// ---- location inference (label AND coordinates) ----
const loc = (o) => { const r = m.inferLocation(o); return r && [r.geoSource, r.country]; };
const coords = (o) => { const r = m.inferLocation(o); return r && [r.lat, r.lng]; };
eq('Rochester area code', loc({ phones: ['(585) 555-0123'] }), ['area-code', 'United States']);
eq('LA 818 coords', coords({ phones: ['+1-818-555-0100'] }), [34.0522, -118.2437]);
eq('NYC 646 coords', coords({ phones: ['+1 646-555-0100'] }), [40.7128, -74.006]);
eq('Rochester 585 coords', coords({ phones: ['5855550123'] }), [43.1566, -77.6088]);
eq('unknown US area code falls back to country', loc({ phones: ['+1 999 111 2222'] }), ['phone', 'United States']);
eq('Galicia landline label', loc({ phones: ['986 00 00 00'] }), ['area-code', 'Spain']);
eq('Vigo landline coords', coords({ phones: ['986 00 00 00'] }), [42.2406, -8.7207]);
eq('A Coruna landline coords', coords({ phones: ['981000000'] }), [43.3623, -8.4115]);
eq('Spanish mobile is country-level', loc({ phones: ['+34 648 00 00 00'] }), ['phone', 'Spain']);
eq('state abbreviation', loc({ region: 'VA' }), ['region', 'United States']);
eq('state name', loc({ region: 'Louisiana' }), ['region', 'United States']);
eq('country text', loc({ country: 'Italy' }), ['country', 'Italy']);
eq('country alias', loc({ country: 'USA' }), ['country', 'United States']);
eq('unknown country is left for the geocoder', loc({ country: 'Narnia' }), null);
eq('ccTLD', loc({ emails: ['someone@university.es'] }), ['email-domain', 'Spain']);
eq('gmail gives nothing', loc({ emails: ['x@gmail.com'] }), null);
eq('phone beats email', loc({ phones: ['+39 300 000 0000'], emails: ['x@foo.es'] }), ['phone', 'Italy']);

// ---- Google CSV rows ----
const g = m.rowToPerson({
  'First Name': 'Ada', 'Middle Name': 'Q', 'Last Name': 'Example', Labels: 'Friends ::: * myContacts',
  'E-mail 1 - Value': 'ada@example.com', 'Phone 1 - Value': '+34 600 000 001 ::: +34 600 000 002',
});
eq('google name parts', g.name, 'Ada Q Example');
eq('google drops the myContacts system label', g.tags, ['Friends']);
eq('google primary + alternate phone', [g.phone, g.altPhones], ['+34 600 000 001', ['+34 600 000 002']]);
eq('blank row -> null', m.rowToPerson({ 'First Name': '', 'E-mail 1 - Value': '' }), null);
eq('email-only contact is named by its email', m.normalizePerson(m.rowToPerson({ 'E-mail 1 - Value': 'only@example.com' })).name, 'only@example.com');
eq('generic csv tags', m.rowToPerson({ Name: 'Ann', Email: 'a@example.com', Tags: 'x, y' }).tags, ['x', 'y']);
eq('generic csv lat/lng', m.normalizePerson(m.rowToPerson({ Name: 'Ann', lat: '10.5', lng: '20.5' })).lat, 10.5);
eq('export guard apostrophe is stripped on import', m.rowToPerson({ Name: "'=SUM(A1)" }).name, '=SUM(A1)');
eq('geosource column round-trips', m.normalizePerson(m.rowToPerson({ Name: 'A', lat: '1', lng: '2', geosource: 'area-code' })).geoSource, 'area-code');
eq('unknown geosource is dropped', m.normalizePerson(m.rowToPerson({ Name: 'A', lat: '1', lng: '2', geosource: 'bogus' })).geoSource, 'imported');

// ---- normalisation ----
eq('legacy identifiers', ((p) => [p.email, p.phone])(m.normalizePerson({ name: 'A', identifiers: { emails: ['e@example.com'], phones: ['1'] } })), ['e@example.com', '1']);
eq('profession -> occupation', m.normalizePerson({ name: 'A', profession: 'Chef' }).occupation, 'Chef');
eq('latitude/longitude aliases', m.normalizePerson({ name: 'A', latitude: '41.4', longitude: '2.1' }).lat, 41.4);
eq('0,0 is rejected', m.normalizePerson({ name: 'A', lat: 0, lng: 0 }).lat, null);
eq('tier "Tier 2"', m.normalizePerson({ name: 'A', tier: 'Tier 2' }).tier, 2);
eq('tags string', m.normalizePerson({ name: 'A', tags: 'a, b ,a' }).tags, ['a', 'b']);
eq('legacy pin on a country centre is labelled country', m.normalizePerson({ name: 'A', lat: 39.8283, lng: -98.5795 }).geoSource, 'country');
eq('legacy pin elsewhere is labelled imported', m.normalizePerson({ name: 'A', lat: 41.1, lng: 2.2 }).geoSource, 'imported');

// ---- merge keys ----
const k1 = m.contactKeys(person({ id: 'x', phone: '+34 600 11 22 33' }));
const k2 = m.contactKeys(person({ id: 'y', phone: '600-112-233' }));
eq('same phone in two formats shares a key', k1.filter((k) => k2.includes(k)), ['t:600112233']);

// ---- merging (coordinates, not just labels) ----
const approx = person({ id: 'a', phone: '+1-818-555-0100', lat: 34.0522, lng: -118.2437, geoSource: 'area-code' });
m.fillMissing(approx, person({ id: 'b', phone: '+1-818-555-0100', lat: 39.8283, lng: -98.5795 }));
eq('coarse legacy pin does not replace an area-code pin', [approx.lat, approx.lng, approx.geoSource], [34.0522, -118.2437, 'area-code']);
const legacy = person({ id: 'l', phone: '+1-818-555-0100', lat: 39.8283, lng: -98.5795 });
m.fillMissing(legacy, m.applyInferredLocation(person({ id: 'n', phone: '+1-818-555-0100' })));
eq('area-code pin upgrades a country-centre pin', [legacy.lat, legacy.lng, legacy.geoSource], [34.0522, -118.2437, 'area-code']);
const explicit = person({ id: 'e', phone: '+1 646 555 0100', lat: 40.7, lng: -73.9 });
m.fillMissing(explicit, m.applyInferredLocation(person({ id: 'f', phone: '+1 646 555 0100' })));
eq('area-code never beats an explicitly imported pin', [explicit.lat, explicit.geoSource], [40.7, 'imported']);
const rough = person({ id: 'r', phone: '1', lat: 39.8283, lng: -98.5795, geoSource: 'country' });
m.fillMissing(rough, person({ id: 's', phone: '1', lat: 40.1, lng: -75.2, geoSource: 'geocoded' }));
eq('geocoded pin replaces an approximate one', [rough.lat, rough.geoSource], [40.1, 'geocoded']);
const placed = person({ id: 'p', phone: '2', lat: 10, lng: 10, geoSource: 'manual' });
m.fillMissing(placed, person({ id: 'q', phone: '2', lat: 20, lng: 20, geoSource: 'geocoded' }));
eq('hand-placed pin is never replaced', [placed.lat, placed.lng], [10, 10]);
const blank = person({ id: 'z', phone: '3' });
m.fillMissing(blank, person({ id: 'zz', phone: '3', email: 'z@example.com', tags: ['a'], lat: 5, lng: 6 }));
eq('blank target takes coords, email and tags', [blank.lat, blank.lng, blank.email, blank.tags], [5, 6, 'z@example.com', ['a']]);
const keep = person({ id: 'k', name: 'A', email: 'keep@example.com' });
m.fillMissing(keep, person({ id: 'kk', name: 'B', email: 'other@example.com' }));
eq('existing fields survive; the other value becomes an alternate', [keep.email, keep.altEmails, keep.name], ['keep@example.com', ['other@example.com'], 'A']);

// ---- vCard ----
const vcf = `BEGIN:VCARD
VERSION:3.0
N:Example;Pat;;;
FN:Pat Example
EMAIL;type=INTERNET;type=pref:pat@example.com
TEL;type=CELL;type=VOICE;type=pref:+1 540-555-0100
item1.TEL;type=pref:+34 600 111 222
item1.X-ABLabel:Mobile
ADR;type=HOME:;;1 Test Street;Springfield;VA;24141;USA
NOTE:Neighbor\\, friend
END:VCARD
BEGIN:VCARD
VERSION:3.0
N:;Solo;;;
FN:Solo
TEL;type=CELL;type=VOICE;type=pref:+31 600000000
END:VCARD`;
const v = m.parseVCF(vcf);
eq('vcf: two cards', v.length, 2);
eq('vcf: email with params', v[0].email, 'pat@example.com');
eq('vcf: phones with params and item prefix', [v[0].phone, v[0].altPhones], ['+1 540-555-0100', ['+34 600 111 222']]);
eq('vcf: address parts', [v[0].city, v[0].region, v[0].country], ['Springfield', 'VA', 'USA']);
eq('vcf: note unescaping', v[0].notes, 'Neighbor, friend');
eq('vcf: second card', [v[1].name, v[1].phone], ['Solo', '+31 600000000']);

// ---- location text ----
eq('"City, Country"', m.parseLocationText('Madrid, Spain'), { city: 'Madrid', region: null, country: 'Spain' });
eq('"City, Region, Country"', m.parseLocationText('Austin, TX, USA'), { city: 'Austin', region: 'TX', country: 'USA' });
eq('country only', m.parseLocationText('Italy'), { country: 'Italy' });

// ---- escaping ----
eq('esc neutralises markup and quotes', m.esc('<img src=x onerror=alert(1)>"\''), '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;');

// ---- CSV formula safety ----
eq('formula is neutralised', m.csvSafe('=HYPERLINK("http://x")'), "'=HYPERLINK(\"http://x\")");
eq('@ and - are neutralised', [m.csvSafe('@cmd'), m.csvSafe('-cmd')], ["'@cmd", "'-cmd"]);
eq('international phone numbers are left alone', [m.csvSafe('+34 600 111 222'), m.csvSafe('+1 (555) 010-0100')], ['+34 600 111 222', '+1 (555) 010-0100']);
eq('several phone numbers in one cell are left alone', m.csvSafe('+34 600 111 222 ::: +34 600 111 333'), '+34 600 111 222 ::: +34 600 111 333');
eq('ordinary text is untouched', m.csvSafe('Hello'), 'Hello');

// ---- duplicate finder ----
const D = (id, name, extra = {}) => m.normalizePerson({ id, name, ...extra });
const reasons = (people, ignored) => m.findDuplicateCandidates(people, ignored).map((c) => [c.a.name, c.b.name, c.reason]);
eq('same name, accents ignored', reasons([D('1', 'Jose Perez', { email: 'a@example.com' }), D('2', 'José Pérez', { email: 'b@example.com' })]),
  [['Jose Perez', 'José Pérez', 'Same name']]);
eq('same email', reasons([D('1', 'A', { email: 'x@example.com' }), D('2', 'B', { email: 'X@example.com' })]),
  [['A', 'B', 'Same email address']]);
eq('same phone, different formats', reasons([D('1', 'A', { phone: '+34 600 111 222' }), D('2', 'B', { phone: '600-111-222' })]),
  [['A', 'B', 'Same phone number']]);
eq('first name + complementary details', reasons([D('1', 'Alex', { phone: '+1 555 010 0100' }), D('2', 'Alex Example', { email: 'n@example.com' })]).map((r) => r[2]),
  ['Same first name, and the details complement each other']);
eq('first name + conflicting phones is NOT flagged', reasons([D('1', 'Abel', { phone: '+34 600 000 001' }), D('2', 'Abel Che', { phone: '+34 600 000 002' })]), []);
eq('unrelated people are not flagged', reasons([D('1', 'Alice', { email: 'a@example.com' }), D('2', 'Bob', { email: 'b@example.com' })]), []);
eq('email-style names are never matched by name', reasons([D('1', 'a@example.com'), D('2', 'a@example.com', { phone: '+34 600 000 009' })]).map((r) => r[2]).filter((r) => r === 'Same name'), []);
const pairs = m.findDuplicateCandidates([D('1', 'Pat Dup', { email: 'p@example.com' }), D('2', 'Pat Dup', { email: 'q@example.com' })]);
eq('dismissed pairs stay hidden', m.findDuplicateCandidates([pairs[0].a, pairs[0].b], new Set([pairs[0].key])), []);
eq('exact matches sort before fuzzy ones', reasons([
  D('1', 'Alex', { phone: '+1 555 010 0100' }), D('2', 'Alex Example', { email: 'n@example.com' }),
  D('3', 'Twin', { email: 't@example.com' }), D('4', 'Twin', { email: 'u@example.com' }),
]).map((r) => r[2]), ['Same name', 'Same first name, and the details complement each other']);
eq('merge score prefers the fuller record', m.mergeScore(D('1', 'A', { email: 'a@example.com', phone: '1', tags: ['x'] })) > m.mergeScore(D('2', 'A')), true);

// ---- regression: a contact listing one email twice must never be paired with itself (merging would delete it) ----
const twice = m.normalizePerson(m.rowToPerson({ 'First Name': 'Sam', 'E-mail 1 - Value': 'Sam@Example.com', 'E-mail 2 - Value': 'sam@example.com', 'Phone 1 - Value': '+34 600 000 111', 'Phone 2 - Value': '600-000-111' }));
eq('alternates never repeat the primary (case-insensitive)', twice.altEmails, []);
eq('alternate phones never repeat the primary (any format)', twice.altPhones, []);
eq('contactKeys are unique', m.contactKeys(twice).length, new Set(m.contactKeys(twice)).size);
eq('a lone contact has no duplicate candidates', m.findDuplicateCandidates([twice]), []);
const selfAlt = m.normalizePerson({ id: 's1', name: 'Sam', email: 'a@example.com', altEmails: ['a@example.com'], altPhones: [] });
selfAlt.altEmails = ['a@example.com']; // even if an old save left the repeat in place
eq('no self-pair even with a stale repeated alternate', m.findDuplicateCandidates([selfAlt, D('s2', 'Other')]), []);

// ---- sample data for the welcome screen ----
const sample = m.SAMPLE_PEOPLE.map((p) => m.normalizePerson({ ...p }));
eq('sample: has a worldwide spread', sample.length >= 12 && new Set(sample.map((p) => p.country)).size === sample.length, true);
eq('sample: every contact is on the map and precisely sourced', sample.every((p) => Number.isFinite(p.lat) && p.geoSource === 'geocoded'), true);
eq('sample: emails are all on example.com (fictional)', sample.every((p) => /@example\.com$/.test(p.email)), true);
eq('sample: ids are unique and stable', new Set(sample.map((p) => p.id)).size === sample.length && sample[0].id === 'sample-1', true);
eq('sample: tiers are valid', sample.every((p) => [1, 2, 3].includes(p.tier)), true);
eq('sample: not flagged as duplicates of each other', m.findDuplicateCandidates(sample), []);
eq('sample: all tagged Sample so they are easy to select and remove', sample.every((p) => p.tags.includes('Sample')), true);

// ---- three-way merge for cloud sync ----
const P = (id, extra = {}) => m.normalizePerson({ id, name: `Person ${id}`, ...extra });
const names = (r) => r.list.map((p) => p.id).sort();
const find = (r, id) => r.list.find((p) => p.id === id);
const base2 = [P('a', { email: 'a@example.com' }), P('b', { email: 'b@example.com' })];
const copy = (l) => JSON.parse(JSON.stringify(l));

let r = m.threeWayMerge(base2, copy(base2), copy(base2));
eq('merge: nothing changed anywhere', [names(r), r.stats.edited, r.stats.added], [['a', 'b'], 0, 0]);

{ const local = copy(base2); local[0].tier = 3; const remote = copy(base2); remote[0].notes = 'from cloud';
  r = m.threeWayMerge(base2, local, remote);
  eq('merge: different fields of one contact are both kept', [find(r, 'a').tier, find(r, 'a').notes], [3, 'from cloud']); }

{ const local = copy(base2); local[0].tier = 3; const remote = copy(base2); remote[0].tier = 1;
  r = m.threeWayMerge(base2, local, remote);
  eq('merge: same field changed on both sides -> this device wins', find(r, 'a').tier, 3); }

{ const local = copy(base2); local[0].tier = 3; const remote = copy(base2); remote[0].tier = 1; remote[1].tier = 2;
  r = m.threeWayMerge(base2, local, remote);
  eq('merge: untouched-here fields still follow the cloud', find(r, 'b').tier, 2); }

{ const local = [...copy(base2), P('c')]; const remote = [...copy(base2), P('d')];
  r = m.threeWayMerge(base2, local, remote);
  eq('merge: new contacts on both sides are both kept', names(r), ['a', 'b', 'c', 'd']); }

{ const local = [copy(base2)[0]]; const remote = copy(base2);
  r = m.threeWayMerge(base2, local, remote);
  eq('merge: deleted here and untouched in the cloud -> deleted', names(r), ['a']); }
{ const local = [copy(base2)[0]]; const remote = copy(base2); remote[1].notes = 'edited elsewhere';
  r = m.threeWayMerge(base2, local, remote);
  eq('merge: deleted here but edited in the cloud -> kept', names(r), ['a', 'b']); }
{ const local = copy(base2); const remote = [copy(base2)[0]];
  r = m.threeWayMerge(base2, local, remote);
  eq('merge: deleted in the cloud and untouched here -> deleted', names(r), ['a']); }
{ const local = copy(base2); local[1].notes = 'edited here'; const remote = [copy(base2)[0]];
  r = m.threeWayMerge(base2, local, remote);
  eq('merge: deleted in the cloud but edited here -> kept', names(r), ['a', 'b']); }

{ const local = [...copy(base2), P('n1', { email: 'a@example.com', tags: ['x'] })]; const remote = copy(base2);
  r = m.threeWayMerge(base2, local, remote);
  eq('merge: a new local contact matching an existing one is de-duplicated, not doubled', [names(r), find(r, 'a').tags], [['a', 'b'], ['x']]); }

{ const b = [P('a', { lat: 10, lng: 10, geoSource: 'phone' })]; const local = copy(b); local[0].lat = 20; local[0].lng = 30; local[0].geoSource = 'manual';
  const remote = copy(b); remote[0].lat = 99; remote[0].geoSource = 'geocoded';
  r = m.threeWayMerge(b, local, remote);
  eq('merge: a pin moves as one unit (never half one place, half another)', [find(r, 'a').lat, find(r, 'a').lng, find(r, 'a').geoSource], [20, 30, 'manual']); }

{ const local = copy(base2); local[0].tags = ['x', 'y']; const remote = copy(base2); remote[0].tags = ['y', 'z'];
  r = m.threeWayMerge(base2, local, remote);
  eq('merge: tags changed on both sides are combined', find(r, 'a').tags.slice().sort(), ['x', 'y', 'z']); }

{ const local = copy(base2); local[0].tags = ['mine']; const remote = copy(base2);
  r = m.threeWayMerge(base2, local, remote);
  eq('merge: tags changed only here follow this device (so removing a tag sticks)', find(r, 'a').tags, ['mine']); }

{ const local = copy(base2); const remote = copy(base2); const before = JSON.stringify(local);
  m.threeWayMerge(base2, local, remote);
  eq('merge: does not modify its inputs', JSON.stringify(local), before); }

{ const list = [P('a', { email: 'a@example.com' })]; const add = m.mergeInto(list, [P('z', { email: 'A@example.com' }), P('y')]);
  eq('mergeInto: matches by email ignoring case, adds the rest', [add, list.map((p) => p.id)], [{ added: 1, merged: 1 }, ['a', 'y']]); }

console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
