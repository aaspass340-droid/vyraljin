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
app.get('/health', (req, res) => res.json({ status: 'ok', ver: 'v9.2-stable', ffmpeg: FFMPEG_BIN, bunny: !!BUNNY_KEY, gemini: !!GEMINI_KEY }));
app.get('/api/config', (req, res) => res.json({ pullzone: BUNNY_PULLZONE, hasBunny: !!BUNNY_KEY, hasGemini: !!GEMINI_KEY }));

let _lastRenderErr='(abhi koi error nahi)';
app.get('/api/lasterror',(req,res)=>res.type('text/plain').send(_lastRenderErr));
// 🔬 TEST: sirf video receive karo, render NAHI — pata karne ke liye upload pohanchti hai ya nahi
app.post('/api/uptest', upload.fields([{name:'video',maxCount:1}]), (req,res)=>{
  const vf=req.files['video']?.[0];
  let sz=0; try{sz=fs.statSync(vf.path).size;}catch(e){}
  if(vf)fs.unlink(vf.path,()=>{});
  _lastRenderErr='UPTEST: video mili! size='+sz+' bytes, time='+new Date().toISOString();
  res.json({ok:true,size:sz});
});

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

app.post('/api/render', (req,res,next)=>{ _lastRenderErr='STEP 0: /api/render request aayi! '+new Date().toISOString(); next(); }, upload.fields([{name:'video',maxCount:1},{name:'overlay',maxCount:1}]), (req, res) => {
  _lastRenderErr='STEP 0.5: multer ke baad, files='+JSON.stringify(Object.keys(req.files||{}));
  const vf = req.files['video']?.[0]; if (!vf) { _lastRenderErr='STEP 0.6: VIDEO FILE NAHI MILI multer ke baad'; return res.status(400).json({ error: 'No video' }); }
  const of = req.files['overlay']?.[0];
  let _vfSize=0;
  try{ _vfSize=fs.statSync(vf.path).size; }catch(e){}
  console.log('VIDEO received size:', _vfSize);
  _lastRenderErr='STEP 1: video mila, size='+_vfSize+' bytes, overlay='+(of?'haan':'nahi');
  const ts = Math.max(0, parseFloat(req.body.trimStart)||0);
  const te = parseFloat(req.body.trimEnd)||0;
  const dur = te > ts ? te - ts : 0;
  const out = '/tmp/final_' + Date.now() + '.mp4';
  const { spawn } = require('child_process');
  let _rendered = false;
  function doRender() {
    if (_rendered) return; _rendered = true;
    _lastRenderErr='STEP 2: doRender shuru, size='+_vfSize;
    // ASLI SHAPE: video ke original dimensions hi rakho — na scale, na crop, na pad.
    // Sirf width/height ko even (2 ka multiple) karo, kyunke libx264 ko even chahiye.
    const scaleF = 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1,format=yuv420p';
    // Overlay ko video ke asli size par fit karo (scale2ref) — phir bilkul upar overlay.
    const fcOv = '[0:v]scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1[base];[1:v][base]scale2ref=w=iw:h=ih[ov][base2];[base2][ov]overlay=0:0:format=auto[outv]';
    const trimArgs = dur > 0.5 ? ['-ss', String(ts), '-i', vf.path, '-t', String(dur)] : ['-i', vf.path];
    const args = of
      ? ['-y','-filter_complex_threads','1',...trimArgs,'-i',of.path,'-filter_complex',fcOv,'-map','[outv]','-c:v','libx264','-preset','ultrafast','-threads','1','-crf','23','-pix_fmt','yuv420p','-an','-movflags','+faststart','-max_muxing_queue_size','1024',out]
      : ['-y','-filter_threads','1',...trimArgs,'-vf',scaleF,'-c:v','libx264','-preset','ultrafast','-threads','1','-crf','23','-pix_fmt','yuv420p','-an','-movflags','+faststart','-max_muxing_queue_size','1024',out];
    const ff = spawn(FFMPEG_BIN, args);
    _lastRenderErr='STEP 3: FFmpeg spawn hua, ARGS='+args.join(' ');
    let err = '';
    ff.stderr.on('data', d => { err += d.toString(); _lastRenderErr='STEP 4: FFmpeg chal raha\n\n'+err.slice(-1500); });
    ff.on('close', code => {
      fs.unlink(vf.path, ()=>{});
      if (of) fs.unlink(of.path, ()=>{});
      if (code !== 0) { _lastRenderErr='EXIT '+code+' | size:'+_vfSize+'\n\nARGS: '+args.join(' ')+'\n\n'+err; return res.status(500).json({ error: 'FFmpeg failed', detail: err.slice(-1500) }); }
      res.setHeader('Content-Type','video/mp4');
      const s = fs.createReadStream(out);
      s.pipe(res);
      s.on('end', () => fs.unlink(out, ()=>{}));
      s.on('error', () => fs.unlink(out, ()=>{}));
    });
    setTimeout(() => { ff.kill('SIGKILL'); if (!res.headersSent) { _lastRenderErr='TIMEOUT 900s | size:'+_vfSize; res.status(500).json({ error: 'Timeout' }); } }, 900000);
  }
  // AUTO-ROTATE: FFmpeg khud rotation metadata padh ke seedha kar leta hai — manual transpose nahi.
  doRender();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('VyralJin Server v7.0-noscale on port ' + PORT));