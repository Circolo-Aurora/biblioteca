/**
 * Biblioteca del Circolo ARCI Aurora (Leccio) — backend del catalogo
 * ===================================================================
 * Fase 1: catalogo pubblico, login dell'area riservata, inserimento libri.
 *
 * INSTALLAZIONE (una volta sola, dall'account della sagra)
 * 1. Crea un foglio Google vuoto, es. "Biblioteca Circolo Aurora".
 * 2. Estensioni → Apps Script. Cancella il contenuto, incolla questo file, salva.
 * 3. In alto scegli la funzione "setup" e premi ▶ Esegui. Concedi i permessi
 *    (Avanzate → Vai a … → Consenti). Il foglio si riempie con i tab:
 *      Libri     → il catalogo (si può correggere anche a mano)
 *      Prestiti  → richieste e prestiti (dalla fase 2)
 *      Desideri  → libri suggeriti dal sito (fase 4)
 *      Log       → ogni scrittura fatta dallo script
 *      Config    → elenco delle categorie/scaffali (menu a tendina nel tab Libri e filtri del sito)
 * 4. Impostazioni progetto (⚙) → Proprietà script → aggiungi:
 *      ADMIN_PASSWORD        password dell'area riservata
 *      EMAIL_BIBLIOTECARIA   chi riceve le richieste di prestito (servirà dalla fase 2)
 * 5. Distribuisci → Nuova distribuzione → tipo "Applicazione web":
 *      Esegui come: Me · Chi ha accesso: Chiunque
 *    Copia l'URL (finisce con /exec) in API_URL di index.html e admin.html.
 *
 * SE MODIFICHI QUESTO CODICE: Distribuisci → Gestisci distribuzioni → ✎ → Versione: Nuova → Distribuisci.
 * Così l'URL resta lo stesso e il sito usa la versione nuova.
 *
 * MODIFICHE A MANO: nel tab Libri si possono correggere i dati e cambiare lo stato.
 * Le colonne si leggono per nome, quindi l'ordine non conta, ma le intestazioni non vanno rinominate.
 * Il sito vede le modifiche subito (la cache si svuota a ogni modifica del foglio).
 */

// ---- Impostazioni ----------------------------------------------------------------

const FUSO = "Europe/Rome";
const DURATA_CACHE = 600;   // secondi di validità del catalogo in cache

const TAB = {
  Libri:    ["id", "isbn", "titolo", "autori", "editore", "anno", "categoria", "copertina", "trama", "stato", "data_inserimento"],
  Prestiti: ["id_prestito", "id_libro", "titolo", "nome", "email", "telefono", "data_richiesta", "data_ritiro", "data_restituzione", "stato", "scadenza"],
  Desideri: ["data", "titolo", "autore", "nota", "nome", "email", "stato"],
  Log:      ["timestamp", "azione", "id", "dettaglio"],
  Config:   ["categoria"]
};

// Provvisorie: si cambiano nel tab Config, non qui.
const CATEGORIE_INIZIALI = [
  "Albi illustrati", "Narrativa ragazzi", "Fantasy e avventura", "Fumetti e graphic novel",
  "Gialli e mistero", "Divulgazione", "Classici", "Narrativa adulti"
];

const STATI_LIBRO     = ["disponibile", "prenotato", "in prestito"];
const STATI_PRESTITO  = ["richiesto", "in prestito", "restituito", "annullato"];
const STATI_DESIDERIO = ["nuovo", "acquistato", "scartato"];

// Campi del tab Libri che il sito pubblico riceve
const CAMPI_PUBBLICI = ["id", "isbn", "titolo", "autori", "editore", "anno", "categoria", "copertina", "trama", "stato", "data_inserimento"];

// ---- Endpoint ----------------------------------------------------------------------

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (p.azione === "catalogo") {
      let json = cacheLeggi_("catalogo");
      if (!json) {
        json = JSON.stringify(catalogo_());
        cacheScrivi_("catalogo", json, DURATA_CACHE);
      }
      return json_('{"ok":true,' + json.slice(1));
    }
    if (p.azione === "esito") {
      // la pagina chiede la risposta di un invio (codice rid) quando quella diretta non le è arrivata
      const r = p.rid ? CacheService.getScriptCache().get("esito_" + String(p.rid).slice(0, 40)) : null;
      return risposta_({ ok: true, risposta: r ? JSON.parse(r) : null });
    }
    return risposta_({ ok: true, info: "Biblioteca del Circolo ARCI Aurora" });
  } catch (err) {
    return risposta_({ ok: false, errore: String(err.message || err) });
  }
}

