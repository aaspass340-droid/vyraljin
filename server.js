'use strict';
const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');
const { spawn } = require('child_process');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(cors());

const BUNNY_KEY      = process.env.BUNNY_KEY      || '';
const BUNNY_ZONE     = process.env.BUNNY_ZONE     || '';
const BUNNY_PULLZONE = (process.env.BUNNY_PULLZONE || '').replace(/\/$/,'');
const GEMINI_KEY     = process.env.GEMINI_KEY     || '';

/* ── FFmpeg / FFprobe binaries ── */
let FFMPEG_BIN  = 'ffmpeg';
let FFPROBE_BIN = 'ffprobe';
try { const s = require('ffmpeg-static');  if (s)      FFMPEG_BIN  = s;      } catch(e){}
try { const s = require('ffprobe-static'); if (s?.path) FFPROBE_BIN = s.path; } catch(e){}

const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 500 * 1024 * 1024 }
});

/* ── Serve index.html at root ── */
app.get('/', (req, res) => {
  const htmlPath = path.join(__dirname, 'index.html');
  if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
  res.send('VyralJin Server v5.0 — place index.html beside server.js');
});

/* ── Health / Config ── */
app.get('/health', (req, res) =>
  res.json({ status: 'ok', ver: 'v5.0', ffmpeg: FFMPEG_BIN, bunny: !!BUNNY_KEY, gemini: !!GEMINI_KEY }));

app.get('/api/health', (req, res) =>
  res.json({ status: 'ok', ver: 'v5.0', ffmpeg: FFMPEG_BIN, bunny: !!BUNNY_KEY, gemini: !!GEMINI_KEY }));

app.get('/api/config', (req, res) =>
  res.json({ pullzone: BUNNY_PULLZONE, hasBunny: !!BUNNY_KEY, hasGemini: !!GEMINI_KEY }));

/* ── Last render error (debug) ── */
let _lastRenderErr = '(abhi koi error nahi)';
app.get('/api/lasterror', (req, res) => res.type('text/plain').send(_lastRenderErr));

/* ── Upload test (no render) ── */
app.post('/api/uptest', upload.fields([{ name: 'video', maxCount: 1 }]), (req, res) => {
  const vf = req.files?.['video']?.[0];
  let sz = 0;
  try { sz = fs.statSync(vf.path).size; } catch(e) {}
  if (vf) fs.unlink(vf.path, ()=>{});
  _lastRenderErr = 'UPTEST: video mili! size=' + sz + ' bytes, time=' + new Date().toISOString();
  res.json({ ok: true, size: sz });
});

/* ── Gemini AI ── */
app.post('/api/gemini', async (req, res) => {
  if (!GEMINI_KEY) return res.status(400).json({ error: 'No Gemini key configured on server' });
  const prompt = req.body.prompt || '';
  if (!prompt) return res.status(400).json({ error: 'No prompt provided' });
  const maxTok = parseInt(req.body.maxTokens) || 8192;
  const body   = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.9, maxOutputTokens: maxTok }
  });
  const models = ['gemini-2.5-flash', 'gemini-2.5-flash-preview-04-17', 'gemini-1.5-flash'];
  for (const m of models) {
    try {
      const r = await new Promise((resolve, reject) => {
        const rq = https.request({
          hostname: 'generativelanguage.googleapis.com',
          path: '/v1beta/models/' + m + ':generateContent?key=' + GEMINI_KEY,
          method: 'POST',
          headers: { 'Content-Type': 'application/json' }
        }, resp => {
          let d = '';
          resp.on('data', c => d += c);
          resp.on('end', () => resolve({ status: resp.statusCode, data: d }));
        });
        rq.on('error', reject);
        rq.setTimeout(60000, () => { rq.destroy(); reject(new Error('timeout')); });
        rq.write(body);
        rq.end();
      });
      if (r.status === 200) {
        const j    = JSON.parse(r.data);
        const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) return res.json({ text });
      }
    } catch(e) { continue; }
  }
  res.status(500).json({ error: 'Gemini failed on all models' });
});

