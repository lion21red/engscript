const express = require('express');
const path = require('path');
const fs = require('fs');
const { YoutubeTranscript } = require('youtube-transcript');
const Groq = require('groq-sdk');

const app = express();
const PORT = 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const CACHE_DIR = path.join(__dirname, 'cache');
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR);

const HISTORY_FILE = path.join(__dirname, 'history.json');

function historyRead() {
  if (fs.existsSync(HISTORY_FILE)) {
    try { return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch {}
  }
  return [];
}

function historySave(list) {
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(list, null, 2), 'utf8');
}

async function fetchVideoTitle(videoId) {
  try {
    const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
    const r = await fetch(url);
    if (r.ok) {
      const d = await r.json();
      return d.title || videoId;
    }
  } catch {}
  return videoId;
}

function extractVideoId(url) {
  const patterns = [
    /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/,
    /youtu\.be\/([A-Za-z0-9_-]{11})/,
    /youtube\.com\/watch\?v=([A-Za-z0-9_-]{11})/,
    /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/,
  ];
  for (const pattern of patterns) {
    const m = url.match(pattern);
    if (m) return m[1];
  }
  return null;
}

function isEnglishText(text) {
  return /[a-zA-Z]/.test(text);
}

function cleanText(text) {
  return text.replace(/\n/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').trim();
}

function cacheRead(videoId) {
  const file = path.join(CACHE_DIR, `${videoId}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  }
  return null;
}

function cacheWrite(videoId, data) {
  const file = path.join(CACHE_DIR, `${videoId}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// 한국어 자막을 영어로 일괄 번역
async function translateToEnglish(segments) {
  if (!GROQ_API_KEY) throw new Error('GROQ_API_KEY가 없어 번역할 수 없습니다.');

  const groq = new Groq({ apiKey: GROQ_API_KEY });

  // 번역 효율을 위해 30개씩 묶어서 요청
  const BATCH = 30;
  const translated = [];

  for (let i = 0; i < segments.length; i += BATCH) {
    const batch = segments.slice(i, i + BATCH);
    const numbered = batch.map((s, idx) => `${idx + 1}. ${s.text}`).join('\n');

    const prompt = `다음 문장들을 자연스러운 영어로 번역해 주세요.
번호 순서를 유지하고, 각 줄은 "번호. 번역문" 형식으로만 출력하세요. 설명 없이 번역만 출력합니다.

${numbered}`;

    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    });

    const result = completion.choices[0].message.content;
    const lines = result.split('\n').filter(l => l.trim());

    batch.forEach((seg, idx) => {
      const match = lines[idx]?.match(/^\d+\.\s*(.+)/);
      translated.push({
        ...seg,
        text: match ? match[1].trim() : seg.text,
      });
    });
  }

  return translated;
}

app.post('/api/transcript', async (req, res) => {
  const { url } = req.body || {};
  if (!url) return res.status(400).json({ error: 'URL을 입력하세요.' });

  const videoId = extractVideoId(url.trim());
  if (!videoId) return res.status(400).json({ error: '올바른 YouTube URL이 아닙니다.' });

  // 캐시 확인
  const cached = cacheRead(videoId);
  if (cached) {
    // 히스토리 맨 위로 갱신
    fetchVideoTitle(videoId).then(title => {
      const list = historyRead().filter(h => h.video_id !== videoId);
      list.unshift({ video_id: videoId, title, translated: cached.translated || false, saved_at: new Date().toISOString() });
      historySave(list.slice(0, 50));
    });
    return res.json({ video_id: videoId, segments: cached.segments, from_cache: true, translated: cached.translated });
  }

  try {
    let transcript = null;
    let isEnglish = false;

    // 1) 영어 자막 먼저 시도
    for (const lang of ['en', 'en-US', 'en-GB', 'en-AU']) {
      try {
        transcript = await YoutubeTranscript.fetchTranscript(videoId, { lang });
        isEnglish = true;
        break;
      } catch {}
    }

    // 2) 영어 없으면 기본 자막(한국어 등) 가져오기
    if (!transcript) {
      try {
        transcript = await YoutubeTranscript.fetchTranscript(videoId);
        isEnglish = false;
      } catch (e) {
        return res.status(400).json({ error: '자막을 찾을 수 없습니다. 자막이 없는 영상입니다.' });
      }
    }

    if (!transcript || transcript.length === 0) {
      return res.status(400).json({ error: '자막을 찾을 수 없습니다.' });
    }

    let segments = transcript.map(item => ({
      start: Math.round(item.offset / 10) / 100,
      duration: Math.round(item.duration / 10) / 100,
      text: cleanText(item.text),
    })).filter(item => item.text.length > 0);

    // 3) 영어 자막이 아니면 AI 번역
    let translated = false;
    if (!isEnglish || segments.every(s => !isEnglishText(s.text))) {
      try {
        segments = await translateToEnglish(segments);
        translated = true;
      } catch (e) {
        return res.status(500).json({ error: '번역 중 오류: ' + e.message });
      }
    }

    // 캐시 저장
    cacheWrite(videoId, { segments, translated, saved_at: new Date().toISOString() });

    // 히스토리 저장 (제목 비동기 조회)
    fetchVideoTitle(videoId).then(title => {
      const list = historyRead().filter(h => h.video_id !== videoId);
      list.unshift({ video_id: videoId, title, translated, saved_at: new Date().toISOString() });
      historySave(list.slice(0, 50));
    });

    res.json({ video_id: videoId, segments, translated });
  } catch (err) {
    res.status(500).json({ error: '자막을 불러오는 중 오류: ' + (err.message || '') });
  }
});

// 히스토리 조회
app.get('/api/history', (req, res) => {
  res.json(historyRead());
});

// 히스토리 항목 삭제
app.delete('/api/history/:videoId', (req, res) => {
  const list = historyRead().filter(h => h.video_id !== req.params.videoId);
  historySave(list);
  res.json({ ok: true });
});

app.post('/api/explain', async (req, res) => {
  if (!GROQ_API_KEY) {
    return res.status(500).json({ error: 'GROQ_API_KEY 환경변수가 설정되지 않았습니다.' });
  }

  const { sentence, context } = req.body || {};
  if (!sentence) return res.status(400).json({ error: '문장이 없습니다.' });

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
    const groq = new Groq({ apiKey: GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: 'llama-3.1-8b-instant',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });
    res.json({ explanation: completion.choices[0].message.content });
  } catch (err) {
    res.status(500).json({ error: 'AI 해설 오류: ' + (err.message || '') });
  }
});

app.listen(PORT, () => {
  console.log(`서버 실행 중: http://localhost:${PORT}`);
});
