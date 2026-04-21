/**
 * EBO Camp — One-time Excel → Supabase Camper Import
 *
 * Reads ~/Dev/ebo-camp/campers-2026.xlsx and inserts each row into the
 * Supabase `campers` table. Skips rows whose email already exists. No
 * welcome emails — this is a silent bulk backfill.
 *
 * Usage:
 *   1. Create a local `.env` next to this repo root with:
 *        SUPABASE_URL=https://ixmshgnvhbwvtrwxtuna.supabase.co
 *        SUPABASE_ANON_KEY=<anon-key>
 *   2. npm install
 *   3. node scripts/import-existing.js
 */

require('dotenv').config();
const path = require('path');
const XLSX = require('xlsx');

const XLSX_PATH = path.resolve(__dirname, '..', 'campers-2026.xlsx');
const DEFAULT_STATE = 'CO';

// Exact column headers as they appear in row 1 of the Excel file.
const COL = {
  first: 'First Name',
  last: 'Last Name',
  email: 'Email Address',
  phone: 'Cell Phone Number',
  city: 'City',
  level: 'For scheduling purposes please indicate your level of experience. Click all that apply.',
  yrs3: 'Number of  years you have officiated 3 person.',
  yrs2: 'Number of  years you have officiated 2 person.',
  area: 'What Area do you work in?',
  goals: 'What are your goals for attending Elevate Basketball Officiate Camp?',
  tshirt: 'T-shirt Size',
  conflicts: 'If you have any conflicts with scheduling games on Friday night, or all day Saturday or Sunday, please list them below.  We will do our best to schedule games around conflicts you may have.   We expect you to work the games that you are assigned, be ready and on time to officiate, and commit to attend all classroom sessions.',
};

async function main() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_ANON_KEY) {
    console.error('✗ Missing SUPABASE_URL or SUPABASE_ANON_KEY — create a .env at the repo root');
    process.exit(1);
  }

  let wb;
  try {
    wb = XLSX.readFile(XLSX_PATH);
  } catch (e) {
    console.error(`✗ Cannot read ${XLSX_PATH}: ${e.message}`);
    process.exit(1);
  }
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (!rows.length) {
    console.error('✗ No rows found in the first sheet');
    process.exit(1);
  }

  // Sanity-check the expected headers exist (guards against a renamed column)
  const actualHeaders = Object.keys(rows[0]);
  const missing = Object.entries(COL).filter(([, h]) => !actualHeaders.includes(h));
  if (missing.length) {
    console.warn('⚠ Headers not found in sheet (will read as empty):');
    missing.forEach(([k, h]) => console.warn(`   - ${k}: "${h}"`));
  }

  let imported = 0;
  let duplicates = 0;
  let failures = 0;

  for (const row of rows) {
    const first = String(row[COL.first] || '').trim();
    const last = String(row[COL.last] || '').trim();
    const email = String(row[COL.email] || '').trim().toLowerCase();

    if (!email || !first || !last) {
      console.log(`⊘ skipped (missing fields): "${first}" "${last}" "${email}"`);
      failures++;
      continue;
    }

    const existsRes = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/campers?email=eq.${encodeURIComponent(email)}&select=id`,
      { headers: supabaseHeaders() }
    );
    if (!existsRes.ok) {
      console.log(`✗ dupcheck failed for ${email}: ${existsRes.status} ${await existsRes.text()}`);
      failures++;
      continue;
    }
    const existing = await existsRes.json();
    if (Array.isArray(existing) && existing.length > 0) {
      console.log(`⊘ skipped (duplicate): ${email}`);
      duplicates++;
      continue;
    }

    const camper = {
      first_name: first,
      last_name: last,
      email,
      phone: String(row[COL.phone] || '').trim(),
      city: String(row[COL.city] || '').trim(),
      state: DEFAULT_STATE,
      pin: String(Math.floor(1000 + Math.random() * 9000)),
      bio: buildBio({
        level: row[COL.level],
        yrs3: row[COL.yrs3],
        yrs2: row[COL.yrs2],
        area: row[COL.area],
        goals: row[COL.goals],
        tshirt: row[COL.tshirt],
        conflicts: row[COL.conflicts],
      }),
    };

    const insRes = await fetch(`${process.env.SUPABASE_URL}/rest/v1/campers`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify(camper),
    });
    if (!insRes.ok) {
      console.log(`✗ insert failed for ${email}: ${insRes.status} ${await insRes.text()}`);
      failures++;
      continue;
    }

    console.log(`✓ imported: ${first} ${last}`);
    imported++;
  }

  console.log(`\nImported ${imported}, Skipped ${duplicates} duplicates, ${failures} failures`);
}

function supabaseHeaders() {
  return {
    apikey: process.env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
  };
}

function buildBio(f) {
  const lines = [];
  const push = (label, val) => {
    const s = (val == null ? '' : String(val)).trim();
    if (s) lines.push(`${label}: ${s}`);
  };
  push('Experience Level', f.level);
  push('Years 3-person', f.yrs3);
  push('Years 2-person', f.yrs2);
  push('Area', f.area);
  push('Goals', f.goals);
  push('T-shirt Size', f.tshirt);
  push('Scheduling Conflicts', f.conflicts);
  return lines.join('\n');
}

main().catch((e) => {
  console.error('✗ import crashed:', e);
  process.exit(1);
});
