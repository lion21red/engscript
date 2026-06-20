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

async function fetchTranscript(videoId) {
  // InnerTube API로 자막 URL 가져오기
  const playerRes = await fetch('https://www.youtube.com/youtubei/v1/player?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': '2.20240101.00.00',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    body: JSON.stringify({
      videoId,
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20240101.00.00',
          hl: 'en',
          gl: 'US',
        }
      }
    })
  });

  const playerData = await playerRes.json();
  const captionTracks = playerData?.captions?.playerCaptionsTracklistRenderer?.captionTracks;

  if (!captionTracks || captionTracks.length === 0) {
    throw new Error('자막을 찾을 수 없습니다. 자막이 없는 영상입니다.');
  }

  // 영어 자막 우선
  let track = captionTracks.find(t => t.languageCode === 'en' || t.languageCode?.startsWith('en'));
  if (!track) track = captionTracks[0];

  // 자막 내용 가져오기
  const captionRes = await fetch(track.baseUrl + '&fmt=json3', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  const captionData = await captionRes.json();

  const segments = (captionData.events || [])
    .filter(e => e.segs && e.segs.some(s => s.utf8?.trim()))
    .map(e => ({
      start: (e.tStartMs || 0) / 1000,
      duration: (e.dDurationMs || 2000) / 1000,
      text: clean(e.segs.map(s => s.utf8 || '').join('')),
    }))
    .filter(s => s.text.length > 0 && s.text !== '\n');

  return { segments, langCode: track.languageCode };
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