/* ── Bunny CDN — list ── */
app.get('/api/bunny-list', (req, res) => {
  if (!BUNNY_KEY || !BUNNY_ZONE)
    return res.status(400).json({ error: 'No bunny config on server' });
  const rq = https.request({
    hostname: 'sg.storage.bunnycdn.com',
    path: '/' + encodeURIComponent(BUNNY_ZONE) + '/',
    method: 'GET',
    headers: { 'AccessKey': BUNNY_KEY, 'Accept': 'application/json' }
  }, resp => {
    let d = '';
    resp.on('data', c => d += c);
    resp.on('end', () => {
      try { res.json(JSON.parse(d)); }
      catch(e) { res.status(500).json({ error: 'Parse error', raw: d.slice(0,200) }); }
    });
  });
  rq.on('error', e => res.status(500).json({ error: e.message }));
  rq.end();
});

/* ── Bunny CDN — upload ── */
app.post('/api/bunny-upload', (req, res) => {
  if (!BUNNY_KEY || !BUNNY_ZONE)
    return res.status(400).json({ error: 'No bunny config on server' });
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No filename in ?file=' });
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    const rq = https.request({
      hostname: 'sg.storage.bunnycdn.com',
      path: '/' + encodeURIComponent(BUNNY_ZONE) + '/' + encodeURIComponent(file),
      method: 'PUT',
      headers: {
        'AccessKey': BUNNY_KEY,
        'Content-Type': 'video/mp4',
        'Content-Length': bodyBuf.length
      }
    }, resp => {
      let d = '';
      resp.on('data', c => d += c);
      resp.on('end', () =>
        res.json({ status: resp.statusCode, ok: resp.statusCode < 300, url: BUNNY_PULLZONE + '/' + file }));
    });
    rq.on('error', e => res.status(500).json({ error: e.message }));
    rq.write(bodyBuf);
    rq.end();
  });
});

/* ── Bunny CDN — delete ── */
app.delete('/api/bunny-delete', (req, res) => {
  if (!BUNNY_KEY || !BUNNY_ZONE)
    return res.status(400).json({ error: 'No bunny config on server' });
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No filename in ?file=' });
  const rq = https.request({
    hostname: 'sg.storage.bunnycdn.com',
    path: '/' + encodeURIComponent(BUNNY_ZONE) + '/' + decodeURIComponent(file),
    method: 'DELETE',
    headers: { 'AccessKey': BUNNY_KEY }
  }, resp => {
    let d = '';
    resp.on('data', c => d += c);
    resp.on('end', () => res.json({ status: resp.statusCode, ok: resp.statusCode < 300 }));
  });
  rq.on('error', e => res.status(500).json({ error: e.message }));
  rq.end();
});