// Il sito invia JSON come text/plain (evita il preflight CORS), con un campo "azione".
function doPost(e) {
  let d = {};
  try { d = JSON.parse(e.postData.contents); } catch (err) {}
  const rid = String(d.rid || "").slice(0, 40);
  let out;
  try {
    switch (d.azione) {
      case "login":         out = login_(d); break;
      case "aggiungiLibro": out = aggiungiLibro_(d); break;
      default: throw new Error("Azione non riconosciuta.");
    }
  } catch (err) {
    out = { ok: false, errore: String(err.message || err) };
  }
  const testo = JSON.stringify(out);
  if (rid) { try { CacheService.getScriptCache().put("esito_" + rid, testo, 21600); } catch (err) {} }
  return json_(testo);
}

// Trigger semplice: qualsiasi modifica a mano del foglio svuota la cache del catalogo.
function onEdit(e) {
  try { cacheSvuota_("catalogo"); } catch (err) {}
}

// ---- Azioni --------------------------------------------------------------------------

function catalogo_() {
  const libri = leggiTab_("Libri")
    .filter(r => String(r.titolo || "").trim())
    .map(r => {
      const o = {};
      CAMPI_PUBBLICI.forEach(k => { const v = formatta_(r[k]); if (v !== "") o[k] = v; });
      if (!o.stato) o.stato = "disponibile";
      return o;
    });
  return { libri: libri, categorie: categorie_() };
}

function login_(d) {
  verificaPassword_(d.password);
  return { ok: true, categorie: categorie_() };
}

function aggiungiLibro_(d) {
  verificaPassword_(d.password);
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error("Il foglio è occupato: riprova tra qualche secondo.");
  try {
    const titolo = pulisci_(d.titolo, 300);
    if (!titolo) throw new Error("Manca il titolo.");

    const isbn = d.isbn ? normalizzaIsbn_(d.isbn) : "";
    if (d.isbn && !isbn) throw new Error("ISBN non valido: controlla le cifre.");

    const categoria = pulisci_(d.categoria, 100);
    const categorie = categorie_();
    if (categorie.length && categorie.indexOf(categoria) < 0) throw new Error("Scegli una categoria dall'elenco.");

    const libri = leggiTab_("Libri");
    if (isbn && !d.forza) {
      const doppio = libri.find(r => String(r.isbn) === isbn);
      if (doppio) return { ok: false, duplicato: true, id: doppio.id, errore: "«" + doppio.titolo + "» è già in catalogo (" + doppio.id + ")." };
    }

    const id = prossimoId_(libri);
    scriviRiga_("Libri", {
      id: id,
      isbn: isbn,
      titolo: titolo,
      autori: pulisci_(d.autori, 300),
      editore: pulisci_(d.editore, 150),
      anno: pulisci_(d.anno, 10),
      categoria: categoria,
      copertina: /^https:\/\//.test(String(d.copertina || "")) ? pulisci_(d.copertina, 500) : "",
      trama: pulisci_(d.trama, 3000),
      stato: "disponibile",
      data_inserimento: new Date()
    });
    log_("aggiungiLibro", id, titolo);
    cacheSvuota_("catalogo");
    return { ok: true, id: id };
  } finally {
    lock.releaseLock();
  }
}

