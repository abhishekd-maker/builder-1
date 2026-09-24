// Opus Home Twin: video -> 3D room backend
// Receives a room video, shrinks it to KIRI's limits, sends it to KIRI Engine's 3DGS API
// (with "3DGS to Mesh" on, GLB output), tracks the job and returns the finished model.
// The KIRI API key never leaves this server.

import express from 'express';
import Busboy from 'busboy';
import AdmZip from 'adm-zip';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const KIRI_KEY = process.env.KIRI_API_KEY || '';
const MOCK = process.env.MOCK === '1' || !KIRI_KEY;
const KIRI = 'https://api.kiriengine.app/api/v1/open';
const WORK = path.join(os.tmpdir(), 'oht');
const MAX_UPLOAD = 600 * 1024 * 1024; // 600 MB
await fsp.mkdir(WORK, { recursive: true });

const app = express();
// Allow the app to be hosted elsewhere (for example Netlify) and call this server.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', process.env.ALLOW_ORIGIN || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Find the app page and sample scan wherever they were uploaded (public/, the top level, or an update/ folder),
// so a slightly different GitHub folder layout does not break the site.
const SEARCH_DIRS = ['public', '.', 'update/public', 'update', 'opus-home-twin/public'].map(d => path.join(__dirname, d));
const findFile = name => SEARCH_DIRS.map(d => path.join(d, name)).find(f => fs.existsSync(f));
const newest = name => SEARCH_DIRS.map(d => path.join(d, name)).filter(f => fs.existsSync(f))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
app.get(['/', '/index.html'], (req, res) => {
  const page = newest('index.html');
  if (!page) return res.status(404).send('index.html not found. Upload it to the public folder of the repository.');
  res.setHeader('Cache-Control', 'no-cache');
  res.sendFile(page);
});
app.get('/sample-scan.glb', (req, res) => {
  const f = findFile('sample-scan.glb'); if (!f) return res.sendStatus(404);
  res.sendFile(f);
});

// Jobs live in memory while the video is being prepared and sent to KIRI.
// Once KIRI returns its id, the browser keeps that id and can resume even after a server restart.
const jobs = new Map(); // jobId -> { state, serialize, error, created }
const STATUS = { '-1': 'uploading', 0: 'processing', 1: 'failed', 2: 'ready', 3: 'queued', 4: 'expired' };

app.get('/api/health', (req, res) => res.json({ ok: true, mock: MOCK }));

app.post('/api/scans', (req, res) => {
  const jobId = crypto.randomBytes(8).toString('hex');
  const raw = path.join(WORK, `${jobId}.in`);
  let size = 0, got = false, tooBig = false;
  let bb;
  try { bb = Busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD } }); }
  catch { return res.status(400).json({ error: 'Send the video as multipart form data.' }); }
  bb.on('file', (name, file) => {
    got = true;
    const out = fs.createWriteStream(raw);
    file.on('data', d => { size += d.length; });
    file.on('limit', () => { tooBig = true; });
    file.pipe(out);
  });
  bb.on('close', () => {
    if (!got) return res.status(400).json({ error: 'No video received.' });
    if (tooBig) { fs.rm(raw, { force: true }, () => {}); return res.status(413).json({ error: 'That video is too large. Keep it under 3 minutes.' }); }
    jobs.set(jobId, { state: 'preparing', created: Date.now() });
    res.json({ id: jobId });
    runJob(jobId, raw).catch(err => {
      console.error('job failed', jobId, err);
      jobs.set(jobId, { ...jobs.get(jobId), state: 'failed', error: friendly(err) });
    });
  });
  req.pipe(bb);
});

async function runJob(jobId, raw) {
  const mp4 = path.join(WORK, `${jobId}.mp4`);
  try {
    if (MOCK) {
      await sleep(1500);
      jobs.set(jobId, { ...jobs.get(jobId), state: 'queued', serialize: 'mock-' + jobId, mockStart: Date.now() });
      return;
    }
    // KIRI accepts at most 1920x1080 and 3 minutes. Phones often record 4K, so shrink first.
    const t0 = Date.now();
    console.log(`[${jobId}] preparing ${(fs.statSync(raw).size / 1048576).toFixed(0)} MB video`);
    await transcode(raw, mp4);
    console.log(`[${jobId}] resized in ${((Date.now() - t0) / 1000).toFixed(0)} s (${(fs.statSync(mp4).size / 1048576).toFixed(0)} MB)`);
    jobs.set(jobId, { ...jobs.get(jobId), state: 'sending' });
    const t1 = Date.now();
    const form = new FormData();
    form.append('isMesh', '1');
    form.append('isMask', '0');
    form.append('fileFormat', 'glb');
    form.append('videoFile', await fs.openAsBlob(mp4, { type: 'video/mp4' }), 'room.mp4');
    const r = await fetch(`${KIRI}/3dgs/video`, { method: 'POST', headers: { Authorization: `Bearer ${KIRI_KEY}` }, body: form });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok || !j.data?.serialize) throw new Error(`KIRI upload refused: ${j.msg || r.status}`);
    console.log(`[${jobId}] sent to KIRI in ${((Date.now() - t1) / 1000).toFixed(0)} s, scan id ${j.data.serialize}`);
    jobs.set(jobId, { ...jobs.get(jobId), state: 'queued', serialize: j.data.serialize });
  } finally {
    fs.rm(raw, { force: true }, () => {});
    fs.rm(mp4, { force: true }, () => {});
  }
}

