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
  return text
    .replace(/\n/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\[Music\]/gi, '')
    .replace(/\[Applause\]/gi, '')
    .trim();
}

// YouTube 페이지에서 자막 직접 추출
async function fetchTranscriptDirect(videoId) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  };

  // 영어 자막 먼저, 없으면 기본
  const langs = ['en', 'en-US', ''];

  for (const lang of langs) {
    try {
      const watchUrl = `https://www.youtube.com/watch?v=${videoId}${lang ? `&hl=${lang}` : ''}`;
      const res = await fetch(watchUrl, { headers });
      const html = await res.text();

      // ytInitialPlayerResponse 추출
      const match = html.match(/ytInitialPlayerResponse\s*=\s*({.+?})\s*;/s);
      if (!match) continue;

      const playerResponse = JSON.parse(match[1]);
      const captionTracks = playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!captionTracks || captionTracks.length === 0) continue;

      // 영어 자막 우선
      let track = captionTracks.find(t => t.languageCode === 'en' || t.languageCode?.startsWith('en'));
      if (!track) track = captionTracks[0];

      const captionRes = await fetch(track.baseUrl + '&fmt=json3', { headers });
      const captionData = await captionRes.json();

      const segments = (captionData.events || [])
        .filter(e => e.segs)
        .map(e => ({
          start: (e.tStartMs || 0) / 1000,
          duration: (e.dDurationMs || 2000) / 1000,
          text: clean(e.segs.map(s => s.utf8 || '').join('')),
          lang: track.languageCode,
        }))
        .filter(s => s.text.length > 0);

      return { segments, langCode: track.languageCode };
    } catch (e) {
      continue;
    }
  }

  throw new Error('자막을 찾을 수 없습니다.');
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
    const { segments: rawSegments, langCode } = await fetchTranscriptDirect(videoId);

    let segments = rawSegments;
    let translated = false;

    // 영어가 아니면 번역
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