// ---- Setup ---------------------------------------------------------------------------

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.setSpreadsheetTimeZone(FUSO);

  Object.keys(TAB).forEach(nome => {
    const sh = ss.getSheetByName(nome) || ss.insertSheet(nome);
    if (!sh.getRange(1, 1).getValue()) sh.getRange(1, 1, 1, TAB[nome].length).setValues([TAB[nome]]);
    sh.getRange(1, 1, 1, sh.getLastColumn()).setFontWeight("bold");
    sh.setFrozenRows(1);
  });

  // Config: categorie iniziali
  const cfg = ss.getSheetByName("Config");
  if (cfg.getLastRow() < 2) cfg.getRange(2, 1, CATEGORIE_INIZIALI.length, 1).setValues(CATEGORIE_INIZIALI.map(c => [c]));

  // Libri: ISBN come testo, menu per categoria e stato
  const libri = ss.getSheetByName("Libri");
  colonna_(libri, "isbn").setNumberFormat("@");
  colonna_(libri, "data_inserimento").setNumberFormat("dd/mm/yyyy");
  colonna_(libri, "categoria").setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(cfg.getRange("A2:A"), true).setAllowInvalid(false).build());
  colonna_(libri, "stato").setDataValidation(menu_(STATI_LIBRO));

  // Prestiti: formati e menu prima, formula della scadenza per ultima
  const pre = ss.getSheetByName("Prestiti");
  ["data_richiesta", "data_ritiro", "data_restituzione", "scadenza"].forEach(c => colonna_(pre, c).setNumberFormat("dd/mm/yyyy"));
  colonna_(pre, "telefono").setNumberFormat("@");
  colonna_(pre, "stato").setDataValidation(menu_(STATI_PRESTITO));
  // scadenza = data_ritiro + 2 mesi, per tutte le righe, con una sola formula nell'intestazione.
  // (DATE invece di EDATE: EDATE non si espande dentro ARRAYFORMULA)
  const R = lettera_(pre, "data_ritiro"), col = R + ":" + R;
  pre.getRange(1, indice_(pre, "scadenza")).setFormula(
    '=ARRAYFORMULA(IF(ROW(' + col + ')=1,"scadenza",IF(' + col + '="",,DATE(YEAR(' + col + '),MONTH(' + col + ')+2,DAY(' + col + ')))))');

  colonna_(ss.getSheetByName("Desideri"), "stato").setDataValidation(menu_(STATI_DESIDERIO));
  colonna_(ss.getSheetByName("Log"), "timestamp").setNumberFormat("dd/mm/yyyy hh:mm:ss");

  // via il "Foglio1" vuoto creato con il file
  ss.getSheets().forEach(sh => {
    if (!TAB[sh.getName()] && sh.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(sh);
  });
  ss.setActiveSheet(libri);
  cacheSvuota_("catalogo");
}

// Da eseguire a mano se il sito mostra dati vecchi.
function svuotaCache() { cacheSvuota_("catalogo"); }

// Prova veloce dall'editor: quanti libri legge e quali categorie.
function prova() {
  const c = catalogo_();
  console.log(c.libri.length + " libri; categorie: " + c.categorie.join(", "));
  console.log("Password impostata: " + !!PropertiesService.getScriptProperties().getProperty("ADMIN_PASSWORD"));
}

// ---- Foglio ----------------------------------------------------------------------------

function tab_(nome) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(nome);
  if (!sh) throw new Error("Manca il tab " + nome + ": esegui setup.");
  return sh;
}

// Righe del tab come oggetti {intestazione: valore}
function leggiTab_(nome) {
  const valori = tab_(nome).getDataRange().getValues();
  const testa = valori.shift().map(h => String(h).trim());
  return valori.map(r => {
    const o = {};
    testa.forEach((h, i) => { if (h) o[h] = r[i]; });
    return o;
  });
}

// Aggiunge una riga mettendo ogni valore sotto l'intestazione con lo stesso nome
function scriviRiga_(nome, obj) {
  const sh = tab_(nome);
  const testa = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  let ultima = 0;
  const riga = testa.map((h, i) => { if (obj[h] !== undefined && obj[h] !== "") ultima = i + 1; return obj[h] === undefined ? "" : obj[h]; });
  sh.appendRow(riga.slice(0, Math.max(ultima, 1)));   // non tocca le colonne a destra (es. formule)
}

function log_(azione, id, dettaglio) {
  try { scriviRiga_("Log", { timestamp: new Date(), azione: azione, id: id, dettaglio: dettaglio }); } catch (err) { console.error(err); }
}

function categorie_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Config");
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0]).trim()).filter(String);
}

