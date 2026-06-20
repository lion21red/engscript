const { YoutubeTranscript } = require('youtube-transcript');
const Groq = require('groq-sdk');

function extractVideoId(url) {
  const patterns = [
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
  ];
  for (const p of patterns) {
    const m = url.match(p);
    if (m) return m[1];
  }
  return null;
}

function isEnglish(text) { return /[a-zA-Z]/.test(text); }

function clean(text) {
  return text.replace(/\n/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

async function translateToEnglish(segments) {
  const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  const BATCH = 30;
  const translated = [];

  for (let i = 0; i < segments.length; i += BATCH) {
    const batch = segments.slice(i, i + BATCH);
    const numbered = batch.map((s, idx) => `${idx + 1}. ${s.text}`).join('\n');
    const prompt = `다음 문장들을 자연스러운 영어로 번역해 주세요.\n번호 순서를 유지하고, 각 줄은 "번호. 번역문" 형식으로만 출력하세요.\n\n${numbered}`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const lines = completion.choices[0].message.content.split('\n').filter(l => l.trim());
    batch.forEach((seg, idx) => {
      const match = lines[idx]?.match(/^\d+\.\s*(.+)/);
      translated.push({ ...seg, text: match ? match[1].trim() : seg.text });
    });
  }
  return translated;
}

async function fetchTitle(videoId) {
  try {
    const r = await fetch(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`);
    if (r.ok) return (await r.json()).title || videoId;
  } catch {}
  return videoId;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

  const { url } = JSON.parse(event.body || '{}');
  if (!url) return { statusCode: 400, body: JSON.stringify({ error: 'URL을 입력하세요.' }) };

  const videoId = extractVideoId(url.trim());
  if (!videoId) return { statusCode: 400, body: JSON.stringify({ error: '올바른 YouTube URL이 아닙니다.' }) };

  try {
    let transcript = null;
    let isEng = false;

    for (const lang of ['en', 'en-US', 'en-GB', 'en-AU']) {
      try { transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang }); isEng = true; break; } catch {}
    }
    if (!transcript) {
      try { transcript = await YoutubeTranscript.fetchTranscript(videoId); } catch {
        return { statusCode: 400, body: JSON.stringify({ error: '자막을 찾을 수 없습니다.' }) };
      }
    }

    let segments = transcript.map(item => ({
      start: Math.round(item.offset / 10) / 100,
      duration: Math.round(item.duration / 10) / 100,
      text: clean(item.text),
    })).filter(s => s.text.length > 0);

    let translated = false;
    if (!isEng || segments.every(s => !isEnglish(s.text))) {
      if (!process.env.GROQ_API_KEY) return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY가 설정되지 않았습니다.' }) };
      segments = await translateToEnglish(segments);
      translated = true;
    }

    const title = await fetchTitle(videoId);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ video_id: videoId, title, segments, translated }),
    };
  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: '오류: ' + err.message }) };
  }
};
