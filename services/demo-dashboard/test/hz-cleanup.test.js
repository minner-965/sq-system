import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PHASE5_QUEUE_NAMES } from '../src/jobs/phase5Queue.js';
import { normalizePhone } from '../src/contact/phoneUtils.js';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(appRoot, '..', '..');
const walk = dir => readdirSync(dir).flatMap(name => {
  const full = path.join(dir, name);
  return statSync(full).isDirectory() ? walk(full) : [full];
});

// exportPolicy.js still carries the old outreach export labels; it is rewritten with the reports in WP09.
const KNOWN_LEFTOVERS = ['src/dataExchange/exportPolicy.js'];

test('application code no longer references removed overseas services', () => {
  const pattern = /hunter|tavily|exa_|okki|smtp|imap|gmail|dataforseo|brave/i;
  const offenders = [...walk(path.join(appRoot, 'src')), ...walk(path.join(appRoot, 'public'))]
    .filter(file => pattern.test(readFileSync(file, 'utf8')))
    .map(file => path.relative(appRoot, file).replaceAll(path.sep, '/'));
  assert.deepEqual(offenders, KNOWN_LEFTOVERS);
});

test('every relative import in src resolves to an existing file', () => {
  for (const file of walk(path.join(appRoot, 'src')).filter(name => name.endsWith('.js'))) {
    for (const match of readFileSync(file, 'utf8').matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const target = path.resolve(path.dirname(file), match[1]);
      assert.ok(statSync(target, { throwIfNoEntry: false })?.isFile(), `${path.relative(appRoot, file)} -> ${match[1]}`);
    }
  }
});

test('job queues are limited to scoring, export and company discovery', () => {
  assert.deepEqual([...PHASE5_QUEUE_NAMES].sort(),
    ['discover-companies', 'export-business-data', 'replay-rule-version', 'score-all-eligible', 'score-company']);
});

test('mainland phone numbers normalize in both local and international form', () => {
  assert.equal(normalizePhone('+86 20 8200 0000'), '+862082000000');
  assert.equal(normalizePhone('138 0013 8000'), '13800138000');
});

test('landing page is Chinese-only and loads no external resources', () => {
  const html = readFileSync(path.join(appRoot, 'public', 'index.html'), 'utf8');
  assert.match(html, /<html lang="zh-CN">/);
  assert.doesNotMatch(html, /https?:\/\//);
  assert.doesNotMatch(html, /DPV|Overseas|Outreach|Dashboard/i);
});

test('compose defines only postgres, app and worker', () => {
  const compose = readFileSync(path.join(projectRoot, 'compose.yaml'), 'utf8');
  const services = [...compose.split(/^volumes:/m)[0].matchAll(/^  ([a-z0-9-]+):\s*$/gm)].map(match => match[1]);
  assert.deepEqual(services, ['postgres', 'app', 'worker']);
});

test('overseas tables are removed by a new migration, not by editing history', () => {
  const files = readdirSync(path.join(projectRoot, 'database', 'migrations')).sort();
  assert.equal(files.filter(name => /^0(0[1-9]|[1-5]\d|6[0-3])_/.test(name)).length, 63);
  const drop = readFileSync(path.join(projectRoot, 'database', 'migrations', '064_hz_drop_overseas_business_tables.sql'), 'utf8');
  assert.match(drop, /DROP TABLE IF EXISTS leadgen\.%I CASCADE/);
  for (const kept of ['companies', 'automation_controls', 'provider_usage_events', 'data_cleanup_batches']) {
    assert.doesNotMatch(drop, new RegExp(`'${kept}'`));
  }
});
