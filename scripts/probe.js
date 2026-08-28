#!/usr/bin/env node
// Faz 0 kesif script'i — plandaki 5 adimi olcer, Markdown rapor basar.
// Kullanim: node scripts/probe.js > docs/DATA-SOURCES.md
//
// ⛔ *.key dosyalarinin ICERIGI OKUNMAZ — yalnizca ad/boyut sayilir.
// ⛔ Hicbir sey yazilmaz, silinmez. Tamamen salt okunur.

const fs = require('fs');
const path = require('path');
const os = require('os');

const HOME = os.homedir();
const CLAUDE = path.join(HOME, '.claude');
const SESSIONS = path.join(CLAUDE, 'sessions');
const PROJECTS = path.join(CLAUDE, 'projects');

const out = [];
const say = (s) => out.push(s === undefined ? '' : s);

function safe(fn, fallback) {
  try { return fn(); } catch (e) { return fallback; }
}

// Uzun degerleri kisalt, gizli olabilecek alanlari maskele
const GIZLI = /token|secret|key|password|socket|pipe/i;
function ozetDeger(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `[${v.length} eleman] ${JSON.stringify(v).slice(0, 60)}`;
  if (typeof v === 'object') return `{${Object.keys(v).join(', ')}}`;
  const s = String(v);
  return s.length > 70 ? s.slice(0, 70) + '…' : s;
}

say('# DATA-SOURCES.md — Faz 0 kesif bulgulari');
say();
say(`Uretildi: \`node scripts/probe.js\` · makine: win32 · node ${process.version}`);
say('Bu dosya OLCUMDUR. Claude Code bu formatlari degistirebilir; degistiginde script tekrar kosulur.');
say();

// ---------------------------------------------------------------- Adim 1
say('## 1. `~/.claude/sessions/` — Claude Code\'un kendi registry\'si');
say();
const sessFiles = safe(() => fs.readdirSync(SESSIONS), []);
const jsonFiles = sessFiles.filter((f) => f.endsWith('.json'));
const keyFiles = sessFiles.filter((f) => f.endsWith('.key'));
const digerFiles = sessFiles.filter((f) => !f.endsWith('.json') && !f.endsWith('.key'));

say(`| Tur | Adet |`);
say(`|---|---|`);
say(`| \`<PID>.json\` | ${jsonFiles.length} |`);
say(`| \`<PID>.<hash>.key\` | ${keyFiles.length} |`);
say(`| diger | ${digerFiles.length}${digerFiles.length ? ' — ' + digerFiles.join(', ') : ''} |`);
say();
say('⛔ `.key` dosyalarinin icerigi OKUNMADI (izin siniri). Ad kalibi: `<PID>.<64 hane hex>.key`.');
say();

const BEKLENEN = ['pid', 'sessionId', 'cwd', 'startedAt', 'kind', 'entrypoint'];
const kayitlar = [];
for (const f of jsonFiles) {
  const j = safe(() => JSON.parse(fs.readFileSync(path.join(SESSIONS, f), 'utf8')), null);
  if (j) kayitlar.push({ file: f, j });
}

say('### Beklenen alanlar var mi');
say();
say('| Alan | Kac kayitta var (' + kayitlar.length + ' kayit) |');
say('|---|---|');
for (const alan of BEKLENEN) {
  const n = kayitlar.filter((k) => k.j[alan] !== undefined).length;
  say(`| \`${alan}\` | ${n}/${kayitlar.length} ${n === kayitlar.length ? '✅' : '⚠️'} |`);
}
const nameVar = kayitlar.filter((k) => k.j.name !== undefined).length;
say(`| \`name\` (monitor.js bunu ariyor) | ${nameVar}/${kayitlar.length} ${nameVar ? '✅' : '❌ HIC YOK'} |`);
say();

