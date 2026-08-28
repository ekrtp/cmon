// Faz 2 — baslik cozumleme. Tek public fonksiyon: cozumle(sessionId, cwd).
//
// Oncelik zinciri (docs/DATA-SOURCES.md olcumlerine gore REVIZE EDILDI):
//   1. JSONL icindeki {"type":"ai-title","aiTitle":"…"}          -> source: 'ai-title'
//   2. JSONL'deki ilk META OLMAYAN user mesaji                    -> source: 'first-prompt'
//   3. Hook state'inden gelen firstPrompt (varsa, cagiran verir)  -> source: 'hook'
//   4. Proje adi + kisa session id                                -> source: 'fallback'
//
// ⛔ Zincire GIRMEYENLER ve nedenleri:
//   - sessions/<PID>.json icindeki `name`: 33/33 nameSource="derived", degeri
//     "vscode-dd" gibi turetilmis cop (olculdu).
//   - sessions-index.json / firstPrompt: dosya makinede HIC YOK (0/8 dizin).
//
// ⛔ `grep`/`findstr` KULLANILMAZ — saf Node. (Plan: Claude Tower bu yuzden
//    Windows'ta sessizce bos basliklar gosteriyor.)
// ⚠️ JSONL'ler buyuk: olculdu, en buyugu 23,1 MB, ortalama ~1,9 MB. Tum dosya
//    BELLEGE ALINMAZ; bastan BAS_BAYT, sondan SON_BAYT okunur.

const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
// ⚠️ Olculdu 2026-08-28: ai-title 11. satirda ama ILK 8 KB'IN DISINDA kaliyor —
// JSONL satirlari buyuk (sistem hatirlaticilari, uzun user mesajlari). 8 KB ile
// deneyen surum basligi bulamayip fallback'e dustu. 128 KB ile bulunuyor.
// Maliyet onbellekle odeniyor: ai-title bir kez bulununca KALICI saklanir,
// dosya buyumeye devam etse bile yeniden okunmaz.
const BAS_BAYT = 128 * 1024;
const SON_BAYT = 16 * 1024;
const NEGATIF_TEKRAR_MS = 15000; // baslik bulunamadiysa en fazla bu sikligla dene

// sessionId -> { title, source, mtimeMs, jsonl }
const onbellek = new Map();
// cwd -> proje dizini (encode sonucu). Dizin adi degismez, kalici onbellek.
const dizinOnbellek = new Map();

// ✅ Olculdu: cwd "c:\Users\…\Documents\VSCode" -> "c--Users-…-Documents-VSCode"
// Buyuk-kucuk harf KORUNUYOR. Ters yon (decode) DENENMEZ: klasor adindaki
// gercek tireler geri getirilemez (upstream'in decodeDirName bug'i).
function encodeYol(abs) {
  return abs.replace(/[\\/:._]/g, '-');
}

// sessionId'ye ait JSONL dosyasinin yolu.
function jsonlBul(sessionId, cwd) {
  if (cwd) {
    let aday = dizinOnbellek.get(cwd);
    if (aday === undefined) {
      aday = encodeYol(cwd);
      dizinOnbellek.set(cwd, aday);
    }
    const p = path.join(PROJECTS_DIR, aday, sessionId + '.jsonl');
    if (fs.existsSync(p)) return p;
  }
  // Encode tutmadiysa tum proje dizinlerinde ara (nadir; sonuc onbellege girer)
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, d, sessionId + '.jsonl');
      if (fs.existsSync(p)) return p;
    }
  } catch (e) { /* yoksay */ }
  return null;
}

// Dosyanin basindan ve sonundan parca oku, kismi satirlari at.
function parcalariOku(dosya) {
  const fd = fs.openSync(dosya, 'r');
  try {
    const boyut = fs.fstatSync(fd).size;
    const basUz = Math.min(BAS_BAYT, boyut);
    const bas = Buffer.alloc(basUz);
    fs.readSync(fd, bas, 0, basUz, 0);

    let son = '';
    if (boyut > basUz) {
      const sonUz = Math.min(SON_BAYT, boyut - basUz);
      const b = Buffer.alloc(sonUz);
      fs.readSync(fd, b, 0, sonUz, boyut - sonUz);
      son = b.toString('utf8');
    }

    const basSatir = bas.toString('utf8').split('\n');
    if (boyut > basUz) basSatir.pop();     // son satir yarim
    const sonSatir = son ? son.split('\n') : [];
    if (sonSatir.length) sonSatir.shift(); // ilk satir yarim

    return { basSatir, sonSatir };
  } finally {
    fs.closeSync(fd);
  }
}

function jsonAyristir(satir) {
  const s = satir.trim();
  if (!s || s[0] !== '{') return null;
  try { return JSON.parse(s); } catch (e) { return null; }
}

