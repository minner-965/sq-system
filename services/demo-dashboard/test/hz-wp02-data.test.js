import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import express from 'express';
import { createManagementAuth } from '../src/auth/managementAuth.js';
import { defaultMigrationsDir, listMigrationFiles, migrationChecksum } from '../src/db/migrator.js';
import { createLeasingRouter } from '../src/leasing/leasingRoutes.js';
import { floorFromUnit, parseFloorLabel, parseNotes, parseRentRoll } from '../src/leasing/rentRollParser.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const NOTES = `项目地址：广州市黄埔区示例街 1 号
招商业态：商铺、轻餐饮、教育等多种业态
一、出租条件说明：
1、签约条件：两押一付；两年起租
2、递增率：年递增写字楼3%；商铺5%
3、其他费用：电费：1.04元/度、水费：6元/吨；含税
月保车位：250元/月，4元/小时，前2小时免费
二、交付标准：商铺毛坯交付；办公室铺地毯、空调、可配家具

交 通: 地铁站1公里
轻轨站400米`;

// Synthetic sheet reproducing each irregularity of the real rent roll.
function rentRollSheet() {
  const sheet = new ExcelJS.Workbook().addWorksheet('Sheet1');
  sheet.addRows([
    ['精装修1隔＋6卡'],
    ['示例广场'],
    ['楼层', null, '单元号', '出租面积（㎡）', '租金', '管理费', '备注'],
    ['B栋', '招商中心', 101, 380, 60, 15, '层高10米'],
    [null, '首层', 105, 121, 60, 10, '可明火/精装'],
    ['1号楼', '首层', 110, 57, 60, 10, '可明火'],
    ['3号楼', '首层', 101, 868, 35, 10, '可分割'],
    ['1栋', '二层', 1420, 70, 30, 10, '精装修1隔＋6卡'],
    ['1栋', '二层', null, null, 30, 10, '精装修1隔＋6卡'],
    ['1栋', '二层', null, null, 30, 10, null],
    ['1栋', '十四层', 1420, 70, 30, 10, '精装修1隔＋6卡'],
    ['1栋', '十二层', 1221, '55暗', 30, 10, '精装修1隔＋6卡'],
    ['3栋', '十一层', 1307, 193, 30, 10, '精装修3隔＋15卡'],
    ['备注', NOTES]
  ]);
  return sheet;
}

test('floors come from the unit number, not the merged floor column', () => {
  assert.equal(floorFromUnit('1307'), 13);
  assert.equal(floorFromUnit('506'), 5);
  assert.equal(floorFromUnit('A1'), null);
  assert.deepEqual(['首层', '二层', '十层', '十一层', '十八层', '二十一层', '招商中心', ''].map(parseFloorLabel),
    [1, 2, 10, 11, 18, 21, null, null]);
});

test('rent roll rows are cleaned, classified and de-duplicated', () => {
  const { units, corrections, skipped, sourceRowCount } = parseRentRoll(rentRollSheet());
  assert.equal(sourceRowCount, 8);
  assert.deepEqual(units.map(unit => `${unit.building} ${unit.unitNo} ${unit.propertyType} ${unit.floor}`), [
    'B栋 101 retail 1', 'B栋 105 retail 1', '1栋 110 retail 1', '3栋 101 retail 1',
    '1栋 1420 office 14', '1栋 1221 office 12', '1栋 1307 office 13'
  ]);
  const unit = key => units.find(item => `${item.building} ${item.unitNo}` === key);

  assert.deepEqual(unit('1栋 1420').sourceRows, [8, 11]);
  assert.equal(unit('1栋 1221').areaSqm, 55);
  assert.equal(unit('1栋 1221').remark, '面积原文：55暗');
  assert.deepEqual([unit('1栋 1307').partitionRooms, unit('1栋 1307').workstations], [3, 15]);
  assert.equal(unit('1栋 1307').fitOut, '精装修3隔＋15卡');
  assert.equal(unit('1栋 1307').deliveryStandard, '铺地毯、空调，可配家具');
  assert.equal(unit('1栋 1307').allowsOpenFlame, null);
  assert.equal(unit('B栋 105').allowsOpenFlame, true);
  assert.equal(unit('B栋 105').deliveryStandard, '精装');
  assert.equal(unit('1栋 110').deliveryStandard, '毛坯交付');
  assert.equal(unit('B栋 101').remark, '层高10米；楼层栏原文：招商中心');

  const reasons = field => corrections.filter(item => item.field === field).map(item => `${item.row}:${item.from}→${item.to}`);
  assert.deepEqual(reasons('楼栋'), ['5:（空）→B栋', '6:1号楼→1栋', '7:3号楼→3栋', '13:3栋→1栋']);
  assert.deepEqual(reasons('面积'), ['12:55暗→55']);
  assert.equal(reasons('重复').length, 1);
  assert.deepEqual(skipped.map(item => item.row), [9, 10]);
  assert.match(skipped[0].reason, /没有单元号和面积/);
  assert.equal(skipped[1].reason, '空行');
});

test('note row is split into leasing terms and project facts', () => {
  const { policy, project } = parseNotes(NOTES);
  assert.deepEqual(policy, {
    depositMonths: 2, paymentCycleMonths: 1, minLeaseYears: 2, officeAnnualIncreasePct: 3, retailAnnualIncreasePct: 5
  });
  assert.equal(project.address, '广州市黄埔区示例街 1 号');
  assert.deepEqual(project.targetIndustries, ['商铺', '轻餐饮', '教育']);
  assert.deepEqual([project.electricityFeePerKwh, project.waterFeePerTon, project.feesIncludeTax], [1.04, 6, true]);
  assert.deepEqual([project.parkingMonthlyFee, project.parkingHourlyFee, project.parkingFreeHours], [250, 4, 2]);
  assert.deepEqual(project.transportNotes, ['地铁站1公里', '轻轨站400米']);
});

test('migration files run in numeric order with unique numbers', () => {
  const files = listMigrationFiles(defaultMigrationsDir({ DPV_PROJECT_ROOT: projectRoot }));
  assert.deepEqual(files, [...files].sort());
  assert.equal(files[0], '001_initial_schema.sql');
  assert.deepEqual(files.map(name => Number(name.slice(0, 3))), files.map((_name, index) => index + 1));

  const dir = mkdtempSync(path.join(tmpdir(), 'hz-migrations-'));
  for (const name of ['001_a.sql', '002_b.sql', '002_c.sql', 'notes.txt']) writeFileSync(path.join(dir, name), 'SELECT 1;');
  assert.throws(() => listMigrationFiles(dir), /Duplicate migration number 002/);
});

test('migration checksum does not depend on line endings', () => {
  assert.equal(migrationChecksum('SELECT 1;\r\nSELECT 2;\r\n'), migrationChecksum('SELECT 1;\nSELECT 2;\n'));
  assert.notEqual(migrationChecksum('SELECT 1;'), migrationChecksum('SELECT 2;'));
});

test('compose no longer applies migrations through the postgres first-boot hook', () => {
  assert.doesNotMatch(readFileSync(path.join(projectRoot, 'compose.yaml'), 'utf8'), /docker-entrypoint-initdb\.d/);
});

// Answers like PostgreSQL would: a column is only returned when it is selected.
const policyPool = {
  queries: [],
  async query(sql) {
    this.queries.push(sql);
    const row = { property_type: 'office', list_rent_per_sqm: '30.00', min_lease_years: 2 };
    return { rows: [/floor_price/.test(sql) ? { ...row, floor_price_per_sqm: '35.00' } : row] };
  }
};

async function getPolicy(role) {
  const app = express();
  app.use('/api', createLeasingRouter({ pool: policyPool, auth: createManagementAuth({ DPV_WORKSPACE_ROLE: role }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/leasing-policy`);
    return { status: response.status, text: await response.text() };
  } finally {
    server.close();
  }
}

test('floor price is returned to administrators only', async () => {
  const admin = await getPolicy('ADMIN');
  assert.equal(JSON.parse(admin.text).items[0].floor_price_per_sqm, '35.00');

  for (const role of ['BOSS', 'LEASING', 'OPERATIONS', 'SALES', 'not-a-role']) {
    policyPool.queries.length = 0;
    const result = await getPolicy(role);
    assert.equal(result.status, 200, role);
    assert.doesNotMatch(result.text, /floor_price|35\.00/, role);
    assert.doesNotMatch(policyPool.queries.join('\n'), /floor_price/, role);
  }
  assert.equal((await getPolicy('FINANCE')).status, 403);
});

test('floor price column is read in exactly one place', () => {
  const src = path.join(projectRoot, 'services', 'demo-dashboard', 'src');
  const routes = readFileSync(path.join(src, 'leasing', 'leasingRoutes.js'), 'utf8');
  assert.equal(routes.match(/floor_price_per_sqm/g).length, 1);
  assert.match(routes, /canSeeFloorPrice\(user\) \? /);
  assert.doesNotMatch(readFileSync(path.join(src, 'server.js'), 'utf8'), /floor_price|SELECT \*/);
});
