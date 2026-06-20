const Groq = require('groq-sdk');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  if (!process.env.GROQ_API_KEY) {
    return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY가 설정되지 않았습니다.' }) };
  }

  const { sentence, context } = JSON.parse(event.body || '{}');
  if (!sentence) return { statusCode: 400, body: JSON.stringify({ error: '문장이 없습니다.' }) };

  const prompt = `다음 영어 문장을 영어 학습자(한국인)를 위해 자세히 해설해 주세요.

문장: "${sentence}"
${context ? `앞뒤 문맥: ${context}` : ''}

다음 항목을 포함해 주세요:
1. **한국어 번역** - 자연스러운 번역
2. **핵심 표현 & 어휘** - 중요한 단어/숙어/구동사 설명
3. **문법 포인트** - 문장 구조, 시제, 어법 등 학습 포인트
4. **유사 표현** - 비슷한 의미의 다른 표현 1~2개

간결하고 명확하게 작성해 주세요.`;

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ explanation: completion.choices[0].message.content }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: 'AI 해설 오류: ' + err.message }) };
  }
};
