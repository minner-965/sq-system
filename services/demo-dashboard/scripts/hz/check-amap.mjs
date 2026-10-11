// 检查高德 Key 是否可用：查一次恒兆广场的坐标，再搜一次周边企业。不显示 Key。
// 用法（在 services/demo-dashboard 下）：npm run check:amap
const key = process.env.AMAP_KEY;
if (!key) { console.error('.env 里没有 AMAP_KEY'); process.exit(1); }

async function call(path, params) {
  const url = new URL(`https://restapi.amap.com${path}`);
  for (const [name, value] of Object.entries({ ...params, key })) url.searchParams.set(name, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  return response.json();
}

const geo = await call('/v3/geocode/geo', { address: '广州市黄埔区福业一街恒兆广场', city: '广州' });
if (geo.status !== '1') { console.error(`高德返回错误：${geo.info}（${geo.infocode}）`); process.exit(1); }
const location = geo.geocodes?.[0]?.location;
console.log(`地址解析正常：${geo.geocodes?.[0]?.formatted_address} → ${location}`);

const around = await call('/v3/place/around', { location, radius: 3000, types: '170000', offset: 5, page: 1 });
if (around.status !== '1') { console.error(`周边搜索返回错误：${around.info}（${around.infocode}）`); process.exit(1); }
console.log(`周边 3 公里内“公司企业”类共 ${around.count} 条，前 ${around.pois.length} 条：`);
for (const poi of around.pois) console.log(`  ${poi.name}｜${poi.type}｜${poi.address}｜${poi.distance} 米`);