if (kayitlar.length) {
  say('### Ornek kayit (tum alanlar, uzun/gizli degerler kisaltildi)');
  say();
  say('| Alan | Deger |');
  say('|---|---|');
  const ornek = kayitlar[0].j;
  for (const [k, v] of Object.entries(ornek)) {
    const gizli = GIZLI.test(k);
    say(`| \`${k}\` | ${gizli ? '⛔ maskelendi (' + typeof v + ')' : '`' + ozetDeger(v) + '`'} |`);
  }
  say();
  say('Beklenmeyen ek alanlar: ' + (Object.keys(ornek).filter((k) => !BEKLENEN.includes(k)).join(', ') || 'yok'));
  say();
}

say('### `entrypoint` degerleri — VS Code / CLI ayrimi buradan');
say();
const epSayim = {};
for (const k of kayitlar) {
  const key = `${k.j.entrypoint || '(yok)'} / kind=${k.j.kind || '(yok)'}`;
  epSayim[key] = (epSayim[key] || 0) + 1;
}
say('| `entrypoint` / `kind` | Adet |');
say('|---|---|');
for (const [k, v] of Object.entries(epSayim)) say(`| \`${k}\` | ${v} |`);
say();

// ---------------------------------------------------------------- Adim 5
say('## 5. Ayni workspace\'te kac kayit olusuyor');
say();
const cwdGrup = {};
for (const k of kayitlar) {
  const c = k.j.cwd || '(yok)';
  cwdGrup[c] = cwdGrup[c] || [];
  cwdGrup[c].push(k.j.sessionId ? k.j.sessionId.slice(0, 8) : '(sessionId yok)');
}
say('| cwd | kayit | sessionId (kisa) |');
say('|---|---|---|');
for (const [c, ids] of Object.entries(cwdGrup)) {
  say(`| \`${path.basename(c)}\` | ${ids.length} | ${ids.join(', ')} |`);
}
say();
const cokKayitli = Object.values(cwdGrup).filter((v) => v.length > 1).length;
say(cokKayitli
  ? `✅ Ayni cwd icin **birden fazla** kayit olusuyor (${cokKayitli} workspace'te) → registry session bazli, state dosyasi proje bazli oldugu icin eziliyor.`
  : '⚠️ Su an her cwd icin tek kayit var — 2 sohbet acip tekrar kosulmali.');
say();

// ---------------------------------------------------------------- Adim 2
say('## 2. `sessions-index.json` var mi');
say();
const projeDizinleri = safe(() => fs.readdirSync(PROJECTS), []);
const indexBulunan = [];
for (const d of projeDizinleri) {
  const p = path.join(PROJECTS, d, 'sessions-index.json');
  if (fs.existsSync(p)) indexBulunan.push({ dir: d, p });
}
// plandaki beklenen konum: projects/-/sessions-index.json
const kokIndex = path.join(PROJECTS, '-', 'sessions-index.json');
say(`Plandaki beklenen konum \`projects/-/sessions-index.json\`: ${fs.existsSync(kokIndex) ? '✅ VAR' : '❌ YOK'}`);
say(`\`projects/*/sessions-index.json\` bulunan dizin sayisi: **${indexBulunan.length}** / ${projeDizinleri.length}`);
say();
if (indexBulunan.length) {
  const ilk = indexBulunan[0];
  const j = safe(() => JSON.parse(fs.readFileSync(ilk.p, 'utf8')), null);
  say(`Ornek: \`projects/${ilk.dir}/sessions-index.json\``);
  say();
  if (j) {
    say('| Ust alan | Deger |');
    say('|---|---|');
    for (const [k, v] of Object.entries(j)) say(`| \`${k}\` | ${ozetDeger(v)} |`);
    say();
    const girisler = j.entries || j.sessions || (Array.isArray(j) ? j : null);
    if (girisler && girisler.length) {
      say('Bir girisin alanlari:');
      say();
      say('| Alan | Ornek deger |');
      say('|---|---|');
      for (const [k, v] of Object.entries(girisler[0])) {
        say(`| \`${k}\` | \`${ozetDeger(v)}\` |`);
      }
      say();
      say(`Toplam giris: ${girisler.length}. \`firstPrompt\` tasiyan: ${girisler.filter((e) => e.firstPrompt).length}`);
    } else {
      say('⚠️ Giris dizisi bulunamadi — sema beklenenden farkli.');
    }
  } else {
    say('🔴 Dosya parse edilemedi.');
  }
  say();
}

