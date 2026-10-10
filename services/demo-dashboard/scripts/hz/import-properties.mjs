// 房源导入：读推租表 → 清洗 → 写入房源、招商政策、项目信息；拆平面图；输出导入报告。
// 可重复运行，结果不变。训练数据目录只读，不改原文件。
// 用法（在 services/demo-dashboard 下，数据库已启动并完成迁移）：
//   npm run import:properties
import ExcelJS from 'exceljs';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHostPool } from '../../src/db/pool.js';
import { parseRentRoll } from '../../src/leasing/rentRollParser.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
const sourceDir = process.env.HZ_TRAINING_DATA_DIR || path.resolve(projectRoot, '..', '训练数据');
const rentRollFile = path.join(sourceDir, '写字楼商铺', '恒兆广场推租表08.15.xlsx');
const floorPlanFile = path.join(sourceDir, '写字楼商铺', '13、14、15.pdf');
const mediaDir = process.env.HZ_MEDIA_DIR || path.join(projectRoot, 'data', 'media');
const reportFile = path.join(projectRoot, 'docs', 'hz', '房源导入报告.md');
// 平面图 PDF 的三页依次是 1 栋 13、14、15 层（页内单元号为 13xx、14xx、15xx）。
const FLOOR_PLAN_PAGES = [{ building: '1栋', floor: 13 }, { building: '1栋', floor: 14 }, { building: '1栋', floor: 15 }];

const TYPE_NAME = { office: '写字楼', retail: '商铺' };

async function renderFloorPlans() {
  const { pdf } = await import('pdf-to-img');
  const outDir = path.join(mediaDir, 'floorplans');
  mkdirSync(outDir, { recursive: true });
  const document = await pdf(readFileSync(floorPlanFile), { scale: 2 });
  if (document.length !== FLOOR_PLAN_PAGES.length) {
    throw new Error(`平面图应为 ${FLOOR_PLAN_PAGES.length} 页，实际 ${document.length} 页`);
  }
  const plans = [];
  let index = 0;
  for await (const image of document) {
    const page = FLOOR_PLAN_PAGES[index];
    const relative = `floorplans/b${Number.parseInt(page.building, 10)}-f${page.floor}.png`;
    writeFileSync(path.join(mediaDir, relative), image);
    plans.push({ ...page, file: relative, page: index + 1 });
    index += 1;
  }
  return plans;
}

