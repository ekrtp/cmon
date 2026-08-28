#!/usr/bin/env node
// Kesif 2 — "elimizde baska hangi bilgi var?" sorusunun olcumu.
// ⛔ SALT OKUNUR. Icerik BASILMAZ: yalnizca alan ADLARI, tipleri ve sayimlar.
// Kullanim: node scripts/probe-fields.js

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE = path.join(os.homedir(), '.claude');
const PROJECTS = path.join(CLAUDE, 'projects');

function guvenli(fn, y) { try { return fn(); } catch (e) { return y; } }

// --- 1. JSONL satir tipleri ve alanlari -----------------------------------
const jsonlListe = [];
for (const d of guvenli(() => fs.readdirSync(PROJECTS), [])) {
  for (const f of guvenli(() => fs.readdirSync(path.join(PROJECTS, d)), [])) {
    if (!f.endsWith('.jsonl')) continue;
    const p = path.join(PROJECTS, d, f);
    const st = guvenli(() => fs.statSync(p), null);
    if (st) jsonlListe.push({ p, mtime: st.mtimeMs, size: st.size });
  }
}
jsonlListe.sort((a, b) => b.mtime - a.mtime);

const tipSayim = {};
const ustAlanlar = {};        // alan -> sayim
const mesajAlanlari = {};     // message.* -> sayim
const usageAlanlari = {};
const modelSayim = {};
const gitBranchVar = new Set();
const aracSayim = {};
let toplamSatir = 0, bozukSatir = 0;

// En yeni 8 dosyanin ilk 512 KB'i — icerik degil sema tariyoruz
for (const j of jsonlListe.slice(0, 8)) {
  const fd = fs.openSync(j.p, 'r');
  const uz = Math.min(512 * 1024, j.size);
  const buf = Buffer.alloc(uz);
  fs.readSync(fd, buf, 0, uz, 0);
  fs.closeSync(fd);
  const satirlar = buf.toString('utf8').split('\n');
  satirlar.pop();
  for (const s of satirlar) {
    if (!s.trim().startsWith('{')) continue;
    toplamSatir++;
    let o;
    try { o = JSON.parse(s); } catch (e) { bozukSatir++; continue; }
    const t = o.type || '(tipsiz)';
    tipSayim[t] = (tipSayim[t] || 0) + 1;
    for (const k of Object.keys(o)) ustAlanlar[k] = (ustAlanlar[k] || 0) + 1;
    if (o.gitBranch) gitBranchVar.add(o.gitBranch);
    if (o.message && typeof o.message === 'object') {
      for (const k of Object.keys(o.message)) mesajAlanlari[k] = (mesajAlanlari[k] || 0) + 1;
      if (o.message.model) modelSayim[o.message.model] = (modelSayim[o.message.model] || 0) + 1;
      if (o.message.usage) for (const k of Object.keys(o.message.usage)) usageAlanlari[k] = (usageAlanlari[k] || 0) + 1;
      const c = o.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b && b.type === 'tool_use' && b.name) aracSayim[b.name] = (aracSayim[b.name] || 0) + 1;
        }
      }
    }
  }
}

const tablo = (baslik, obj, limit) => {
  console.log(`\n### ${baslik}`);
  const g = Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, limit || 40);
  if (!g.length) { console.log('  (yok)'); return; }
  for (const [k, v] of g) console.log(`  ${String(v).padStart(6)}  ${k}`);
};

console.log(`# Kesif 2 — kullanilabilir alanlar`);
console.log(`\nTaranan: ${Math.min(8, jsonlListe.length)} JSONL · ${toplamSatir} satir · ${bozukSatir} ayristirilamayan`);
tablo('JSONL satir tipleri (type)', tipSayim);
tablo('Ust seviye alanlar', ustAlanlar);
tablo('message.* alanlari', mesajAlanlari);
tablo('message.usage.* (token sayaclari)', usageAlanlari);
tablo('Model degerleri', modelSayim);
tablo('En cok kullanilan araclar (tool_use.name)', aracSayim, 12);
console.log(`\n### gitBranch\n  ${gitBranchVar.size} farkli deger${gitBranchVar.size ? ': ' + [...gitBranchVar].slice(0, 6).join(', ') : ''}`);