/* ══════════════════════════════════════════════════════════════════
   ── RENDER  (full-height portrait + all formats fixed) ──
══════════════════════════════════════════════════════════════════ */
app.post(
  '/api/render',
  (req, res, next) => {
    _lastRenderErr = 'STEP 0: /api/render request aayi! ' + new Date().toISOString();
    next();
  },
  upload.fields([{ name: 'video', maxCount: 1 }, { name: 'overlay', maxCount: 1 }]),
  (req, res) => {
    _lastRenderErr = 'STEP 0.5: multer ke baad, files=' + JSON.stringify(Object.keys(req.files || {}));

    const vf = req.files?.['video']?.[0];
    if (!vf) {
      _lastRenderErr = 'STEP 0.6: VIDEO FILE NAHI MILI multer ke baad';
      return res.status(400).json({ error: 'No video file received' });
    }
    const of = req.files?.['overlay']?.[0];

    let _vfSize = 0;
    try { _vfSize = fs.statSync(vf.path).size; } catch(e) {}
    _lastRenderErr = 'STEP 1: video mila, size=' + _vfSize + ' bytes, overlay=' + (of ? 'haan' : 'nahi');

    /* ── Trim params ── */
    const ts  = Math.max(0, parseFloat(req.body.trimStart) || 0);
    const te  = parseFloat(req.body.trimEnd) || 0;
    const dur = te > ts ? te - ts : 0;

    /* ── Target dimensions from client ── */
    const rW           = parseInt(req.body.videoW) || 1080;
    const rH           = parseInt(req.body.videoH) || 1920;
    const clientPortrait = req.body.isPortrait === '1';

    /* Output path */
    const out = '/tmp/final_' + Date.now() + '_' + Math.random().toString(36).slice(2) + '.mp4';

    let _rendered = false;

    /* ─────────────────────────────────────────────────────────────
       doRender — called after ffprobe (or on fallback timeout)
       tf       : transpose filter string e.g. 'transpose=1,' or ''
       hasAudio : whether source stream has audio
    ───────────────────────────────────────────────────────────── */
    function doRender(tf, hasAudio) {
      if (_rendered) return;
      _rendered = true;
      tf = tf || '';

      _lastRenderErr = 'STEP 2: doRender shuru, tf="' + tf + '", hasAudio=' + hasAudio + ', vfSize=' + _vfSize;

      /* Even dimensions required by libx264 */
      const evW = rW % 2 === 0 ? rW : rW + 1;
      const evH = rH % 2 === 0 ? rH : rH + 1;

      /*
       * Scale filter for single-input (no overlay):
       * - transpose FIRST (if needed)
       * - then scale with letterbox/pillarbox padding to exact evW×evH
       * - setsar=1 normalises SAR, format=yuv420p for h264 compat
       */
      const scaleF =
        tf +
        'scale=' + evW + ':' + evH + ':force_original_aspect_ratio=decrease,' +
        'pad='   + evW + ':' + evH + ':(ow-iw)/2:(oh-ih)/2:color=black,' +
        'setsar=1,' +
        'format=yuv420p';

      /*
       * Overlay filter_complex:
       *  [0:v] → transpose (if needed) → scale+pad+setsar → [base]
       *  [1:v] → scale to same dims, keep transparency  → [ov]
       *  [base][ov] → overlay centred → [outv]
       *  format=yuv420p appended as output filter
       */
      const fcOv =
        '[0:v]' + tf +
          'scale=' + evW + ':' + evH + ':force_original_aspect_ratio=decrease,' +
          'pad='   + evW + ':' + evH + ':(ow-iw)/2:(oh-ih)/2:color=black,' +
          'setsar=1[base];' +
        '[1:v]scale=' + evW + ':' + evH + ':force_original_aspect_ratio=decrease,' +
          'setsar=1,format=rgba[ov];' +
        '[base][ov]overlay=(W-w)/2:(H-h)/2:format=auto,' +
          'format=yuv420p[outv]';

      /* Trim args */
      const trimArgs = dur > 0.5
        ? ['-ss', String(ts), '-i', vf.path, '-t', String(dur)]
        : ['-i', vf.path];

      /* Audio args — keep audio when present */
      const audioOutArgs = hasAudio
        ? ['-map', '0:a', '-c:a', 'aac', '-b:a', '128k', '-ac', '2']
        : ['-an'];

      /* Build FFmpeg args */
      let args;
      if (of) {
        /* With overlay */
        args = [
          '-y',
          ...trimArgs,
          '-i', of.path,
          '-filter_complex', fcOv,
          '-map', '[outv]',
          ...( hasAudio ? ['-map', '0:a', '-c:a', 'aac', '-b:a', '128k', '-ac', '2'] : ['-an'] ),
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '26',
          '-pix_fmt', 'yuv420p',
          '-movflags', '+faststart',
          '-max_muxing_queue_size', '2048',
          out
        ];
      } else {
        /* Without overlay */
        args = [
          '-y',
          ...trimArgs,
          '-vf', scaleF,
          '-c:v', 'libx264',
          '-preset', 'ultrafast',
          '-crf', '26',
          '-pix_fmt', 'yuv420p',
          ...audioOutArgs,
          '-movflags', '+faststart',
          '-max_muxing_queue_size', '2048',
          out
        ];
      }

      _lastRenderErr = 'STEP 3: FFmpeg spawn hua\nARGS: ' + args.join(' ');
      const ff = spawn(FFMPEG_BIN, args);

      let err = '';
      ff.stderr.on('data', d => {
        err += d.toString();
        _lastRenderErr = 'STEP 4: FFmpeg chal raha\n\n' + err.slice(-2000);
      });

      /* Kill timer — 15 minutes max */
      const killTimer = setTimeout(() => {
        ff.kill('SIGKILL');
        if (!res.headersSent) {
          _lastRenderErr = 'TIMEOUT 900s | vfSize:' + _vfSize;
          res.status(500).json({ error: 'FFmpeg timeout', detail: err.slice(-500) });
        }
        try { fs.unlink(vf.path, ()=>{}); if (of) fs.unlink(of.path, ()=>{}); fs.unlink(out, ()=>{}); } catch(e){}
      }, 900000);

      ff.on('close', code => {
        clearTimeout(killTimer);
        try { fs.unlink(vf.path, ()=>{}); } catch(e) {}
        if (of) try { fs.unlink(of.path, ()=>{}); } catch(e) {}

        if (code !== 0) {
          _lastRenderErr =
            'EXIT ' + code + ' | vfSize:' + _vfSize +
            '\n\nARGS: ' + args.join(' ') +
            '\n\nSTDERR:\n' + err;
          try { fs.unlink(out, ()=>{}); } catch(e) {}
          return res.status(500).json({ error: 'FFmpeg failed (exit ' + code + ')', detail: err.slice(-1500) });
        }

        /* Stream rendered mp4 back to client */
        res.setHeader('Content-Type', 'video/mp4');
        const stream = fs.createReadStream(out);
        stream.pipe(res);
        stream.on('end',   () => { try { fs.unlink(out, ()=>{}); } catch(e){} });
        stream.on('error', () => { try { fs.unlink(out, ()=>{}); } catch(e){} });
        _lastRenderErr = 'OK — render mکمل, size=' + _vfSize;
      });
    }

    /* ─────────────────────────────────────────────────────────────
       ffprobe — detect rotation metadata & audio stream
       If ffprobe takes > 12 s → fallback with basic args
    ───────────────────────────────────────────────────────────── */
    const fbTimer = setTimeout(() => {
      /* Fallback: for portrait videos delivered landscape (rare), apply transpose */
      doRender(clientPortrait ? 'transpose=1,' : '', true);
    }, 12000);

    let probe;
    try {
      probe = spawn(FFPROBE_BIN, [
        '-v', 'quiet',
        '-print_format', 'json',
        '-show_streams',
        vf.path
      ]);
    } catch(e) {
      clearTimeout(fbTimer);
      doRender(clientPortrait ? 'transpose=1,' : '', true);
      return;
    }

    let probeOut = '';
    probe.stdout.on('data', d => { probeOut += d; });
    probe.stderr.on('data', ()=>{});
    probe.on('error', () => {
      clearTimeout(fbTimer);
      doRender(clientPortrait ? 'transpose=1,' : '', true);
    });
    probe.on('close', () => {
      clearTimeout(fbTimer);
      let tf = '';
      let hasAudio = false;
      try {
        const info = JSON.parse(probeOut || '{}');
        const streams = info.streams || [];

        const vs = streams.find(s => s.codec_type === 'video');
        const as = streams.find(s => s.codec_type === 'audio');
        hasAudio = !!as;

        if (vs) {
          /* Check rotation metadata (older containers store it as a tag) */
          const rotTag  = vs?.tags?.rotate;
          const rotSide = vs?.side_data_list?.find(sd => sd.rotation !== undefined)?.rotation;
          const rot = Math.abs(parseInt(rotTag ?? rotSide ?? '0') || 0);

          if (rot === 90 || rot === -270) {
            tf = 'transpose=1,';   /* CW 90° */
          } else if (rot === 270 || rot === -90) {
            tf = 'transpose=2,';   /* CCW 90° (= transpose=2) */
          } else if (rot === 180 || rot === -180) {
            tf = 'transpose=1,transpose=1,'; /* 180° flip */
          }

          /*
           * Extra check: if the client says portrait BUT the stored frame
           * dimensions are landscape (width > height) AND no rotation tag,
           * the video was encoded sideways → transpose it.
           */
          if (!tf && clientPortrait) {
            const rawW = parseInt(vs.width)  || 0;
            const rawH = parseInt(vs.height) || 0;
            if (rawW > rawH) {
              tf = 'transpose=1,';
            }
          }
        }
      } catch(e) {
        /* probeOut parse failed — proceed with no transpose */
      }
      doRender(tf, hasAudio);
    });
  }
);

/* ── Start server ── */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log('VyralJin Server v5.0 running on port ' + PORT)
);