async function save(pool, { units, notes }, plans) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const planFor = unit => plans.find(plan => plan.building === unit.building && plan.floor === unit.floor)?.file ?? null;
    let inserted = 0;
    let updated = 0;
    for (const unit of units) {
      // status 由招商跟进维护，重复导入时不覆盖。
      const { rows: [row] } = await client.query(`
        INSERT INTO leadgen.properties
          (building, floor, unit_no, property_type, area_sqm, list_rent_per_sqm, management_fee_per_sqm,
           delivery_standard, fit_out, partition_rooms, workstations, allows_open_flame, allows_catering, has_exhaust,
           floor_plan_file, remark, source_file, source_rows)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        ON CONFLICT (building, unit_no) DO UPDATE SET
          floor = EXCLUDED.floor, property_type = EXCLUDED.property_type, area_sqm = EXCLUDED.area_sqm,
          list_rent_per_sqm = EXCLUDED.list_rent_per_sqm, management_fee_per_sqm = EXCLUDED.management_fee_per_sqm,
          delivery_standard = EXCLUDED.delivery_standard, fit_out = EXCLUDED.fit_out,
          partition_rooms = EXCLUDED.partition_rooms, workstations = EXCLUDED.workstations,
          allows_open_flame = EXCLUDED.allows_open_flame, allows_catering = EXCLUDED.allows_catering,
          has_exhaust = EXCLUDED.has_exhaust, floor_plan_file = EXCLUDED.floor_plan_file, remark = EXCLUDED.remark,
          source_file = EXCLUDED.source_file, source_rows = EXCLUDED.source_rows, updated_at = now()
        WHERE (properties.floor, properties.property_type, properties.area_sqm, properties.list_rent_per_sqm,
               properties.management_fee_per_sqm, properties.delivery_standard, properties.fit_out,
               properties.partition_rooms, properties.workstations, properties.allows_open_flame,
               properties.allows_catering, properties.has_exhaust, properties.floor_plan_file, properties.remark,
               properties.source_file, properties.source_rows)
          IS DISTINCT FROM
              (EXCLUDED.floor, EXCLUDED.property_type, EXCLUDED.area_sqm, EXCLUDED.list_rent_per_sqm,
               EXCLUDED.management_fee_per_sqm, EXCLUDED.delivery_standard, EXCLUDED.fit_out,
               EXCLUDED.partition_rooms, EXCLUDED.workstations, EXCLUDED.allows_open_flame,
               EXCLUDED.allows_catering, EXCLUDED.has_exhaust, EXCLUDED.floor_plan_file, EXCLUDED.remark,
               EXCLUDED.source_file, EXCLUDED.source_rows)
        RETURNING (xmax = 0) AS inserted`,
      [unit.building, unit.floor, unit.unitNo, unit.propertyType, unit.areaSqm, unit.listRentPerSqm,
        unit.managementFeePerSqm, unit.deliveryStandard, unit.fitOut, unit.partitionRooms, unit.workstations,
        unit.allowsOpenFlame, unit.allowsCatering, unit.hasExhaust, planFor(unit), unit.remark,
        path.basename(rentRollFile), unit.sourceRows]);
      if (row?.inserted) inserted += 1; else if (row) updated += 1;
    }

    if (notes) {
      const { policy, project } = notes;
      // 底价和免租期不在推租表里，这里不动。
      for (const [type, increase] of [['office', policy.officeAnnualIncreasePct], ['retail', policy.retailAnnualIncreasePct]]) {
        await client.query(`
          UPDATE leadgen.leasing_policy SET
            min_lease_years = COALESCE($2, min_lease_years), deposit_months = COALESCE($3, deposit_months),
            payment_cycle_months = COALESCE($4, payment_cycle_months), annual_increase_pct = COALESCE($5, annual_increase_pct),
            updated_at = now()
          WHERE property_type = $1
            AND (min_lease_years, deposit_months, payment_cycle_months, annual_increase_pct) IS DISTINCT FROM
                (COALESCE($2, min_lease_years), COALESCE($3, deposit_months), COALESCE($4, payment_cycle_months),
                 COALESCE($5::numeric, annual_increase_pct))`,
        [type, policy.minLeaseYears, policy.depositMonths, policy.paymentCycleMonths, increase]);
      }
      await client.query(`
        UPDATE leadgen.project_profile SET
          address = $1, target_industries = $2, electricity_fee_per_kwh = $3, water_fee_per_ton = $4,
          fees_include_tax = $5, parking_monthly_fee = $6, parking_hourly_fee = $7, parking_free_hours = $8,
          retail_delivery_standard = $9, office_delivery_standard = $10, transport_notes = $11, source_text = $12,
          updated_at = now()
        WHERE id = 1 AND source_text IS DISTINCT FROM $12`,
      [project.address, project.targetIndustries, project.electricityFeePerKwh, project.waterFeePerTon,
        project.feesIncludeTax, project.parkingMonthlyFee, project.parkingHourlyFee, project.parkingFreeHours,
        project.retailDeliveryStandard, project.officeDeliveryStandard, project.transportNotes, notes.sourceText]);
    }
    await client.query('COMMIT');
    return { inserted, updated };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function buildReport({ units, corrections, skipped, notes, sourceRowCount }, plans) {
  const count = type => units.filter(unit => unit.propertyType === type).length;
  const area = type => units.filter(unit => unit.propertyType === type).reduce((sum, unit) => sum + unit.areaSqm, 0);
  const modified = statSync(rentRollFile).mtime.toISOString().slice(0, 10);
  const byField = field => corrections.filter(item => item.field === field);
  const table = (rows, columns) => [
    `| ${columns.map(column => column[0]).join(' | ')} |`,
    `|${columns.map(() => '---').join('|')}|`,
    ...rows.map(row => `| ${columns.map(column => String(column[1](row) ?? '')).join(' | ')} |`)
  ].join('\n');
  const correctionTable = rows => table(rows, [
    ['表内行号', row => row.row], ['单元号', row => row.unit], ['原文', row => row.from], ['改为', row => row.to], ['原因', row => row.reason]
  ]);
  const planned = units.filter(unit => plans.some(plan => plan.building === unit.building && plan.floor === unit.floor));
  const pendingRows = skipped.filter(item => item.reason !== '空行').map(item => item.row);
  const policy = notes?.policy;
  const project = notes?.project;

  return `# 房源导入报告

来源：\`${path.basename(rentRollFile)}\`（文件日期 ${modified}）。本报告由导入脚本生成，重复运行内容不变；原文件没有改动。

## 结果

- 表内有单元号的房源行 ${sourceRowCount} 行，合并重复后入库 **${units.length} 套**：商铺 ${count('retail')} 套（${area('retail')} ㎡），写字楼 ${count('office')} 套（${area('office')} ㎡）。
- 全部按“在租”入库。
- 未入库 ${skipped.length} 行，见“未入库的行”。${pendingRows.length ? `其中第 ${pendingRows.join('、')} 行有内容但缺单元号或面积，补全后重新导入即可入库。` : ''}

## 分类口径

- 1 栋 2 层及以上为写字楼，其余为商铺。
- 楼层一律按单元号确定：三位数取第一位，四位数取前两位（1307 → 13 层）。
- 备注写“可明火”的，同时记为可做餐饮；排烟条件表里没有写，留空。
- 写字楼的备注是装修配置（如“精装修3隔＋15卡”），原文保留，隔间数和卡位数另外拆出。
- 交付标准取自表尾备注：商铺${project?.retailDeliveryStandard ?? '—'}（备注写“精装”的按精装）；写字楼${project?.officeDeliveryStandard ?? '—'}。

## 修正明细

### 楼栋（${byField('楼栋').length} 处）

${correctionTable(byField('楼栋'))}

### 楼层（${byField('楼层').length} 处）

楼层栏是合并单元格，位置已经错乱，全部以单元号为准。

${correctionTable(byField('楼层'))}

### 面积（${byField('面积').length} 处）

${correctionTable(byField('面积'))}

### 重复房源（${byField('重复').length} 处）

${correctionTable(byField('重复'))}

## 未入库的行

${table(skipped, [['表内行号', row => row.row], ['原因', row => row.reason]])}

## 表尾备注的拆分

招商政策：

${table([
    ['签约条件', `押${policy?.depositMonths}付${policy?.paymentCycleMonths}，${policy?.minLeaseYears} 年起租`],
    ['年递增', `写字楼 ${policy?.officeAnnualIncreasePct}%，商铺 ${policy?.retailAnnualIncreasePct}%`]
  ], [['项目', row => row[0]], ['内容', row => row[1]]])}

底价和免租期不在推租表里，来自《首期基础数据需求清单》和已确认的招商规则，由数据库迁移写入，导入时不改。

项目信息：

${table([
    ['地址', project?.address],
    ['招商业态', project?.targetIndustries.join('、')],
    ['电费', `${project?.electricityFeePerKwh} 元/度`],
    ['水费', `${project?.waterFeePerTon} 元/吨`],
    ['是否含税', project?.feesIncludeTax ? '含税' : '未写明'],
    ['车位', `月保 ${project?.parkingMonthlyFee} 元/月；临停 ${project?.parkingHourlyFee} 元/小时，前 ${project?.parkingFreeHours} 小时免费`],
    ['交通', project?.transportNotes.join('；')]
  ], [['项目', row => row[0]], ['内容', row => row[1]]])}

## 平面图

\`${path.basename(floorPlanFile)}\` 共 ${plans.length} 页，拆成图片后挂到对应楼层的 ${planned.length} 套房源。图片放在 \`data/media/floorplans/\`，不进 Git，重新运行导入即可生成。

${table(plans, [
    ['页', plan => plan.page], ['楼层', plan => `${plan.building} ${plan.floor} 层`], ['图片', plan => plan.file],
    ['挂接房源', plan => units.filter(unit => unit.building === plan.building && unit.floor === plan.floor).map(unit => unit.unitNo).join('、')]
  ])}

## 全部房源

${table([...units].sort((a, b) => a.propertyType.localeCompare(b.propertyType) * -1 || a.building.localeCompare(b.building, 'zh') || a.floor - b.floor || a.unitNo.localeCompare(b.unitNo)), [
    ['类型', unit => TYPE_NAME[unit.propertyType]], ['楼栋', unit => unit.building], ['楼层', unit => unit.floor], ['单元号', unit => unit.unitNo],
    ['面积（㎡）', unit => unit.areaSqm], ['租金', unit => unit.listRentPerSqm], ['管理费', unit => unit.managementFeePerSqm],
    ['配置', unit => unit.fitOut], ['可明火', unit => (unit.allowsOpenFlame ? '是' : '')], ['备注', unit => unit.remark],
    ['表内行号', unit => unit.sourceRows.join('、')]
  ])}
`;
}

const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile(rentRollFile);
const parsed = parseRentRoll(workbook.worksheets[0]);
const plans = await renderFloorPlans();
const pool = createHostPool();
try {
  const result = await save(pool, parsed, plans);
  writeFileSync(reportFile, buildReport(parsed, plans));
  const { rows } = await pool.query(`SELECT property_type, count(*)::int AS n FROM leadgen.properties GROUP BY 1 ORDER BY 1`);
  console.log(`新增 ${result.inserted} 套，更新 ${result.updated} 套；库内现有 ${rows.map(row => `${TYPE_NAME[row.property_type]} ${row.n} 套`).join('，')}`);
  console.log(`导入报告：${path.relative(projectRoot, reportFile)}`);
} finally {
  await pool.end();
}