// Bir user turn'unun BASLIK OLMAYA UYGUN olup olmadigi.
// Claude Code IDE bildirimlerini, slash-command uyarilarini ve arac ciktilarini
// <tag>…</tag> sarmali user turn'leri olarak yaziyor ve/veya isMeta isaretliyor.
function metaMi(o, metin) {
  if (o.isMeta === true || o.isSidechain === true || o.isCompactSummary === true) return true;
  if (!metin) return true;
  const t = metin.trim();
  if (!t) return true;
  if (t[0] === '<') return true;                              // <command-name>, <ide_selection>, <local-command-…>
  if (/^Caveat: The messages below/.test(t)) return true;
  if (/^\[Request interrupted/.test(t)) return true;
  if (/^This session is being continued/.test(t)) return true;
  return false;
}

function icerigiMetneCevir(mesaj) {
  if (!mesaj) return '';
  const c = mesaj.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    // tool_result bloklarini alma; yalnizca duz metin
    return c.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
            .map((b) => b.text).join(' ');
  }
  return '';
}

// Parcalar icinde zinciri uygula.
function parcalardanBaslik(jsonl) {
  const { basSatir, sonSatir } = parcalariOku(jsonl);

  // 1. ai-title — olculdu: dosyanin BASINDA (11/96). Yine de iki parcaya da bak.
  for (const grup of [basSatir, sonSatir]) {
    for (const satir of grup) {
      if (satir.indexOf('ai-title') === -1 && satir.indexOf('aiTitle') === -1) continue;
      const o = jsonAyristir(satir);
      if (o && typeof o.aiTitle === 'string' && o.aiTitle.trim()) {
        return { title: o.aiTitle.trim(), source: 'ai-title' };
      }
    }
  }

  // 2. Ilk meta olmayan user mesaji
  for (const satir of basSatir) {
    const o = jsonAyristir(satir);
    if (!o || o.type !== 'user') continue;
    const metin = icerigiMetneCevir(o.message);
    if (metaMi(o, metin)) continue;
    return { title: metin.replace(/\s+/g, ' ').trim(), source: 'first-prompt' };
  }

  return null;
}

// Public. ekBaslik: hook state'inden gelen firstPrompt (opsiyonel).
function cozumle(sessionId, cwd, ekBaslik) {
  if (!sessionId) return { title: null, source: 'yok' };

  const jsonl = jsonlBul(sessionId, cwd);
  let mtimeMs = 0;
  if (jsonl) {
    try { mtimeMs = fs.statSync(jsonl).mtimeMs; } catch (e) { mtimeMs = 0; }
  }

  // Onbellek: JSONL dokunulmadiysa yeniden ayristirma (plan: her render'da
  // 20 dosya parse etmek istemiyoruz). ai-title sonradan geldiginde mtime
  // degisecegi icin onbellek kendini tazeliyor.
  const eski = onbellek.get(sessionId);
  if (eski && eski.jsonl === jsonl) {
    // ai-title bulunmussa kalici: dosya buyudu diye 128 KB'i tekrar okumayiz
    if (eski.source === 'ai-title') return { title: eski.title, source: eski.source, mtimeMs, jsonl };
    // Zayif baslik (first-prompt/hook/fallback): dosya degismediyse ya da son
    // denemeden bu yana NEGATIF_TEKRAR_MS gecmediyse yeniden ayristirma
    const tazeDeneme = Date.now() - (eski.sonDeneme || 0) < NEGATIF_TEKRAR_MS;
    if (eski.title && (eski.mtimeMs === mtimeMs || tazeDeneme)) {
      return { title: eski.title, source: eski.source, mtimeMs, jsonl };
    }
  }

  let sonuc = null;
  if (jsonl) {
    try { sonuc = parcalardanBaslik(jsonl); } catch (e) { sonuc = null; }
  }

  // 3. Hook state'inin firstPrompt'u
  if (!sonuc && ekBaslik && String(ekBaslik).trim()) {
    sonuc = { title: String(ekBaslik).replace(/\s+/g, ' ').trim(), source: 'hook' };
  }

  // 4. Proje adi + kisa id
  if (!sonuc) {
    const proje = cwd ? path.basename(cwd) : 'bilinmiyor';
    sonuc = { title: `${proje} · ${sessionId.slice(0, 8)}`, source: 'fallback' };
  }

  onbellek.set(sessionId, { ...sonuc, mtimeMs, jsonl, sonDeneme: Date.now() });
  // mtimeMs/jsonl da donuyor: cagiran ikinci bir stat cagirmasin (jsonl yoksa
  // oturum hic mesaj gormemis demektir — bos sekme).
  return { ...sonuc, mtimeMs, jsonl };
}

// JSONL son degisim zamani — "TIME" kolonu icin hook'suz aktiflik sinyali.
function sonHareket(sessionId, cwd) {
  const jsonl = jsonlBul(sessionId, cwd);
  if (!jsonl) return 0;
  try { return fs.statSync(jsonl).mtimeMs; } catch (e) { return 0; }
}

// _parcalardanBaslik: test icin acildi (test/run.js fixture'lari uzerinde kosar)
module.exports = { cozumle, sonHareket, encodeYol, jsonlBul, PROJECTS_DIR, _parcalardanBaslik: parcalardanBaslik };
