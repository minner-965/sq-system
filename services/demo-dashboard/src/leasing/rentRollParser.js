// Reads the leasing team's rent roll worksheet (推租表) into clean property
// records plus a list of every correction made, so the import can be audited.

const CHINESE_DIGITS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

function cellText(cell) {
  let value = cell.value;
  if (value && typeof value === 'object') {
    value = value.richText ? value.richText.map(part => part.text).join('') : value.result ?? value.text ?? '';
  }
  return value == null ? '' : String(value).trim();
}

/** "首层" → 1, "十八层" → 18; null when the label carries no floor number. */
export function parseFloorLabel(label) {
  const text = String(label || '').replace(/层|楼/g, '').trim();
  if (!text) return null;
  if (text === '首') return 1;
  if (/^\d+$/.test(text)) return Number(text);
  const match = text.match(/^([一二三四五六七八九])?(十)?([一二三四五六七八九])?$/);
  if (!match) return null;
  const [, tens, ten, ones] = match;
  if (ten) return (tens ? CHINESE_DIGITS[tens] : 1) * 10 + (ones ? CHINESE_DIGITS[ones] : 0);
  return tens && !ones ? CHINESE_DIGITS[tens] : null;
}

/** 1307 → 13, 506 → 5. */
export function floorFromUnit(unitNo) {
  return /^\d{3,4}$/.test(unitNo) ? Number(unitNo.slice(0, unitNo.length - 2)) : null;
}

const countOf = token => (/^\d+$/.test(token) ? Number(token) : CHINESE_DIGITS[token] ?? null);
const numberAfter = (text, pattern) => {
  const match = text.match(pattern);
  return match ? Number(match[1]) : null;
};

/** Splits the free-text note row into leasing terms and project facts. */
export function parseNotes(text) {
  const source = String(text || '').replace(/\r\n/g, '\n').trim();
  const lines = source.split('\n').map(line => line.trim()).filter(Boolean);
  const line = pattern => lines.map(item => item.match(pattern)).find(Boolean);
  const terms = source.match(/([一二两三\d])押([一二两三\d])付/);
  const years = source.match(/([一二两三\d])年起租/);
  const transportStart = lines.findIndex(item => /^交\s*通\s*[:：]/.test(item));
  return {
    sourceText: source,
    policy: {
      depositMonths: terms ? countOf(terms[1]) : null,
      paymentCycleMonths: terms ? countOf(terms[2]) : null,
      minLeaseYears: years ? countOf(years[1]) : null,
      officeAnnualIncreasePct: numberAfter(source, /写字楼\s*(\d+(?:\.\d+)?)\s*%/),
      retailAnnualIncreasePct: numberAfter(source, /商铺\s*(\d+(?:\.\d+)?)\s*%/)
    },
    project: {
      address: line(/^项目地址[:：]\s*(.+)$/)?.[1] ?? null,
      targetIndustries: (line(/^招商业态[:：]\s*(.+?)(?:等.*)?$/)?.[1] ?? '').split('、').filter(Boolean),
      electricityFeePerKwh: numberAfter(source, /电费[:：]\s*(\d+(?:\.\d+)?)\s*元/),
      waterFeePerTon: numberAfter(source, /水费[:：]\s*(\d+(?:\.\d+)?)\s*元/),
      feesIncludeTax: /含税/.test(source) ? true : null,
      parkingMonthlyFee: numberAfter(source, /月保车位[:：]\s*(\d+(?:\.\d+)?)\s*元/),
      parkingHourlyFee: numberAfter(source, /(\d+(?:\.\d+)?)\s*元\/小时/),
      parkingFreeHours: numberAfter(source, /前\s*(\d+(?:\.\d+)?)\s*小时免费/),
      retailDeliveryStandard: source.match(/交付标准[:：]\s*商铺([^；;\n]+)/)?.[1].trim() ?? null,
      officeDeliveryStandard: source.match(/办公室([^\n]+)/)?.[1].trim().replace(/、可配家具$/, '，可配家具') ?? null,
      transportNotes: transportStart < 0 ? []
        : lines.slice(transportStart).map((item, index) => (index ? item : item.replace(/^交\s*通\s*[:：]\s*/, '')))
    }
  };
}

function findLayout(worksheet) {
  let headerRow = null;
  let notesRow = null;
  worksheet.eachRow((row, number) => {
    if (!headerRow && cellText(row.getCell(3)) === '单元号') headerRow = number;
    if (headerRow && !notesRow && cellText(row.getCell(1)) === '备注') notesRow = number;
  });
  if (!headerRow) throw Object.assign(new Error('没有找到表头行（第三列应为“单元号”）'), { code: 'RENT_ROLL_HEADER_NOT_FOUND' });
  return { headerRow, lastDataRow: (notesRow ?? worksheet.rowCount + 1) - 1, notesRow };
}

