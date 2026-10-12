// 给还没查过（或查了很久）的企业查一批需求依据，不做周边检索。平时每天的自动检索会顺带查，这个脚本用来一次多查一些。
// 用法（在 services/demo-dashboard 下）：npm run signals:check -- 60     （不写数字默认 40 家）
import { createHostPool } from '../../src/db/pool.js';
import { rescoreCompany } from '../../src/discovery/discoveryService.js';
import { createProviders } from '../../src/discovery/providers/index.js';
import { runSignalChecks } from '../../src/discovery/signals.js';
import { createLlmClient } from '../../src/llm/llmClient.js';

const limit = Math.min(Math.max(Number(process.argv[2]) || 40, 1), 200);
const pool = createHostPool();
try {
  const result = await runSignalChecks(pool, { search: createProviders().baiduSearch, llm: createLlmClient(), limit, rescore: rescoreCompany, log: line => console.log(line) });
  console.log(`查了 ${result.checked} 家，找到 ${result.found} 条依据。`);
} finally {
  await pool.end();
}