function prossimoId_(libri) {
  const max = libri.reduce((m, r) => {
    const n = /^L(\d+)$/.exec(String(r.id || ""));
    return n ? Math.max(m, Number(n[1])) : m;
  }, 0);
  return "L" + String(max + 1).padStart(4, "0");
}

// Colonna con quell'intestazione: vale anche se l'intestazione è prodotta da una formula
// (es. "scadenza") e la formula non ha ancora un risultato.
function indice_(sh, intestazione) {
  const riga = sh.getRange(1, 1, 1, sh.getLastColumn());
  const valori = riga.getValues()[0], formule = riga.getFormulas()[0];
  const i = valori.findIndex((v, k) => String(v).trim() === intestazione || formule[k].indexOf('"' + intestazione + '"') >= 0);
  if (i < 0) throw new Error("Nel tab " + sh.getName() + " manca la colonna " + intestazione);
  return i + 1;
}
function colonna_(sh, intestazione) { return sh.getRange(2, indice_(sh, intestazione), sh.getMaxRows() - 1, 1); }
function lettera_(sh, intestazione) { return sh.getRange(1, indice_(sh, intestazione)).getA1Notation().replace(/\d+/g, ""); }
function menu_(valori) { return SpreadsheetApp.newDataValidation().requireValueInList(valori, true).setAllowInvalid(false).build(); }

// ---- Utilità ----------------------------------------------------------------------------

function verificaPassword_(p) {
  const giusta = PropertiesService.getScriptProperties().getProperty("ADMIN_PASSWORD");
  if (!giusta) throw new Error("Password non impostata nelle proprietà dello script.");
  if (String(p || "") !== giusta) {
    Utilities.sleep(1500);   // rallenta i tentativi a caso
    throw new Error("Password errata.");
  }
}

// ISBN-10 o ISBN-13, con o senza trattini → ISBN-13 di sole cifre; "" se non valido.
function normalizzaIsbn_(v) {
  const s = String(v).toUpperCase().replace(/[^0-9X]/g, "");
  const cifra13 = b => (10 - b.split("").reduce((t, c, i) => t + Number(c) * (i % 2 ? 3 : 1), 0) % 10) % 10;
  if (/^\d{13}$/.test(s)) return cifra13(s.slice(0, 12)) === Number(s[12]) ? s : "";
  if (/^\d{9}[\dX]$/.test(s)) {
    const somma = s.split("").reduce((t, c, i) => t + (c === "X" ? 10 : Number(c)) * (10 - i), 0);
    if (somma % 11) return "";
    const base = "978" + s.slice(0, 9);
    return base + cifra13(base);
  }
  return "";
}

function pulisci_(v, max) {
  return String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max || 500);
}

function formatta_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, FUSO, "yyyy-MM-dd");
  return v == null ? "" : String(v).trim();
}

// La cache accetta valori fino a 100 KB: il catalogo si divide in pezzi.
function cacheLeggi_(chiave) {
  const c = CacheService.getScriptCache();
  const n = Number(c.get(chiave + "_n"));
  if (!n) return null;
  const chiavi = [];
  for (let i = 0; i < n; i++) chiavi.push(chiave + "_" + i);
  const parti = c.getAll(chiavi);
  if (chiavi.some(k => parti[k] == null)) return null;
  return chiavi.map(k => parti[k]).join("");
}
function cacheScrivi_(chiave, testo, secondi) {
  const PEZZO = 40000, valori = {};
  const n = Math.max(1, Math.ceil(testo.length / PEZZO));
  for (let i = 0; i < n; i++) valori[chiave + "_" + i] = testo.slice(i * PEZZO, (i + 1) * PEZZO);
  valori[chiave + "_n"] = String(n);
  try { CacheService.getScriptCache().putAll(valori, secondi); } catch (err) { console.warn("Cache non scritta: " + err); }
}
function cacheSvuota_(chiave) { CacheService.getScriptCache().remove(chiave + "_n"); }

function json_(testo) { return ContentService.createTextOutput(testo).setMimeType(ContentService.MimeType.JSON); }
function risposta_(obj) { return json_(JSON.stringify(obj)); }
