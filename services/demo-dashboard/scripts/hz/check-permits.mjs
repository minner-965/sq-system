// 把政府公示里新办许可的商家定位到地图上，在检索范围内的收进企业发现并记下依据。平时每天的自动检索会顺带做。
// 用法（在 services/demo-dashboard 下）：npm run permits:match -- 25     （不写数字默认 15 条）
import { createHostPool } from '../../src/db/pool.js';
import { getSettings, isInsideProject, rescoreCompany, saveCompany } from '../../src/discovery/discoveryService.js';
import { attachPermitSignals } from '../../src/discovery/permits.js';
import { createProviders } from '../../src/discovery/providers/index.js';

const limit = Math.min(Math.max(Number(process.argv[2]) || 15, 1), 100);
const pool = createHostPool();
try {
  const settings = await getSettings(pool);
  const result = await attachPermitSignals(pool, {
    provider: createProviders().amap, settings, saveCompany, rescore: rescoreCompany,
    isExcluded: company => isInsideProject(company, settings), limit, log: line => console.log(line)
  });
  console.log(`看了 ${result.checked} 条，对上 ${result.matched} 家。`);
} finally {
  await pool.end();
}
