#!/usr/bin/env node
// Claude Code Session Monitor — fork (ekrtp)
//
// Faz 1+2: satirlar artik OTURUM bazli ve basliklar gercek.
//   Satir kaynagi : ~/.claude/sessions/<PID>.json   (Claude Code'un registry'si, salt okunur)
//   Baslik        : ~/.claude/projects/<enc>/<sessionId>.jsonl -> ai-title
//   Durum         : ~/.claude/monitor/state/<sessionId>.json + eski konum (salt okunur)
//
// ⭐ HOOK GEREKTIRMEZ. settings.json'a dokunulmadan calisir; hook varsa durum
// bilgisi (working/waiting/done) daha kesin olur, yoksa JSONL hareketinden
// turetilir ve bu satirda ⚠️ ile isaretlenir.
//
// Kullanim:
//   node monitor.js            2 sn'de bir tazelenen tablo
//   node monitor.js --once     tek sefer bas ve cik (test icin)
//   node monitor.js --wide     tam session id
//   node monitor.js --flat     proje grubu yok, duz tablo
//   node monitor.js --all      bos sekmeler + bayat oturumlar dahil her sey
//   node monitor.js --since=4h son N sure icinde hareket eden oturumlar (vars. 4h)
// Ortam: NO_COLOR=1 renk yok · GLYPHS=emoji emoji isaretler
//
// ⚠️ Olculdu 2026-08-28: VS Code acilista eski sohbet sekmelerini geri yukluyor,
// her biri kendi claude process'ini ve registry kaydini olusturuyor (makinede 33
// canli kayit, 45 claude.exe). Bunlarin bir kismi HIC MESAJ GORMEMIS — JSONL
// dosyasi yok. Varsayilan gorunum onlari gizler, sayisini altta yazar.

const path = require('path');
const registry = require('./lib/registry');
const titles = require('./lib/titles');
const state = require('./lib/state');

const argv = process.argv.slice(2);
const TEK_SEFER = argv.includes('--once');
const GENIS = argv.includes('--wide');
const DUZ = argv.includes('--flat');
const HEPSI = argv.includes('--all');

// --since=90m | 4h | 2g  -> ms
function sureAyristir(varsayilan) {
  const a = argv.find((x) => x.startsWith('--since='));
  if (!a) return varsayilan;
  const m = /^(\d+)([mhg])$/.exec(a.slice(8).trim());
  if (!m) return varsayilan;
  const n = Number(m[1]);
  return n * (m[2] === 'm' ? 60000 : m[2] === 'h' ? 3600000 : 86400000);
}
const PENCERE_MS = sureAyristir(4 * 3600 * 1000);

const YENILEME_MS = 2000;
const TAZE_MS = 15000;        // JSONL bu sure icinde degistiyse "working" sayilir
const RENK_VAR = !process.env.NO_COLOR && (process.stdout.isTTY || TEK_SEFER);
const EMOJI = process.env.GLYPHS === 'emoji';

// --- Tema (Faz 3'te lib/themes.js'e tasinacak) ------------------------------
const PALET = {
  working: [122, 162, 247], thinking: [187, 154, 247], waiting: [247, 118, 142],
  done: [158, 206, 106], idle: [86, 95, 137], header: [192, 202, 245],
  dim: [86, 95, 137], accent: [224, 175, 104],
};
const R = RENK_VAR ? '\x1b[0m' : '';
const B = RENK_VAR ? '\x1b[1m' : '';
function renk(ad) {
  if (!RENK_VAR) return '';
  const c = PALET[ad] || PALET.dim;
  return `\x1b[38;2;${c[0]};${c[1]};${c[2]}m`;
}

const ISARET = EMOJI
  ? { working: '🔧', thinking: '🤔', waiting: '🔔', done: '✅', idle: '·' }
  : { working: '>>', thinking: '..', waiting: '!!', done: 'OK', idle: '--' };

