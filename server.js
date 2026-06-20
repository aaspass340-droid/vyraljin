const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const https = require('https');
const app = express();
app.use(express.json({ limit: '50mb' }));
const upload = multer({ dest: '/tmp/uploads/', limits: { fileSize: 500 * 1024 * 1024 } });
app.use(cors());

const BUNNY_KEY = process.env.BUNNY_KEY || '';
const BUNNY_ZONE = process.env.BUNNY_ZONE || '';
const BUNNY_PULLZONE = (process.env.BUNNY_PULLZONE || '').replace(/\/$/,'');
const GEMINI_KEY = process.env.GEMINI_KEY || '';

let FFMPEG_BIN = 'ffmpeg';
try { const s = require('ffmpeg-static'); if (s) FFMPEG_BIN = s; } catch(e) {}

app.get('/', (req, res) => res.send('VyralJin Server OK'));
app.get('/health', (req, res) => res.json({ status: 'ok', ver: 'v5.1-safe', ffmpeg: FFMPEG_BIN, bunny: !!BUNNY_KEY, gemini: !!GEMINI_KEY }));
app.get('/api/config', (req, res) => res.json({ pullzone: BUNNY_PULLZONE, hasBunny: !!BUNNY_KEY, hasGemini: !!GEMINI_KEY }));

let _lastRenderErr='(abhi koi error nahi)';
app.get('/api/lasterror',(req,res)=>res.type('text/plain').send(_lastRenderErr));

app.post('/api/gemini', async (req, res) => {
  if (!GEMINI_KEY) return res.status(400).json({ error: 'No Gemini key' });
  const prompt = req.body.prompt || '';
  if (!prompt) return res.status(400).json({ error: 'No prompt' });
  const maxTok = parseInt(req.body.maxTokens) || 8192;
  const body = JSON.stringify({ contents:[{parts:[{text:prompt}]}], generationConfig:{temperature:0.9,maxOutputTokens:maxTok} });
  const models = ['gemini-2.5-flash','gemini-2.5-flash-preview-04-17'];
  for (const m of models) {
    try {
      const r = await new Promise((resolve,reject)=>{
        const rq = https.request({hostname:'generativelanguage.googleapis.com',path:'/v1beta/models/'+m+':generateContent?key='+GEMINI_KEY,method:'POST',headers:{'Content-Type':'application/json'}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>resolve({status:resp.statusCode,data:d}));});
        rq.on('error',reject); rq.write(body); rq.end();
      });
      if (r.status === 200) {
        const j = JSON.parse(r.data);
        const text = j?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        if (text) return res.json({ text });
      }
    } catch(e) { continue; }
  }
  res.status(500).json({ error: 'Gemini failed' });
});

app.get('/api/bunny-list', (req, res) => {
  if (!BUNNY_KEY || !BUNNY_ZONE) return res.status(400).json({ error: 'No bunny config' });
  const r = https.request({hostname:'sg.storage.bunnycdn.com',path:'/'+encodeURIComponent(BUNNY_ZONE)+'/',method:'GET',headers:{'AccessKey':BUNNY_KEY,'Accept':'application/json'}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>{try{res.json(JSON.parse(d));}catch(e){res.status(500).json({error:'Parse error'})}});});
  r.on('error',e=>res.status(500).json({error:e.message})); r.end();
});

app.post('/api/bunny-upload', (req, res) => {
  if (!BUNNY_KEY || !BUNNY_ZONE) return res.status(400).json({ error: 'No bunny config' });
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No filename' });
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const bodyBuf = Buffer.concat(chunks);
    const r = https.request({hostname:'sg.storage.bunnycdn.com',path:'/'+encodeURIComponent(BUNNY_ZONE)+'/'+encodeURIComponent(file),method:'PUT',headers:{'AccessKey':BUNNY_KEY,'Content-Type':'video/mp4','Content-Length':bodyBuf.length}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>res.json({status:resp.statusCode,ok:resp.statusCode<300,url:BUNNY_PULLZONE+'/'+file}));});
    r.on('error',e=>res.status(500).json({error:e.message})); r.write(bodyBuf); r.end();
  });
});

app.delete('/api/bunny-delete', (req, res) => {
  if (!BUNNY_KEY || !BUNNY_ZONE) return res.status(400).json({ error: 'No bunny config' });
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'No filename' });
  const r = https.request({hostname:'sg.storage.bunnycdn.com',path:'/'+encodeURIComponent(BUNNY_ZONE)+'/'+decodeURIComponent(file),method:'DELETE',headers:{'AccessKey':BUNNY_KEY}},(resp)=>{let d='';resp.on('data',c=>d+=c);resp.on('end',()=>res.json({status:resp.statusCode,ok:resp.statusCode<300}));});
  r.on('error',e=>res.status(500).json({error:e.message})); r.end();
});

