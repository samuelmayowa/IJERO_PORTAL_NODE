import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { replacementMatricNumber } from '../app/services/admissionPlacementService.js';

test('replacement matric keeps the original sequence and changes programme acronym', () => {
  assert.equal(
    replacementMatricNumber({ admissionYear: '2026', acronym: 'CHT', sequenceNumber: 42 }),
    'EKSCOTECH/26/CHT/042',
  );
});

test('replacement matric rejects incomplete allocation data', () => {
  assert.throws(
    () => replacementMatricNumber({ admissionYear: '2026', acronym: '', sequenceNumber: 42 }),
    /cannot be generated/i,
  );
});

test('placement workflow permanently records the old matric as an alias', () => {
  const source = fs.readFileSync(new URL('../app/services/admissionPlacementService.js', import.meta.url), 'utf8');
  assert.match(source, /INSERT INTO matric_number_aliases/);
  assert.match(source, /student_profiles/);
  assert.doesNotMatch(source, /DELETE FROM matric_number_assignments/);
});

test('student biodata reads authoritative academic placement before import fallback', () => {
  const source = fs.readFileSync(new URL('../app/web/controllers/studentProfile.controller.js', import.meta.url), 'utf8');
  assert.match(source, /FROM student_profiles sp/);
  assert.match(source, /LEFT JOIN schools s ON s\.id=sp\.school_id/);
  assert.match(source, /publicUser\.schoolName \|\|=/);
});