// --- 2. Hook state dosyalarindaki status sozlugu ---------------------------
const eskiDir = path.join(CLAUDE, 'claude-monitor-status');
const statusSayim = {}, stateAlan = {};
for (const f of guvenli(() => fs.readdirSync(eskiDir), [])) {
  if (!f.endsWith('.json')) continue;
  const o = guvenli(() => JSON.parse(fs.readFileSync(path.join(eskiDir, f), 'utf8')), null);
  if (!o) continue;
  if (o.status) statusSayim[o.status] = (statusSayim[o.status] || 0) + 1;
  for (const k of Object.keys(o)) stateAlan[k] = (stateAlan[k] || 0) + 1;
}
tablo('Mevcut hook state: status degerleri', statusSayim);
tablo('Mevcut hook state: alanlar', stateAlan);

// --- 3. ~/.claude altindaki diger olasi kaynaklar --------------------------
console.log('\n### ~/.claude altindaki diger kaynaklar');
const bakilacak = ['tasks', 'jobs', 'teams', 'scheduled-tasks', 'session-map.json', 'history.jsonl', 'ide', 'agent-dashboard'];
for (const b of bakilacak) {
  const p = path.join(CLAUDE, b);
  const st = guvenli(() => fs.statSync(p), null);
  if (!st) { console.log(`  ${b.padEnd(18)} yok`); continue; }
  if (st.isDirectory()) {
    const ic = guvenli(() => fs.readdirSync(p), []);
    console.log(`  ${b.padEnd(18)} dizin · ${ic.length} giris${ic.length ? ' · ornek: ' + ic.slice(0, 3).join(', ') : ''}`);
  } else {
    console.log(`  ${b.padEnd(18)} dosya · ${(st.size / 1024).toFixed(1)} KB`);
  }
}

// session-map.json ve history.jsonl semasi (yalnizca alan adlari)
const sm = guvenli(() => JSON.parse(fs.readFileSync(path.join(CLAUDE, 'session-map.json'), 'utf8')), null);
if (sm) {
  const ilkDeger = Array.isArray(sm) ? sm[0] : sm[Object.keys(sm)[0]];
  console.log(`\n  session-map.json: ${Array.isArray(sm) ? 'dizi' : 'nesne'} · ${Array.isArray(sm) ? sm.length : Object.keys(sm).length} giris` +
    (ilkDeger && typeof ilkDeger === 'object' ? ` · giris alanlari: ${Object.keys(ilkDeger).join(', ')}` : ` · deger tipi: ${typeof ilkDeger}`));
}
const hist = guvenli(() => fs.readFileSync(path.join(CLAUDE, 'history.jsonl'), 'utf8').split('\n').filter((s) => s.trim().startsWith('{')), []);
if (hist.length) {
  const o = guvenli(() => JSON.parse(hist[hist.length - 1]), null);
  console.log(`  history.jsonl: ${hist.length} satir · alanlar: ${o ? Object.keys(o).join(', ') : '?'}`);
}
// tasks/ semasi
const tasksDir = path.join(CLAUDE, 'tasks');
const tf = guvenli(() => fs.readdirSync(tasksDir), []).slice(0, 1);
if (tf.length) {
  const p = path.join(tasksDir, tf[0]);
  const st = guvenli(() => fs.statSync(p), null);
  if (st && st.isDirectory()) {
    console.log(`  tasks/${tf[0]}: dizin · icerik: ${guvenli(() => fs.readdirSync(p), []).slice(0, 5).join(', ')}`);
  }
}
