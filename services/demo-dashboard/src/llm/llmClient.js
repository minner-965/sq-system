// 大模型统一入口。国产服务都兼容 OpenAI 的 chat/completions 接口，所以只需要地址、Key、模型名三项。
// 默认用 DeepSeek；换服务商时在 .env 里改 LLM_BASE_URL、LLM_API_KEY、LLM_MODEL。
const DEFAULTS = { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', provider: 'deepseek' };

export function createLlmClient({ env = process.env, fetchImpl = fetch, timeoutMs = 60000 } = {}) {
  const key = env.LLM_API_KEY || env.DEEPSEEK_API_KEY;
  const baseUrl = (env.LLM_BASE_URL || DEFAULTS.baseUrl).replace(/\/+$/, '');
  const model = env.LLM_MODEL || DEFAULTS.model;
  const provider = env.LLM_BASE_URL ? new URL(baseUrl).hostname : DEFAULTS.provider;

  return {
    configured: Boolean(key),
    provider,
    model,
    /**
     * @param {{ messages: {role: string, content: string}[], json?: boolean, maxTokens?: number, temperature?: number }} request
     * @returns {Promise<{ text: string, usage: { inputTokens: number, outputTokens: number } }>}
     */
    async chat({ messages, json = false, maxTokens = 1200, temperature = 0.3 }) {
      if (!key) throw Object.assign(new Error('没有配置大模型 Key'), { code: 'LLM_KEY_MISSING' });
      const response = await fetchImpl(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model, messages, max_tokens: maxTokens, temperature, stream: false,
          ...(json ? { response_format: { type: 'json_object' } } : {})
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw Object.assign(new Error(`大模型接口：${body.error?.message || response.status}`), { code: `LLM_${response.status}` });
      }
      return {
        text: body.choices?.[0]?.message?.content ?? '',
        usage: { inputTokens: body.usage?.prompt_tokens ?? 0, outputTokens: body.usage?.completion_tokens ?? 0 }
      };
    },
    /** Asks for a JSON object and parses it; throws LLM_BAD_JSON when the reply is not valid JSON. */
    async chatJson(request) {
      const reply = await this.chat({ ...request, json: true });
      try { return { data: JSON.parse(reply.text), usage: reply.usage }; }
      catch { throw Object.assign(new Error('大模型返回的内容不是有效的 JSON'), { code: 'LLM_BAD_JSON' }); }
    }
  };
}