// ---------------------------------------------------------------- Adim 3
say('## 3. JSONL icinde `ai-title`');
say();

// Plandaki oneri: dosyanin basindan 4 KB, sonundan 8 KB oku.
function parcaOku(dosya, basBayt, sonBayt) {
  const fd = fs.openSync(dosya, 'r');
  try {
    const boyut = fs.fstatSync(fd).size;
    const bas = Buffer.alloc(Math.min(basBayt, boyut));
    fs.readSync(fd, bas, 0, bas.length, 0);
    let son = Buffer.alloc(0);
    if (boyut > basBayt) {
      const uzunluk = Math.min(sonBayt, boyut - basBayt);
      son = Buffer.alloc(uzunluk);
      fs.readSync(fd, son, 0, uzunluk, boyut - uzunluk);
    }
    return { boyut, bas: bas.toString('utf8'), son: son.toString('utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

function satirlar(metin, kismiBasiAt, kismiSonuAt) {
  const p = metin.split('\n');
  if (kismiSonuAt) p.pop();
  if (kismiBasiAt) p.shift();
  return p.filter((s) => s.trim().startsWith('{'));
}

// En yeni 6 JSONL dosyasini bul
const jsonlListe = [];
for (const d of projeDizinleri) {
  const dir = path.join(PROJECTS, d);
  const files = safe(() => fs.readdirSync(dir), []).filter((f) => f.endsWith('.jsonl'));
  for (const f of files) {
    const st = safe(() => fs.statSync(path.join(dir, f)), null);
    if (st) jsonlListe.push({ dir: d, file: f, p: path.join(dir, f), mtime: st.mtimeMs, size: st.size });
  }
}
jsonlListe.sort((a, b) => b.mtime - a.mtime);
say(`Toplam JSONL: **${jsonlListe.length}** · en buyuk: ${(Math.max(...jsonlListe.map((x) => x.size)) / 1048576).toFixed(1)} MB · ortalama: ${(jsonlListe.reduce((a, x) => a + x.size, 0) / jsonlListe.length / 1024).toFixed(0)} KB`);
say();
say('| JSONL (en yeni 6) | Boyut | `ai-title` nerede | Baslik | Ilk meta-olmayan user mesaji |');
say('|---|---|---|---|---|');

const AI_TITLE_ALAN = new Set();
for (const j of jsonlListe.slice(0, 6)) {
  const { boyut, bas, son } = parcaOku(j.p, 4096, 8192);
  const basSatir = satirlar(bas, false, true);
  const sonSatir = satirlar(son, true, false);

  let nerede = [];
  let baslik = null;
  const tara = (arr, etiket) => {
    for (const s of arr) {
      const o = safe(() => JSON.parse(s), null);
      if (!o) continue;
      if (o.type === 'ai-title' || o.aiTitle || o.title) {
        nerede.push(etiket);
        Object.keys(o).forEach((k) => AI_TITLE_ALAN.add(k));
        baslik = o.aiTitle || o.title || baslik;
      }
    }
  };
  tara(basSatir, 'bas');
  tara(sonSatir, 'son');

  // Ilk meta olmayan user mesaji
  let ilkUser = null;
  for (const s of basSatir) {
    const o = safe(() => JSON.parse(s), null);
    if (!o || o.type !== 'user' || o.isMeta) continue;
    let icerik = o.message && o.message.content;
    if (Array.isArray(icerik)) icerik = icerik.map((c) => c.text || '').join(' ');
    if (typeof icerik !== 'string' || !icerik.trim()) continue;
    if (icerik.trim().startsWith('<')) continue;          // <command-name>, <ide_selection> vs.
    if (/^Caveat: The messages below/.test(icerik)) continue;
    ilkUser = icerik.replace(/\s+/g, ' ').slice(0, 45);
    break;
  }

  const kisa = (s) => (s ? String(s).replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 45) : '—');
  say(`| \`${j.file.slice(0, 8)}…\` | ${(j.size / 1024).toFixed(0)} KB | ${nerede.length ? [...new Set(nerede)].join('+') : '❌ yok'} | ${kisa(baslik)} | ${kisa(ilkUser)} |`);
}
say();
if (AI_TITLE_ALAN.size) {
  say('`ai-title` satirinda gorulen alanlar: ' + [...AI_TITLE_ALAN].map((k) => '`' + k + '`').join(', '));
} else {
  say('❌ Taranan parcalarda `ai-title` satiri BULUNAMADI — tum dosyayi taramak gerekebilir (asagidaki tam tarama).');
}
say();

// Tam tarama: en yeni 3 dosyada ai-title satirinin dosya icindeki KONUMU
say('### `ai-title` satirinin dosya icindeki konumu (en yeni 3 dosya, tam tarama)');
say();
say('| JSONL | Toplam satir | `ai-title` satir no | Baslik |');
say('|---|---|---|---|');
for (const j of jsonlListe.slice(0, 3)) {
  const icerik = safe(() => fs.readFileSync(j.p, 'utf8'), '');
  const sat = icerik.split('\n');
  let no = null, baslik = null;
  for (let i = 0; i < sat.length; i++) {
    if (sat[i].indexOf('ai-title') === -1 && sat[i].indexOf('aiTitle') === -1) continue;
    const o = safe(() => JSON.parse(sat[i]), null);
    if (o && (o.type === 'ai-title' || o.aiTitle)) { no = i + 1; baslik = o.aiTitle || null; break; }
  }
  say(`| \`${j.file.slice(0, 8)}…\` | ${sat.length} | ${no === null ? '❌ yok' : no + ' / ' + sat.length} | ${baslik ? String(baslik).replace(/\|/g, '\\|').slice(0, 40) : '—'} |`);
}
say();

// ---------------------------------------------------------------- cwd -> encoded dizin
say('## 4b. `cwd` → encoded dizin adi eslemesi (decode DENENMEZ, encode edilir)');
say();
say('Plan: `decodeDirName()` at, ters yonde calis. Asagidaki encode kurallari denendi:');
say();
const adaylar = {
  'abs.replace(/[/.]/g,"-")': (p) => p.replace(/[/.]/g, '-'),
  'abs.replace(/[\\\\/:._]/g,"-")': (p) => p.replace(/[\\/:._]/g, '-'),
  'abs.replace(/[\\\\/:._]/g,"-") + kucuk harf': (p) => p.replace(/[\\/:._]/g, '-').toLowerCase(),
};
const ornekCwd = kayitlar.length ? kayitlar[0].j.cwd : null;
if (ornekCwd) {
  say(`Ornek \`cwd\`: \`${ornekCwd}\``);
  say();
  say('| Kural | Uretilen | Dizin var mi |');
  say('|---|---|---|');
  for (const [ad, fn] of Object.entries(adaylar)) {
    const uretilen = fn(ornekCwd);
    const varMi = projeDizinleri.includes(uretilen);
    say(`| \`${ad}\` | \`${uretilen}\` | ${varMi ? '✅ VAR' : '❌ yok'} |`);
  }
  say();
  const dogru = projeDizinleri.filter((d) => d.toLowerCase().replace(/-/g, '') === ornekCwd.toLowerCase().replace(/[\\/:._-]/g, ''));
  say('Gercek dizin adi (tireler atilarak eslendi): ' + (dogru.length ? dogru.map((d) => '`' + d + '`').join(', ') : '⚠️ bulunamadi'));
}
say();
say('⚠️ Adim 4 (VS Code\'da elle yeniden adlandirma) bu script ile olculemez — kullanici bir oturumu elle');
say('yeniden adlandirdiktan sonra script tekrar kosulmali, `name` / `ai-title` satirlarindaki degisim karsilastirilmali.');
say();

process.stdout.write(out.join('\n') + '\n');
