// 数据库迁移：按编号顺序执行 database/migrations 里还没执行过的文件。
// 用法（在 services/demo-dashboard 下）：
//   npm run migrate            执行
//   npm run migrate -- --dry   只列出待执行的文件
// 在容器内运行时连接 postgres 服务；在本机运行时加 --host，走 127.0.0.1 的映射端口。
import pg from 'pg';
import { poolConfig, createHostPool } from '../src/db/pool.js';
import { runMigrations } from '../src/db/migrator.js';

const args = new Set(process.argv.slice(2));
const pool = args.has('--host') ? createHostPool() : new pg.Pool(poolConfig());
try {
  const result = await runMigrations({ pool, dryRun: args.has('--dry'), log: line => console.log(line) });
  if (args.has('--dry')) console.log(result.pending.length ? `待执行：\n${result.pending.join('\n')}` : '没有待执行的迁移');
  else console.log(`迁移文件 ${result.total} 个，本次执行 ${result.applied.length} 个`);
} finally {
  await pool.end();
}