// Is the video portrait once the phone's rotation flag is applied?
function probePortrait(input) {
  return new Promise(resolve => {
    const p = spawn(ffmpegPath, ['-hide_banner', '-i', input], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = ''; p.stderr.on('data', d => { err += d; });
    p.on('close', () => {
      const m = err.match(/Video:.*?(\d{3,5})x(\d{3,5})/); if (!m) return resolve(false);
      let w = +m[1], h = +m[2];
      const rot = err.match(/rotat\w*[^\d-]*(-?\d+(?:\.\d+)?)/i);
      if (rot && Math.abs(Math.round(+rot[1])) % 180 === 90) [w, h] = [h, w];
      resolve(h > w);
    });
  });
}

async function transcode(input, output) {
  // KIRI accepts at most 1920x1080, so portrait clips are turned sideways (reconstruction does not care which way is up).
  const portrait = await probePortrait(input);
  return new Promise((resolve, reject) => {
    const args = ['-y', '-i', input, '-t', '175',
      '-vf', `fps=30,${portrait ? 'transpose=1,' : ''}scale=w=1920:h=1080:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '22', '-threads', '0', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', output];
    const p = spawn(ffmpegPath, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => { err = (err + d).slice(-2000); });
    p.on('close', code => code === 0 ? resolve() : reject(new Error('Could not read that video file. ' + err.split('\n').slice(-3).join(' '))));
  });
}

// Status: accepts our job id (while preparing) or KIRI's id (serialize) afterwards.
app.get('/api/scans/:id', async (req, res) => {
  const id = req.params.id;
  const job = jobs.get(id);
  if (job && !job.serialize) return res.json({ state: job.state, error: job.error || null });
  if (!job && /^[0-9a-f]{16}$/.test(id)) return res.json({ state: 'lost', error: 'The server restarted before your video reached the 3D service. Please upload it again.' });
  const serialize = job?.serialize || id;
  try {
    if (serialize.startsWith('mock-')) {
      const j = [...jobs.values()].find(x => x.serialize === serialize);
      const t = j ? (Date.now() - j.mockStart) / 1000 : 99;
      return res.json({ state: t < 6 ? 'queued' : t < 18 ? 'processing' : 'ready', serialize });
    }
    const r = await kiri(`/model/getStatus?serialize=${encodeURIComponent(serialize)}`);
    const state = STATUS[r.data?.status] || 'processing';
    if (job && job.lastState !== state) { console.log(`[${serialize}] KIRI status: ${state}`); job.lastState = state; }
    res.json({ state, serialize });
  } catch (err) { res.status(502).json({ state: 'unknown', error: friendly(err), serialize }); }
});

// Model: download KIRI's zip once, pull out the GLB, cache it on disk and stream it back.
app.get('/api/scans/:serialize/model', async (req, res) => {
  const serialize = req.params.serialize.replace(/[^a-zA-Z0-9-]/g, '');
  const cached = path.join(WORK, `${serialize}.glb`);
  try {
    if (!fs.existsSync(cached)) {
      if (serialize.startsWith('mock-')) {
        const sample = findFile('sample-scan.glb'); if (!sample) throw new Error('sample-scan.glb is missing from the repository');
        await fsp.copyFile(sample, cached);
      } else {
        const r = await kiri(`/model/getModelZip?serialize=${encodeURIComponent(serialize)}`);
        const url = r.data?.modelUrl; if (!url) throw new Error('KIRI did not return a model link');
        const zipRes = await fetch(url); if (!zipRes.ok) throw new Error(`Model download failed (${zipRes.status})`);
        const zip = new AdmZip(Buffer.from(await zipRes.arrayBuffer()));
        const entries = zip.getEntries().filter(e => !e.isDirectory);
        const glb = entries.filter(e => /\.glb$/i.test(e.entryName)).sort((a, b) => b.header.size - a.header.size)[0];
        if (!glb) throw new Error('The scan has no GLB mesh. Check that "3DGS to Mesh" is enabled. Files: ' + entries.map(e => e.entryName).join(', '));
        await fsp.writeFile(cached, glb.getData());
      }
    }
    res.setHeader('Content-Type', 'model/gltf-binary');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(cached).pipe(res);
  } catch (err) { res.status(502).json({ error: friendly(err) }); }
});

async function kiri(p) {
  const r = await fetch(KIRI + p, { headers: { Authorization: `Bearer ${KIRI_KEY}` } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(`KIRI: ${j.msg || r.status}`);
  return j;
}
function friendly(err) { return String(err?.message || err).slice(0, 300); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Drop in-memory jobs after a day.
setInterval(() => { const cut = Date.now() - 864e5; for (const [k, v] of jobs) if (v.created < cut) jobs.delete(k); }, 36e5).unref();

app.listen(PORT, () => console.log(`Opus Home Twin on :${PORT}${MOCK ? ' (mock mode: no KIRI key set)' : ''}`));
