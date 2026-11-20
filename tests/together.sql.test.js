// Tests the "Together" SQL (supabase/orbita_together.sql) against a real in-memory Postgres (PGlite), acting as
// several different signed-in users and as a signed-out visitor, including attempts to read or write what they shouldn't.
//
//   npm install --no-save @electric-sql/pglite   (once, anywhere), then:  node tests/together.sql.test.js
//   or point PGLITE_PATH at an existing install: PGLITE_PATH=/path/to/node_modules/@electric-sql/pglite node tests/together.sql.test.js
//
// Synthetic people only. This repo is public.
const fs = require('fs');
const path = require('path');

let PGlite;
try { ({ PGlite } = require(process.env.PGLITE_PATH || '@electric-sql/pglite')); } catch (e) {
  console.log('skipped: PGlite is not installed (see the header of this file). The SQL was NOT tested.');
  process.exit(0);
}

const sqlFile = fs.readFileSync(path.join(__dirname, '..', 'supabase', 'orbita_together.sql'), 'utf8');
let failures = 0;
const ok = (name, cond, extra = '') => { if (cond) console.log(`ok   ${name}`); else { failures++; console.log(`FAIL ${name} ${extra}`); } };

(async () => {
  const db = new PGlite();
  // a minimal stand-in for what Supabase provides: the roles, auth.users, auth.uid()
  await db.exec(`
    create role anon nologin; create role authenticated nologin;
    create schema auth;
    create table auth.users (id uuid primary key default gen_random_uuid(), email text unique, email_confirmed_at timestamptz);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated;
    grant usage on schema public to anon, authenticated;
  `);
  const user = async (email, confirmed = true) => (await db.query('insert into auth.users (email, email_confirmed_at) values ($1, $2) returning id', [email, confirmed ? new Date() : null])).rows[0].id;
  const alice = await user('alice@example.test'); const bob = await user('bob@example.test'); const carol = await user('carol@example.test');
  const mallory = await user('mallory@example.test'); const eve = await user('eve@example.test', false); // eve never confirmed her email

  await db.exec(sqlFile);
  await db.exec(sqlFile); // running it twice must be harmless

  // run `fn` as a user (or as signed-out `anon` when id is null); returns { value } or { error }
  const as = async (id, fn) => {
    await db.exec(id ? `set role authenticated; select set_config('request.jwt.claim.sub', '${id}', false);` : `set role anon; select set_config('request.jwt.claim.sub', '', false);`);
    try { return { value: await fn() }; } catch (e) { return { error: e.message }; } finally { await db.exec('reset role'); }
  };
  const call = (name, ...args) => `select ${name}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`;
  const rpc = async (id, name, ...args) => { const r = await as(id, async () => (await db.query(call(name, ...args), args)).rows[0].r); return r; };
  const rows = async (id, sql, params = []) => as(id, async () => (await db.query(sql, params)).rows);
  const mustFail = (name, r, re) => ok(name, r.error && (!re || re.test(r.error)), `got ${JSON.stringify(r).slice(0, 160)}`);

  // ---------- signed-out visitors get nothing ----------
  mustFail('anon: cannot read circles', await rows(null, 'select * from orbita_circles'), /permission denied/);
  mustFail('anon: cannot read entries', await rows(null, 'select * from orbita_entries'), /permission denied/);
  mustFail('anon: cannot call a function', await rpc(null, 'orbita_my_circles'), /permission denied/);

  // ---------- circles + invites ----------
  const friends = (await rpc(alice, 'orbita_create_circle', 'Friends', 'group', ['bob@example.test', 'CAROL@example.test ', 'not-an-email', 'alice@example.test', 'bob@example.test'])).value;
  ok('create group returns an id', !!friends);
  let mine = (await rpc(alice, 'orbita_my_circles')).value;
  ok('creator is the only member; two clean invites (own email, junk and duplicates dropped)', mine.length === 1 && mine[0].members.length === 1 && JSON.stringify(mine[0].pending.map((x) => x.email)) === JSON.stringify(['bob@example.test', 'carol@example.test']), JSON.stringify(mine));
  mustFail('group needs a name', await rpc(alice, 'orbita_create_circle', '  ', 'group', []), /name/);
  mustFail('cannot create a circle for a different kind', await rpc(alice, 'orbita_create_circle', 'x', 'channel', []), /bad kind/);
  mustFail('signed-in users cannot insert circles directly', await rows(alice, "insert into orbita_circles (name) values ('sneaky')"), /permission denied/);
  mustFail('signed-in users cannot add themselves as a member', await rows(mallory, 'insert into orbita_members (circle_id, user_id) values ($1, $2)', [friends, mallory]), /permission denied/);

  const bobInvites = (await rpc(bob, 'orbita_my_invites')).value;
  ok('bob sees exactly his invitation, with the inviter\'s name', bobInvites.length === 1 && bobInvites[0].name === 'Friends' && bobInvites[0].from === 'alice', JSON.stringify(bobInvites));
  ok('mallory sees no invitations', (await rpc(mallory, 'orbita_my_invites')).value.length === 0);
  mustFail('mallory cannot accept bob\'s invitation', await rpc(mallory, 'orbita_accept_invite', bobInvites[0].id), /no longer available/);
  ok('mallory cannot read invites by table either', (await rows(mallory, 'select * from orbita_invites')).value.length === 0);
  await db.query('update auth.users set email = $1 where id = $2', ['carol@example.test', eve]).catch(() => {}); // eve can't take carol's email (unique)
  const eve2 = await user('carol2@example.test', false);
  ok('unconfirmed email sees no invitations', (await rpc(eve2, 'orbita_my_invites')).value.length === 0);
  mustFail('unconfirmed email cannot create groups', await rpc(eve2, 'orbita_create_circle', 'Hmm', 'group', []), /confirm/);

  ok('non-member cannot read anyone\'s membership rows', (await rows(mallory, 'select * from orbita_members')).value.length === 0);
  ok('non-member cannot read messages by table', (await rows(mallory, 'select * from orbita_messages')).value.length === 0);
  ok('a member sees only the memberships of their own circles', (await rows(alice, 'select * from orbita_members')).value.every((m) => m.circle_id === friends));
  mustFail('non-member cannot read the circle', (await rows(mallory, 'select * from orbita_circles where id = $1', [friends])).value.length ? { value: 1 } : { error: 'hidden' }, /hidden/);
  mustFail('non-member cannot read messages by RPC', await rpc(mallory, 'orbita_messages', friends), /not in that chat/);
  mustFail('non-member cannot send messages', await rpc(mallory, 'orbita_send_message', friends, 'hi'), /not in that chat/);

  const joined = await rpc(bob, 'orbita_accept_invite', bobInvites[0].id);
  ok('bob accepts and joins', joined.value === friends);
  mine = (await rpc(alice, 'orbita_my_circles')).value;
  ok('alice now sees bob as a member and carol pending', mine[0].members.length === 2 && JSON.stringify(mine[0].pending.map((x) => x.email)) === JSON.stringify(['carol@example.test']));
  ok('bob sees alice\'s name through the shared circle', (await rows(bob, 'select display_name from orbita_profiles where user_id = $1', [alice])).value[0]?.display_name === 'alice');
  ok('mallory cannot read anyone\'s profile', (await rows(mallory, 'select * from orbita_profiles')).value.length === 0);

  // ---------- chat ----------
  const sent = await rpc(alice, 'orbita_send_message', friends, '  hello friends  ');
  ok('member can send', !!sent.value?.id);
  mustFail('empty messages are refused', await rpc(alice, 'orbita_send_message', friends, '   '), /1 to 4000/);
  mustFail('over-long messages are refused', await rpc(alice, 'orbita_send_message', friends, 'x'.repeat(4001)), /1 to 4000/);
  let msgs = (await rpc(bob, 'orbita_messages', friends)).value;
  ok('bob reads it, trimmed, marked as not his', msgs.length === 1 && msgs[0].body === 'hello friends' && msgs[0].mine === false && msgs[0].author_name === 'alice');
  ok('bob has 1 unread, alice 0', (await rpc(bob, 'orbita_my_circles')).value[0].unread === 1 && (await rpc(alice, 'orbita_my_circles')).value[0].unread === 0);
  await rpc(bob, 'orbita_mark_read', friends);
  ok('marking read clears it', (await rpc(bob, 'orbita_my_circles')).value[0].unread === 0);
  await rpc(bob, 'orbita_send_message', friends, 'hey!');
  msgs = (await rpc(alice, 'orbita_messages', friends, msgs[0].created_at)).value;
  ok('polling with "after" returns only newer messages', msgs.length === 1 && msgs[0].body === 'hey!');
  ok('carol (invited, not joined) cannot read the chat', (await rpc(carol, 'orbita_messages', friends)).error?.includes('not in that chat'));
  const bobMsgId = msgs[0].id;
  ok('alice cannot delete bob\'s message', (await rows(alice, 'delete from orbita_messages where id = $1 returning id', [bobMsgId])).value.length === 0);
  ok('bob can delete his own message', (await rows(bob, 'delete from orbita_messages where id = $1 returning id', [bobMsgId])).value.length === 1);
  mustFail('nobody can edit messages', await rows(alice, "update orbita_messages set body = 'edited'"), /permission denied/);

  // ---------- journal: private, shared, and bleed-over ----------
  const priv = (await rpc(alice, 'orbita_save_entry', null, 'Just mine', 'Only me, a secret', '2026-10-01', 'Vigo', ['Bob Example', 'bob example', ' '], [])).value;
  ok('private entry saved', !!priv);
  ok('bob cannot see alice\'s private entry (journal)', !(await rpc(bob, 'orbita_journal')).value.some((e) => e.id === priv));
  ok('bob cannot see it by table', (await rows(bob, 'select id from orbita_entries where id = $1', [priv])).value.length === 0);
  ok('mallory cannot see it either', (await rpc(mallory, 'orbita_journal')).value.length === 0);
  ok('people are trimmed and de-duplicated, case-insensitively', (await rpc(alice, 'orbita_journal')).value.find((e) => e.id === priv).people.length === 1);

  const trip = (await rpc(alice, 'orbita_save_entry', null, 'The trip', 'We got lost and it was perfect', '2026-09-12', 'Galicia', ['Bob Example'], [friends])).value;
  ok('bob sees the shared memory in his own journal (bleed-over)', (await rpc(bob, 'orbita_journal')).value.some((e) => e.id === trip && e.author_name === 'alice' && e.mine === false));
  ok('and in the group\'s journal', (await rpc(bob, 'orbita_journal', friends)).value.some((e) => e.id === trip));
  ok('but the group journal does not include the private one', !(await rpc(alice, 'orbita_journal', friends)).value.some((e) => e.id === priv));
  ok('alice\'s own journal has both', (await rpc(alice, 'orbita_journal')).value.length === 2);
  ok('bob can read the shared memory by table, not the private one', (await rows(bob, 'select id from orbita_entries order by created_at')).value.length === 1);
  const bobEntry = (await rpc(bob, 'orbita_save_entry', null, '', 'Bob remembers it differently', '2026-09-12', '', ['Alice'], [friends])).value;
  ok('bob\'s group memory shows up in alice\'s private journal too', (await rpc(alice, 'orbita_journal')).value.some((e) => e.id === bobEntry && e.author_name === 'bob'));
  mustFail('bob cannot edit alice\'s memory', await rpc(bob, 'orbita_save_entry', trip, 't', 'hijacked', '2026-09-12', '', [], [friends]), /your own/);
  ok('bob cannot delete alice\'s memory', (await rows(bob, 'delete from orbita_entries where id = $1 returning id', [trip])).value.length === 0);
  mustFail('cannot share into a group you are not in', await rpc(mallory, 'orbita_save_entry', null, 'x', 'y', '2026-01-01', '', [], [friends]), /groups you are in/);
  mustFail('cannot share into a group you are not in (editing)', await rpc(carol, 'orbita_save_entry', null, 'x', 'y', '2026-01-01', '', [], [friends]), /groups you are in/);
  mustFail('empty memory refused', await rpc(alice, 'orbita_save_entry', null, '', '   ', '2026-01-01', '', [], []), /Write something/);
  ok('person filter finds memories that tag someone (any case)', (await rpc(alice, 'orbita_journal', null, 'BOB example')).value.length === 2);

  // a second group: entries only show the circles the READER is in
  const work = (await rpc(alice, 'orbita_create_circle', 'Work', 'group', ['carol@example.test'])).value;
  const both = (await rpc(alice, 'orbita_save_entry', null, 'Party', 'Both groups were there', '2026-10-10', '', [], [friends, work])).value;
  const bobView = (await rpc(bob, 'orbita_journal')).value.find((e) => e.id === both);
  ok('bob sees only the circle he is in on a memory shared to two', bobView.circles.length === 1 && bobView.circles[0].name === 'Friends', JSON.stringify(bobView?.circles));
  ok('bob cannot read the other circle by table', (await rows(bob, 'select * from orbita_circles')).value.length === 1);
  ok('bob cannot see the sharing rows of circles he is not in', (await rows(bob, 'select circle_id from orbita_entry_circles where entry_id = $1', [both])).value.length === 1);
  await rpc(alice, 'orbita_save_entry', both, 'Party', 'Both groups were there', '2026-10-10', '', [], [work]);
  ok('unsharing hides it from bob again', !(await rpc(bob, 'orbita_journal')).value.some((e) => e.id === both));
  ok('...but alice still has it', (await rpc(alice, 'orbita_journal')).value.some((e) => e.id === both));

  // ---------- inviting more people, direct chats, leaving ----------
  ok('a member can invite more people', (await rpc(bob, 'orbita_invite', friends, ['dave@example.test', 'dave@example.test', 'alice@example.test'])).value === 1);
  mustFail('a non-member cannot invite', await rpc(mallory, 'orbita_invite', friends, ['x@example.test']), /not in that group/);
  const carolInv = (await rpc(carol, 'orbita_my_invites')).value;
  ok('carol has two invitations (Friends and Work)', carolInv.length === 2);
  await rpc(carol, 'orbita_decline_invite', carolInv.find((i) => i.name === 'Friends').id);
  ok('declining removes just that one', (await rpc(carol, 'orbita_my_invites')).value.length === 1);
  const pend = (await rpc(alice, 'orbita_my_circles')).value.find((c) => c.id === friends).pending;
  const daveP = pend.find((x) => x.email === 'dave@example.test');
  await rpc(mallory, 'orbita_cancel_invite', daveP.id);
  ok('an outsider cannot cancel an invitation', (await rpc(alice, 'orbita_my_circles')).value.find((c) => c.id === friends).pending.some((x) => x.email === 'dave@example.test'));
  await rpc(bob, 'orbita_cancel_invite', daveP.id);
  ok('a member can cancel a pending invitation', !(await rpc(alice, 'orbita_my_circles')).value.find((c) => c.id === friends).pending.some((x) => x.email === 'dave@example.test'));
  await rpc(bob, 'orbita_invite', friends, ['dave@example.test']);
  mustFail('only the owner renames', await rpc(bob, 'orbita_rename_circle', friends, 'Mine now'), /runs the group/);
  await rpc(alice, 'orbita_rename_circle', friends, 'Old friends');
  ok('owner can rename', (await rpc(bob, 'orbita_my_circles')).value.some((c) => c.name === 'Old friends'));

  const dm = (await rpc(alice, 'orbita_create_circle', '', 'direct', ['dave@example.test'])).value;
  ok('direct chat created', !!dm);
  ok('asking again for the same person gives the same chat', (await rpc(alice, 'orbita_create_circle', '', 'direct', ['Dave@Example.test'])).value === dm);
  mustFail('a direct chat needs exactly one person', await rpc(alice, 'orbita_create_circle', '', 'direct', ['a@example.test', 'b@example.test']), /exactly one/);
  mustFail('a direct chat cannot take more people', await rpc(alice, 'orbita_invite', dm, ['x@example.test']), /two people/);
  const dave = await user('dave@example.test');
  const daveInv = (await rpc(dave, 'orbita_my_invites')).value;
  ok('dave (signed up later) sees invitations to the direct chat and to Friends', daveInv.length === 2);
  await rpc(dave, 'orbita_accept_invite', daveInv.find((i) => i.kind === 'direct').id);
  ok('after dave joins, asking for the chat again still returns it', (await rpc(alice, 'orbita_create_circle', '', 'direct', ['dave@example.test'])).value === dm);
  await rpc(alice, 'orbita_send_message', dm, 'private hello');
  ok('bob cannot read the direct chat', (await rpc(bob, 'orbita_messages', dm)).error?.includes('not in that chat'));
  ok('dave reads it', (await rpc(dave, 'orbita_messages', dm)).value[0].body === 'private hello');

  await rpc(alice, 'orbita_leave_circle', friends);
  ok('after the owner leaves, someone else runs the group', (await rpc(bob, 'orbita_my_circles')).value.find((c) => c.id === friends).role === 'owner');
  ok('alice can no longer read the group', (await rpc(alice, 'orbita_messages', friends)).error?.includes('not in that chat'));
  ok('memories she shared there stay for the members', (await rpc(bob, 'orbita_journal', friends)).value.some((e) => e.id === trip));
  await rpc(bob, 'orbita_leave_circle', friends);
  ok('when the last member leaves, the group is deleted with its chat', (await db.query('select count(*)::int as n from orbita_circles where id = $1', [friends])).rows[0].n === 0
     && (await db.query('select count(*)::int as n from orbita_messages where circle_id = $1', [friends])).rows[0].n === 0);
  ok('...but alice keeps her own memory', (await rpc(alice, 'orbita_journal')).value.some((e) => e.id === trip));

  // ---------- profile + wipe ----------
  mustFail('display name must be 1 to 60 characters', await rpc(alice, 'orbita_set_display_name', ''), /1 to 60/);
  await rpc(alice, 'orbita_set_display_name', 'Alice A.');
  ok('display name is used in chat', (await rpc(dave, 'orbita_messages', dm)).value[0].author_name === 'Alice A.');
  ok('orbita_me falls back to the email name', (await rpc(carol, 'orbita_me')).value.name === 'carol');
  await rpc(alice, 'orbita_delete_my_together_data');
  const left = (await db.query('select (select count(*)::int from orbita_entries where author_id = $1) as e, (select count(*)::int from orbita_messages where author_id = $1) as m, (select count(*)::int from orbita_members where user_id = $1) as k', [alice])).rows[0];
  ok('"delete my data" removes my memories, messages and memberships', left.e === 0 && left.m === 0 && left.k === 0, JSON.stringify(left));
  ok('the other person in a direct chat is left with an empty, still-working chat', (await rpc(dave, 'orbita_my_circles')).value.some((c) => c.id === dm));

  // ---------- photos ----------
  {
    const jpg = (n = 20) => 'data:image/jpeg;base64,' + 'A'.repeat(n);
    const circle = (await rpc(alice, 'orbita_create_circle', 'Photo club', 'group', ['bob@example.test'])).value;
    const bobPhotoInv = (await rpc(bob, 'orbita_my_invites')).value.find((i) => i.name === 'Photo club');
    await rpc(bob, 'orbita_accept_invite', bobPhotoInv.id);
    const entry = (await rpc(alice, 'orbita_save_entry', null, 'Pics', 'Photos of the day', '2026-10-30', '', [], [])).value;
    const ph = await rpc(alice, 'orbita_add_photo', entry, jpg(10), jpg(50), 800, 600);
    ok('author can add a photo', !!ph.value, JSON.stringify(ph));
    ok('private photos are hidden from everyone else (table)', (await rows(bob, 'select id from orbita_entry_photos')).value.length === 0 && (await rows(mallory, 'select id from orbita_entry_photos')).value.length === 0);
    ok('the author sees their photo, and the journal lists its metadata only', (await rows(alice, 'select id from orbita_entry_photos')).value.length === 1
      && JSON.stringify((await rpc(alice, 'orbita_journal')).value.find((e) => e.id === entry).photos.map((x) => [x.w, x.h])) === '[[800,600]]');
    await rpc(alice, 'orbita_save_entry', entry, 'Pics', 'Photos of the day', '2026-10-30', '', [], [circle]);
    ok('once shared, a group member can see the photo', (await rows(bob, 'select id from orbita_entry_photos')).value.length === 1
      && (await rpc(bob, 'orbita_journal')).value.find((e) => e.id === entry).photos.length === 1);
    ok('a non-member still cannot', (await rows(mallory, 'select id from orbita_entry_photos')).value.length === 0);
    mustFail('a group member cannot add photos to someone else\'s memory', await rpc(bob, 'orbita_add_photo', entry, jpg(), jpg(), 10, 10), /your own/);
    await rpc(bob, 'orbita_delete_photo', ph.value);
    ok('a group member cannot delete someone else\'s photo', (await rows(alice, 'select id from orbita_entry_photos')).value.length === 1);
    mustFail('only JPEG data is accepted (png refused)', await rpc(alice, 'orbita_add_photo', entry, 'data:image/png;base64,AAAA', jpg(), 10, 10), /check constraint|jpeg/i);
    mustFail('data must be base64 (script refused)', await rpc(alice, 'orbita_add_photo', entry, jpg(), 'data:image/jpeg;base64,<script>alert(1)</script>', 10, 10), /check constraint|jpeg/i);
    mustFail('oversized thumbnails are refused', await rpc(alice, 'orbita_add_photo', entry, jpg(90000), jpg(), 10, 10), /check constraint|size/i);
    mustFail('oversized photos are refused', await rpc(alice, 'orbita_add_photo', entry, jpg(), jpg(1300000), 10, 10), /check constraint|size/i);
    mustFail('absurd dimensions are refused', await rpc(alice, 'orbita_add_photo', entry, jpg(), jpg(), 0, 10), /odd size/);
    mustFail('signed-out visitors cannot add photos', await rpc(null, 'orbita_add_photo', entry, jpg(), jpg(), 10, 10), /permission denied/);
    for (let i = 0; i < 5; i++) await rpc(alice, 'orbita_add_photo', entry, jpg(), jpg(), 10, 10);
    mustFail('at most 6 photos per memory', await rpc(alice, 'orbita_add_photo', entry, jpg(), jpg(), 10, 10), /up to 6/);
    // storage quota: shrink it for the test, then put it back
    await db.exec('create or replace function public.orbita_photo_quota() returns bigint language sql immutable as $$ select 400::bigint $$');
    const entry2 = (await rpc(alice, 'orbita_save_entry', null, '', 'Second memory', '2026-10-31', '', [], [])).value;
    mustFail('the per-person photo quota is enforced', await rpc(alice, 'orbita_add_photo', entry2, jpg(10), jpg(50), 10, 10), /storage is full/);
    await db.exec(sqlFile.slice(sqlFile.indexOf('create or replace function public.orbita_photo_quota()'), sqlFile.indexOf('create or replace function public.orbita_add_photo(')));
    ok('author can delete their own photo', ((await rpc(alice, 'orbita_delete_photo', ph.value)), (await rows(alice, 'select id from orbita_entry_photos where id = $1', [ph.value])).value.length === 0));
    await rpc(alice, 'orbita_delete_my_together_data');
    ok('"delete my data" also removes photos', (await db.query('select count(*)::int as n from orbita_entry_photos')).rows[0].n === 0);
    mustFail('signed-out visitors cannot read photos', await rows(null, 'select * from orbita_entry_photos'), /permission denied/);
  }

  console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