/**
 * @returns {{ units: object[], corrections: {row:number, unit:string, field:string, from:string, to:string, reason:string}[],
 *            skipped: {row:number, reason:string}[], notes: object|null, sourceRowCount: number }}
 */
export function parseRentRoll(worksheet) {
  const { headerRow, lastDataRow, notesRow } = findLayout(worksheet);
  const notes = notesRow ? parseNotes(cellText(worksheet.getRow(notesRow).getCell(2))) : null;
  const corrections = [];
  const skipped = [];
  const byKey = new Map();
  let previousBuilding = '';
  let sourceRowCount = 0;

  for (let number = headerRow + 1; number <= lastDataRow; number += 1) {
    const row = worksheet.getRow(number);
    const [rawBuilding, floorLabel, unitNo, rawArea, rawRent, rawFee, rawRemark] =
      [1, 2, 3, 4, 5, 6, 7].map(column => cellText(row.getCell(column)));
    if (!unitNo && !rawArea) {
      if (rawRemark) skipped.push({ row: number, reason: `没有单元号和面积，只有备注“${rawRemark}”，无法确定是哪一套` });
      else skipped.push({ row: number, reason: '空行' });
      if (rawBuilding) previousBuilding = rawBuilding;
      continue;
    }
    sourceRowCount += 1;
    const fix = (field, from, to, reason) => corrections.push({ row: number, unit: unitNo, field, from, to, reason });

    const floor = floorFromUnit(unitNo);
    if (floor == null) {
      skipped.push({ row: number, reason: `单元号“${unitNo}”不是三位或四位数字` });
      sourceRowCount -= 1;
      continue;
    }

    let building = rawBuilding || previousBuilding;
    if (!rawBuilding) fix('楼栋', '（空）', building, '楼栋栏为空，沿用上一行');
    previousBuilding = building;
    const renamed = building.replace(/^(\S+?)号楼$/, '$1栋');
    if (renamed !== building) fix('楼栋', building, renamed, '楼栋叫法统一为“栋”');
    building = renamed;
    if (building === '3栋' && floor >= 2) {
      fix('楼栋', '3栋', '1栋', '3 栋是宜尚酒店，这些写字楼单元实际在 1 栋');
      building = '1栋';
    }

    const labelFloor = parseFloorLabel(floorLabel);
    const remarks = [];
    if (floorLabel && labelFloor == null) remarks.push(`楼层栏原文：${floorLabel}`);
    if (labelFloor !== floor) {
      fix('楼层', floorLabel || '（空）', `${floor}层`, labelFloor == null ? '楼层栏没有层数，按单元号确定' : '楼层栏与单元号不一致，按单元号确定');
    }

    const area = Number.parseFloat(rawArea);
    if (!(area > 0)) {
      skipped.push({ row: number, reason: `单元 ${unitNo} 的面积“${rawArea}”无法识别` });
      sourceRowCount -= 1;
      continue;
    }
    if (String(area) !== rawArea) {
      fix('面积', rawArea, String(area), '面积栏带文字，取数字部分，原文保留在备注');
      remarks.push(`面积原文：${rawArea}`);
    }

    const propertyType = building === '1栋' && floor >= 2 ? 'office' : 'retail';
    const fitOut = rawRemark.match(/(\d+)隔[＋+](\d+)卡/);
    const unit = {
      building,
      floor,
      unitNo,
      propertyType,
      areaSqm: area,
      listRentPerSqm: Number(rawRent),
      managementFeePerSqm: Number(rawFee),
      deliveryStandard: propertyType === 'office' ? notes?.project.officeDeliveryStandard ?? null
        : /精装/.test(rawRemark) ? '精装' : notes?.project.retailDeliveryStandard ?? null,
      fitOut: propertyType === 'office' ? rawRemark || null : null,
      partitionRooms: fitOut ? Number(fitOut[1]) : null,
      workstations: fitOut ? Number(fitOut[2]) : null,
      allowsOpenFlame: /明火/.test(rawRemark) ? true : null,
      allowsCatering: /明火|餐饮/.test(rawRemark) ? true : null,
      hasExhaust: /排烟/.test(rawRemark) ? true : null,
      remark: [...(propertyType === 'retail' && rawRemark ? [rawRemark] : []), ...remarks].join('；') || null,
      sourceRows: [number]
    };

    const key = `${building}|${unitNo}`;
    const first = byKey.get(key);
    if (!first) { byKey.set(key, unit); continue; }
    first.sourceRows.push(number);
    const same = ['areaSqm', 'listRentPerSqm', 'managementFeePerSqm', 'fitOut'].every(field => first[field] === unit[field]);
    fix('重复', `第 ${first.sourceRows[0]} 行已有 ${building} ${unitNo}`, '合并为一套',
      same ? '同楼栋同单元号重复登记，内容一致' : '同楼栋同单元号重复登记，内容不一致，保留先出现的一行');
  }

  return { units: [...byKey.values()], corrections, skipped, notes, sourceRowCount };
}
