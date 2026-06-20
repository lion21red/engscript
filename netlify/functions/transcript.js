const Groq = require('groq-sdk');
const { Innertube } = require('youtubei.js');

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

async function fetchTranscript(videoId) {
  const yt = await Innertube.create({ retrieve_player: false });
  const info = await yt.getInfo(videoId);
  const transcriptData = await info.getTranscript();

  if (!transcriptData?.transcript?.content?.body?.initial_segments) {
    throw new Error('자막을 찾을 수 없습니다.');
  }

  const segments = transcriptData.transcript.content.body.initial_segments
    .filter(s => s.snippet?.text)
    .map(s => ({
      start: (s.start_ms || 0) / 1000,
      duration: ((s.end_ms || 0) - (s.start_ms || 0)) / 1000,
      text: clean(s.snippet.text),
    }))
    .filter(s => s.text.length > 0);

  const langCode = transcriptData.selectedLanguage?.languageCode || 'en';
  return { segments, langCode };
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
    const { segments: rawSegments, langCode } = await fetchTranscript(videoId);

    let segments = rawSegments;
    let translated = false;

    if (!langCode?.startsWith('en') || segments.every(s => !isEnglish(s.text))) {
      if (!process.env.GROQ_API_KEY) {
        return { statusCode: 500, body: JSON.stringify({ error: 'GROQ_API_KEY가 설정되지 않았습니다.' }) };
      }
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
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message }),
    };
  }
};