app.post('/api/render', upload.fields([{name:'video',maxCount:1},{name:'overlay',maxCount:1}]), (req, res) => {
  const vf = req.files['video'] && req.files['video'][0]; if (!vf) return res.status(400).json({ error: 'No video' });
  const of = req.files['overlay'] && req.files['overlay'][0];
  let _vfSize=0; try{ _vfSize=fs.statSync(vf.path).size; }catch(e){}
  _lastRenderErr='STEP 1: video='+_vfSize+'b overlay='+(of?'haan':'nahi');
  const ts = Math.max(0, parseFloat(req.body.trimStart)||0);
  const te = parseFloat(req.body.trimEnd)||0;
  const dur = te > ts ? te - ts : 0;
  const out = '/tmp/final_' + Date.now() + '.mp4';
  const rW = parseInt(req.body.videoW)||720;
  const rH = parseInt(req.body.videoH)||1280;
  const clientPortrait = req.body.isPortrait === '1';
  const cp = require('child_process');
  const spawn = cp.spawn;
  let _rendered = false;
  function doRender(tf, hasAudio) {
    if (_rendered) return; _rendered = true;
    tf = tf || '';
    const evW = rW % 2 === 0 ? rW : rW + 1;
    const evH = rH % 2 === 0 ? rH : rH + 1;
    _lastRenderErr='STEP 2: render '+evW+'x'+evH+' audio='+hasAudio;
    const scaleF = tf + 'scale=' + evW + ':' + evH + ':force_original_aspect_ratio=decrease,pad=' + evW + ':' + evH + ':(ow-iw)/2:(oh-ih)/2,setsar=1';
    const fcOv = '[0:v]' + tf + 'scale=' + evW + ':' + evH + ':force_original_aspect_ratio=decrease,pad=' + evW + ':' + evH + ':(ow-iw)/2:(oh-ih)/2,setsar=1[base];[1:v]scale=' + evW + ':' + evH + '[ov];[base][ov]overlay=0:0[outv]';
    const trimArgs = dur > 0.5 ? ['-ss', String(ts), '-i', vf.path, '-t', String(dur)] : ['-i', vf.path];
    const audioArgs = hasAudio ? ['-c:a','aac','-b:a','96k'] : ['-an'];
    let args;
    if (of) {
      args = ['-y'].concat(trimArgs).concat(['-i',of.path,'-filter_complex',fcOv,'-map','[outv]','-map','0:a?','-c:v','libx264','-preset','ultrafast','-crf','28','-pix_fmt','yuv420p','-threads','1']).concat(audioArgs).concat(['-movflags','+faststart','-max_muxing_queue_size','512',out]);
    } else {
      args = ['-y'].concat(trimArgs).concat(['-vf',scaleF,'-pix_fmt','yuv420p','-c:v','libx264','-preset','ultrafast','-crf','28','-threads','1']).concat(audioArgs).concat(['-movflags','+faststart','-max_muxing_queue_size','512',out]);
    }
    const ff = spawn(FFMPEG_BIN, args);
    _lastRenderErr='STEP 3: ARGS='+args.join(' ');
    let err = '';
    ff.stderr.on('data', d => { err += d.toString(); _lastRenderErr='STEP 4:\n\n'+err.slice(-1800); });
    ff.on('close', code => {
      fs.unlink(vf.path, ()=>{});
      if (of) fs.unlink(of.path, ()=>{});
      if (code !== 0) { _lastRenderErr='EXIT '+code+'\nARGS: '+args.join(' ')+'\n\n'+err; if(!res.headersSent) res.status(500).json({ error: 'FFmpeg failed', detail: err.slice(-800) }); return; }
      res.setHeader('Content-Type','video/mp4');
      const s = fs.createReadStream(out);
      s.pipe(res);
      s.on('end', () => fs.unlink(out, ()=>{}));
      s.on('error', () => fs.unlink(out, ()=>{}));
    });
    setTimeout(() => { try{ff.kill('SIGKILL');}catch(e){} if (!res.headersSent) { _lastRenderErr='TIMEOUT'; res.status(500).json({ error: 'Timeout' }); } }, 270000);
  }
  let FFPROBE_BIN = 'ffprobe';
  try { const s = require('ffprobe-static'); if(s && s.path) FFPROBE_BIN = s.path; } catch(e) {}
  const fbTimer = setTimeout(() => { doRender(clientPortrait ? 'transpose=1,' : '', false); }, 10000);
  try {
    const probe = spawn(FFPROBE_BIN, ['-v','quiet','-print_format','json','-show_streams',vf.path]);
    let probeOut = '';
    probe.stdout.on('data', d => probeOut += d);
    probe.stderr.on('data', ()=>{});
    probe.on('error', () => { clearTimeout(fbTimer); doRender(clientPortrait ? 'transpose=1,' : '', false); });
    probe.on('close', () => {
      clearTimeout(fbTimer);
      let tf = ''; let hasAudio = false;
      try {
        const info = JSON.parse(probeOut || '{}');
        const vs = info.streams && info.streams.find(s => s.codec_type==='video');
        const as = info.streams && info.streams.find(s => s.codec_type==='audio');
        hasAudio = !!as;
        const rot = Math.abs(parseInt((vs && vs.tags && vs.tags.rotate) || (vs && vs.side_data_list && vs.side_data_list[0] && vs.side_data_list[0].rotation) || '0'));
        if (rot === 90) tf = 'transpose=1,';
        else if (rot === 270) tf = 'transpose=2,';
        if (!tf && clientPortrait && vs) {
          const rawW = parseInt(vs.width)||0; const rawH = parseInt(vs.height)||0;
          if (rawW > rawH) tf = 'transpose=1,';
        }
      } catch(e) {}
      doRender(tf, hasAudio);
    });
  } catch(e) { clearTimeout(fbTimer); doRender(clientPortrait ? 'transpose=1,' : '', false); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VyralJin Server v5.1-safe on port ' + PORT));