// --- Genislik: ANSI at, emoji/CJK'yi 2 say --------------------------------
const ANSI = /\x1b\[[0-9;]*m/g;
function genislik(s) {
  let n = 0;
  for (const ch of String(s).replace(ANSI, '')) {
    const k = ch.codePointAt(0);
    const gen = (k >= 0x1100 && k <= 0x115f) || (k >= 0x2e80 && k <= 0xa4cf) ||
      (k >= 0xac00 && k <= 0xd7a3) || (k >= 0xf900 && k <= 0xfaff) ||
      (k >= 0xfe30 && k <= 0xfe6f) || (k >= 0xff00 && k <= 0xff60) ||
      (k >= 0x1f300 && k <= 0x1faff) || (k >= 0x2600 && k <= 0x27bf);
    n += gen ? 2 : 1;
  }
  return n;
}
function kirp(s, en) {
  s = String(s);
  if (genislik(s) <= en) return s;
  let cikti = '';
  for (const ch of s) {
    if (genislik(cikti + ch) > en - 1) break;
    cikti += ch;
  }
  return cikti + '…';
}
function doldur(s, en) {
  const k = kirp(s, en);
  return k + ' '.repeat(Math.max(0, en - genislik(k)));
}

function zamanKisa(ms) {
  if (!ms) return '—';
  const sn = Math.floor((Date.now() - ms) / 1000);
  if (sn < 60) return `${sn}s`;
  if (sn < 3600) return `${Math.floor(sn / 60)}d`;
  if (sn < 86400) return `${Math.floor(sn / 3600)}s`;
  return `${Math.floor(sn / 86400)}g`;
}

// --- Veri toplama ----------------------------------------------------------
function satirlariTopla() {
  const oturumlar = registry.canliOturumlar();
  const durumlar = state.durumHaritasi();

  const tum = oturumlar.map((o) => {
    const d = durumlar.get(o.sessionId);
    const b = titles.cozumle(o.sessionId, o.cwd, d && d.firstPrompt);
    const hareketMs = Math.max(b.mtimeMs || 0, (d && d.zaman) || 0);

    let durum, durumTuretildi = false;
    if (d && d.status) {
      durum = d.status;
    } else {
      durum = Date.now() - hareketMs < TAZE_MS ? 'working' : 'idle';
      durumTuretildi = true;
    }

    return {
      sessionId: o.sessionId,
      proje: o.cwd ? path.basename(o.cwd) : 'bilinmiyor',
      cwd: o.cwd,
      baslik: b.title,
      baslikKaynagi: b.source,
      durum,
      durumTuretildi,
      sonEylem: (d && d.lastAction) || '',
      rozet: o.entrypoint === 'cli' ? 'cli' : (o.entrypoint === 'claude-vscode' ? 'vsc' : (o.entrypoint || '?').slice(0, 3)),
      hareketMs,
      pid: o.pid,
      // JSONL yok -> oturum hic mesaj gormemis (bos sekme)
      bos: !b.jsonl,
    };
  }).sort((a, b) => {
    if (a.durum === 'waiting' && b.durum !== 'waiting') return -1;
    if (b.durum === 'waiting' && a.durum !== 'waiting') return 1;
    return b.hareketMs - a.hareketMs;
  });

  if (HEPSI) return { satirlar: tum, gizliBos: 0, gizliBayat: 0 };

  const bos = tum.filter((s) => s.bos);
  const dolu = tum.filter((s) => !s.bos);
  const taze = dolu.filter((s) => Date.now() - s.hareketMs < PENCERE_MS);
  return { satirlar: taze, gizliBos: bos.length, gizliBayat: dolu.length - taze.length };
}

// --- Cizim ----------------------------------------------------------------
function ciz() {
  const { satirlar, gizliBos, gizliBayat } = satirlariTopla();
  const en = Math.max(60, Math.min(process.stdout.columns || 100, 160));

  const SID = GENIS ? 37 : 9;
  const SABIT = { durum: 11, eylem: 13, rozet: 5, sid: SID, zaman: 5 };
  const projeEn = DUZ ? 16 : 0;
  const bosluk = 2 + (DUZ ? 1 : 0);
  const baslikEn = Math.max(18, en - 2 - projeEn - SABIT.durum - SABIT.eylem - SABIT.rozet - SABIT.sid - SABIT.zaman - bosluk - 5);

  const cizgi = renk('dim') + '─'.repeat(en - 4) + R;
  const out = [];
  const simdi = new Date().toLocaleTimeString('tr-TR');

  out.push(`  ${B}${renk('accent')}Claude Monitor${R}  ${renk('dim')}${simdi} · ${satirlar.length} oturum${R}`);
  out.push('  ' + cizgi);

  if (!satirlar.length) {
    out.push(`  ${renk('dim')}Bu pencerede gosterilecek oturum yok.` +
      `${gizliBos || gizliBayat ? ` (${gizliBos} bos sekme, ${gizliBayat} bayat — --all ile gor)` : ''}${R}`);
    return out.join('\n');
  }

  const basSatiri = (girinti) =>
    `  ${B}${renk('header')}${girinti}${doldur('DURUM', SABIT.durum)} ${doldur('BASLIK', baslikEn)} ` +
    `${doldur('EYLEM', SABIT.eylem)} ${doldur('KYNK', SABIT.rozet)} ${doldur('SESSION', SABIT.sid)} ${doldur('SURE', SABIT.zaman)}${R}`;

  const satirCiz = (s, girinti) => {
    const c = renk(s.durum) || renk('idle');
    const isaret = ISARET[s.durum] || ISARET.idle;
    const dur = doldur(`${isaret} ${s.durum}${s.durumTuretildi ? '?' : ''}`, SABIT.durum);
    const bas = doldur(s.baslik, baslikEn);
    const eyl = doldur(s.sonEylem || '—', SABIT.eylem);
    const roz = doldur(`[${s.rozet}]`, SABIT.rozet);
    const sid = doldur(GENIS ? s.sessionId : s.sessionId.slice(0, 8), SABIT.sid);
    const sure = doldur(zamanKisa(s.hareketMs), SABIT.zaman);
    const vurgu = s.durum === 'waiting';
    const govde = `${girinti}${c}${dur}${R} ${vurgu ? B + c : ''}${bas}${R} ${renk('dim')}${eyl} ${roz} ${sid} ${sure}${R}`;
    return '  ' + govde + (vurgu ? `${B}${c} <- sen${R}` : '');
  };

  if (DUZ) {
    out.push(basSatiri(''));
    out.push('  ' + cizgi);
    for (const s of satirlar) out.push(satirCiz(s, doldur(s.proje, projeEn) + ' '));
  } else {
    // Faz 4: ayni projedeki oturumlari grupla — proje adi bir kez, altinda girintili satirlar
    const gruplar = new Map();
    for (const s of satirlar) {
      if (!gruplar.has(s.proje)) gruplar.set(s.proje, []);
      gruplar.get(s.proje).push(s);
    }
    out.push(basSatiri('  '));
    out.push('  ' + cizgi);
    for (const [proje, grup] of gruplar) {
      out.push(`  ${B}${renk('header')}${proje}${R}${renk('dim')} · ${grup.length} oturum${R}`);
      for (const s of grup) out.push(satirCiz(s, '  '));
    }
  }

  out.push('  ' + cizgi);
  const turetilen = satirlar.filter((s) => s.durumTuretildi).length;
  const kaynakSayim = {};
  for (const s of satirlar) kaynakSayim[s.baslikKaynagi] = (kaynakSayim[s.baslikKaynagi] || 0) + 1;
  const kaynakMetni = Object.entries(kaynakSayim).map(([k, v]) => `${k}:${v}`).join(' · ');
  const gizli = [];
  if (gizliBos) gizli.push(`${gizliBos} bos sekme`);
  if (gizliBayat) gizli.push(`${gizliBayat} bayat`);
  out.push(`  ${renk('dim')}baslik ${kaynakMetni}` +
    `${turetilen ? ` · ${turetilen} durum hook'suz turetildi (?)` : ''}` +
    `${gizli.length ? ` · gizli: ${gizli.join(', ')} (--all)` : ''}${R}`);
  if (!TEK_SEFER) out.push(`  ${renk('dim')}${YENILEME_MS / 1000} sn'de bir tazelenir · Ctrl+C ile cik${R}`);
  return out.join('\n');
}

// Titremesiz cizim: ekrani silme, imleci basa al ve satir sonlarini temizle
let oncekiSatirSayisi = 0;
function bas() {
  const metin = ciz();
  const satirSayisi = metin.split('\n').length;
  if (TEK_SEFER) {
    process.stdout.write(metin + '\n');
    return;
  }
  const temiz = metin.split('\n').map((s) => s + '\x1b[K').join('\n');
  process.stdout.write('\x1b[H' + temiz + '\x1b[K');
  if (satirSayisi < oncekiSatirSayisi) process.stdout.write('\n\x1b[J');
  oncekiSatirSayisi = satirSayisi;
}

if (TEK_SEFER) {
  bas();
} else {
  process.stdout.write('\x1b[2J');
  bas();
  const t = setInterval(bas, YENILEME_MS);
  process.stdout.on('resize', bas);
  process.on('SIGINT', () => {
    clearInterval(t);
    process.stdout.write('\x1b[?25h\n');
    process.exit(0);
  });
}
