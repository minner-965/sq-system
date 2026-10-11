// 检查百度搜索 Key 和大模型 Key 是否可用：各调用一次。不显示 Key。
// 用法（在 services/demo-dashboard 下）：npm run check:search-llm
import { createBaiduSearchProvider } from '../../src/discovery/providers/baiduSearch.js';
import { createLlmClient } from '../../src/llm/llmClient.js';

let failed = false;
const search = createBaiduSearchProvider({ key: process.env.BAIDU_SEARCH_KEY });
if (!search.configured) { console.log('百度搜索：.env 里没有 BAIDU_SEARCH_KEY'); failed = true; } else {
  try {
    const results = await search.searchWeb({ query: '广州小鹏汽车科技有限公司 招聘', recency: 'year', limit: 3 });
    console.log(`百度搜索正常，返回 ${results.length} 条：`);
    for (const item of results) console.log(`  ${item.date || '无日期'}｜${item.title}｜${item.url}`);
  } catch (error) { console.log(`百度搜索失败：${error.message}`); failed = true; }
}

const llm = createLlmClient();
if (!llm.configured) { console.log('大模型：.env 里没有 DEEPSEEK_API_KEY'); failed = true; } else {
  try {
    const reply = await llm.chat({ messages: [{ role: 'user', content: '用一句话回答：广州市黄埔区属于哪个省？' }], maxTokens: 50 });
    console.log(`大模型正常（${llm.provider} / ${llm.model}）：${reply.text.trim()}`);
    console.log(`  本次用量：输入 ${reply.usage.inputTokens} + 输出 ${reply.usage.outputTokens} 个 token`);
  } catch (error) { console.log(`大模型失败：${error.message}`); failed = true; }
}
process.exit(failed ? 1 : 0);
