// promptfoo 的 provider：把"岛 02 的判定"包成可评测对象
//
// 现在判定是规则版（去重=相似度、矛盾=同主体同属性不同值）；
// 以后换成 LLM，只要这个 provider 还指向同一个口，下面的用例集与基线不用改。
//
// prompt = 待判定的候选内容；vars.existing = 已有知识数组

const ISLAND02 = process.env.SNAO_ISLAND02 ?? 'http://127.0.0.1:7200';
const SECRET = process.env.SNAO_LINE_SECRET ?? 'dev-line-secret';

export default async function (prompt, context) {
  const existing = context?.vars?.existing ?? [];
  const res = await fetch(`${ISLAND02}/v1/judge-one`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-snao-line-secret': SECRET },
    body: JSON.stringify({ content: prompt, existing }),
  }).catch(() => null);

  if (!res || !res.ok) {
    return { output: JSON.stringify({ error: `island02 unavailable: ${res?.status ?? 'no-response'}` }) };
  }
  const data = await res.json();
  return { output: JSON.stringify(data) };
}
