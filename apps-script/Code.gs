/**
 * Biblioteca del Circolo ARCI Aurora (Leccio) — backend del catalogo
 * ===================================================================
 * Fase 1: catalogo pubblico, login dell'area riservata, inserimento libri.
 * Fase 2: richieste di prestito dal sito, con mail alla bibliotecaria e conferma a chi chiede.
 *
 * Ricerca ISBN: il sito interroga Google Books e Open Library; il catalogo nazionale SBN passa da qui (azione "isbn").
 *
 * DOPO AVER INCOLLATO UNA VERSIONE NUOVA: esegui una volta "provaMail" e "provaIsbn" dall'editor e concedi
 * i permessi (inviare email, collegarsi a siti esterni), poi pubblica la nuova versione (vedi sotto).
 *
 * GESTIONE DEI PRESTITI NEL FOGLIO (tab Prestiti, colonna "stato"):
 *   richiesto   → la riga la crea il sito; il libro risulta "prenotato"
 *   in prestito → quando lo consegni; la data_ritiro si compila da sola, la scadenza si calcola
 *   restituito  → quando torna; data_restituzione automatica, il libro torna "disponibile"
 *   annullato   → se non viene ritirato; il libro torna "disponibile"
 * Lo stato del libro nel tab Libri si aggiorna da solo quando cambi questa colonna.
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
const NOME_MITTENTE = "Biblioteca del Circolo ARCI Aurora";   // nome che compare nelle mail
const URL_SITO = "https://circolo-aurora.github.io/biblioteca/";

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
    if (p.azione === "isbn") return risposta_(cercaSbn_(p.isbn));
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
  // stesso invio già registrato (es. doppio tocco): si restituisce la stessa risposta senza riscrivere
  const gia = rid ? CacheService.getScriptCache().get("esito_" + rid) : null;
  if (gia) return json_(gia);
  let out;
  try {
    switch (d.azione) {
      case "login":         out = login_(d); break;
      case "aggiungiLibro": out = aggiungiLibro_(d); break;
      case "richiesta":     out = richiesta_(d); break;
      default: throw new Error("Azione non riconosciuta.");
    }
  } catch (err) {
    out = { ok: false, errore: String(err.message || err) };
  }
  const testo = JSON.stringify(out);
  if (rid) { try { CacheService.getScriptCache().put("esito_" + rid, testo, 21600); } catch (err) {} }
  return json_(testo);
}

// Trigger semplice, a ogni modifica fatta a mano nel foglio:
// - svuota la cache del catalogo (il sito vede subito le correzioni);
// - se cambia lo stato di un prestito, aggiorna lo stato del libro e le date.
function onEdit(e) {
  try { cacheSvuota_("catalogo"); } catch (err) {}
  try {
    if (e && e.range && e.range.getSheet().getName() === "Prestiti") allineaPrestiti_(e.range);
  } catch (err) { console.error("onEdit: " + err); }
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

// Richiesta di prestito dal sito: riga nel tab Prestiti, libro "prenotato", mail a bibliotecaria e richiedente.
function richiesta_(d) {
  const nome = pulisci_(d.nome, 120), email = pulisci_(d.email, 200), telefono = pulisci_(d.telefono, 40);
  if (!nome || !email || !telefono) throw new Error("Compila nome, email e telefono.");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("L'indirizzo email non sembra giusto: controllalo.");

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error("Troppe richieste in questo momento: riprova tra qualche secondo.");
  let libro, id;
  try {
    libro = leggiTab_("Libri").find(r => String(r.id) === String(d.id_libro || ""));
    if (!libro) throw new Error("Libro non trovato nel catalogo: ricarica la pagina.");
    const stato = String(libro.stato || "disponibile").trim();
    if (stato !== "disponibile") {
      return { ok: false, stato: stato, errore: stato === "prenotato"
        ? "Qualcuno l'ha appena chiesto in prestito: torna a controllare tra qualche settimana."
        : "Ora è in prestito: torna a controllare più avanti." };
    }
    id = prossimoIdPrestito_();
    scriviRiga_("Prestiti", {
      id_prestito: id, id_libro: libro.id, titolo: libro.titolo,
      nome: nome, email: email, telefono: telefono,
      data_richiesta: new Date(), stato: "richiesto"
    });
    impostaStatoLibro_(libro.id, "prenotato");
    SpreadsheetApp.flush();
    log_("richiesta", id, libro.id + " «" + libro.titolo + "» — " + nome);
    cacheSvuota_("catalogo");
  } finally {
    lock.releaseLock();
  }

  // da qui la richiesta è registrata: un problema con le mail non la fa risultare fallita
  let mail = true;
  try { mailRichiedente_(libro, nome, email); } catch (err) { mail = false; console.error("Conferma non inviata: " + err); }
  try { mailBibliotecaria_(libro, id, nome, email, telefono); } catch (err) { console.error("Avviso non inviato: " + err); }
  return { ok: true, id: id, mail: mail };
}

function mailRichiedente_(libro, nome, email) {
  const bibliotecaria = PropertiesService.getScriptProperties().getProperty("EMAIL_BIBLIOTECARIA");
  const opzioni = {
    to: email,
    name: NOME_MITTENTE,
    subject: "Richiesta di prestito: " + libro.titolo,
    body: [
      "Ciao " + nome + ",",
      "",
      "abbiamo ricevuto la tua richiesta di prestito per:",
      "«" + libro.titolo + "»" + (libro.autori ? " di " + libro.autori : ""),
      "",
      "Quando il libro è pronto ti contattiamo: lo ritiri nella biblioteca del Circolo negli orari di apertura e lo puoi tenere fino a due mesi.",
      "",
      "Se hai cambiato idea, rispondi a questa mail.",
      "",
      NOME_MITTENTE + " — Leccio",
      URL_SITO
    ].join("\n")
  };
  if (bibliotecaria) opzioni.replyTo = bibliotecaria;
  MailApp.sendEmail(opzioni);
}

function mailBibliotecaria_(libro, id, nome, email, telefono) {
  const a = PropertiesService.getScriptProperties().getProperty("EMAIL_BIBLIOTECARIA");
  if (!a) return;
  MailApp.sendEmail({
    to: a,
    name: NOME_MITTENTE,
    replyTo: email,
    subject: "Nuova richiesta di prestito: " + libro.titolo,
    body: [
      "Nuova richiesta di prestito (" + id + ")",
      "",
      "Libro: «" + libro.titolo + "»" + (libro.autori ? " di " + libro.autori : "") + " (" + libro.id + ")",
      "Scaffale: " + (libro.categoria || "—"),
      "",
      "Chi lo chiede: " + nome,
      "Email: " + email + "   (rispondendo a questa mail scrivi direttamente a questa persona)",
      "Telefono: " + telefono,
      "",
      "Sul sito il libro ora risulta \"prenotato\". Nel tab Prestiti del foglio, colonna stato:",
      "- \"in prestito\" quando lo consegni (data di ritiro e scadenza si compilano da sole);",
      "- \"restituito\" quando torna; \"annullato\" se non viene ritirato.",
      "",
      "Foglio: " + SpreadsheetApp.getActiveSpreadsheet().getUrl()
    ].join("\n")
  });
}

// Chiamata da onEdit: per ogni riga modificata del tab Prestiti allinea libro e date allo stato del prestito.
function allineaPrestiti_(range) {
  const sh = range.getSheet();
  const testa = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const c = n => testa.indexOf(n) + 1;
  const cStato = c("stato");
  if (!cStato || range.getColumn() > cStato || range.getLastColumn() < cStato) return;   // colonna stato non toccata
  const libroPer = { "richiesto": "prenotato", "in prestito": "in prestito", "restituito": "disponibile", "annullato": "disponibile" };
  const oggi = new Date();
  for (let r = Math.max(2, range.getRow()); r <= range.getLastRow(); r++) {
    const stato = String(sh.getRange(r, cStato).getValue()).trim();
    const idLibro = String(sh.getRange(r, c("id_libro")).getValue()).trim();
    if (!libroPer[stato] || !idLibro) continue;
    if (stato === "in prestito" && c("data_ritiro") && !sh.getRange(r, c("data_ritiro")).getValue()) sh.getRange(r, c("data_ritiro")).setValue(oggi);
    if (stato === "restituito" && c("data_restituzione") && !sh.getRange(r, c("data_restituzione")).getValue()) sh.getRange(r, c("data_restituzione")).setValue(oggi);
    impostaStatoLibro_(idLibro, libroPer[stato]);
    log_("stato prestito", sh.getRange(r, c("id_prestito")).getValue(), idLibro + " → " + stato);
  }
  cacheSvuota_("catalogo");
}

function impostaStatoLibro_(idLibro, stato) {
  const sh = tab_("Libri");
  const cId = indice_(sh, "id"), cStato = indice_(sh, "stato");
  const ultima = sh.getLastRow();
  if (ultima < 2) return false;
  const ids = sh.getRange(2, cId, ultima - 1, 1).getValues().map(r => String(r[0]).trim());
  const i = ids.indexOf(String(idLibro).trim());
  if (i < 0) return false;
  sh.getRange(i + 2, cStato).setValue(stato);
  return true;
}

function prossimoIdPrestito_() {
  const max = leggiTab_("Prestiti").reduce((m, r) => {
    const n = /^P(\d+)$/.exec(String(r.id_prestito || ""));
    return n ? Math.max(m, Number(n[1])) : m;
  }, 0);
  return "P" + String(max + 1).padStart(4, "0");
}

// Ricerca per ISBN nel catalogo nazionale SBN (opac.sbn.it), che copre quasi tutti i libri pubblicati in Italia.
// Il servizio non accetta chiamate dirette dal browser, per questo passa da qui. Dà titolo, autori, editore, anno (niente copertine).
// Servizio non documentato ufficialmente: se cambia, la pagina continua a funzionare con Google Books e Open Library.
function cercaSbn_(v) {
  const isbn = normalizzaIsbn_(v || "");
  if (!isbn) return { ok: false, errore: "ISBN non valido." };
  const cache = CacheService.getScriptCache();
  const salvato = cache.get("sbn_" + isbn);
  if (salvato) return JSON.parse(salvato);
  let out;
  try {
    const r = UrlFetchApp.fetch("https://opac.sbn.it/opacmobilegw/search.json?isbn=" + isbn, { muteHttpExceptions: true, followRedirects: true });
    if (r.getResponseCode() !== 200) return { ok: false, errore: "SBN ha risposto " + r.getResponseCode() };
    const rec = (JSON.parse(r.getContentText()).briefRecords || [])[0];
    out = rec ? Object.assign({ ok: true, trovato: true }, campiSbn_(rec)) : { ok: true, trovato: false };
  } catch (err) {
    return { ok: false, errore: "SBN non raggiungibile: " + (err.message || err) };
  }
  try { cache.put("sbn_" + isbn, JSON.stringify(out), 21600); } catch (err) {}
  return out;
}

// "Limonov / Emmanuel Carrère ; traduzione di …" · "Carrère, Emmanuel <1957- >" · "Milano : Adelphi, 2012"
function campiSbn_(rec) {
  const p = s => String(s || "").replace(/\*/g, "").replace(/\s*<[^>]*>/g, "").replace(/\s+/g, " ").trim();
  const parti = p(rec.titolo).split(" / ");
  const titolo = parti[0].split(/ [:;=] | \. - /)[0].trim();
  let autori = (parti[1] || "").split(/ ; | \. - /)[0].replace(/\[[^\]]*\]/g, "").replace(/\s*\.\s*$/, "").trim();
  if (!autori && rec.autorePrincipale) {
    const a = p(rec.autorePrincipale).split(", ");
    autori = a.length === 2 ? a[1] + " " + a[0] : a.join(" ");
  }
  const pub = p(rec.pubblicazione);
  const ed = /:\s*([^,;:]+)/.exec(pub);
  const anni = pub.match(/\d{4}/g);
  return { titolo: titolo, autori: autori, editore: ed ? ed[1].trim() : "", anno: anni ? anni[anni.length - 1] : "" };
}

// Prova dall'editor (e concede il permesso di collegarsi a siti esterni): cerca due ISBN su SBN.
function provaIsbn() {
  ["9788845928987", "9788842092995"].forEach(i => console.log(i + " → " + JSON.stringify(cercaSbn_(i))));
}

// Da eseguire una volta dall'editor: concede il permesso di mandare mail e ne manda una di prova.
function provaMail() {
  const a = PropertiesService.getScriptProperties().getProperty("EMAIL_BIBLIOTECARIA") || Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({ to: a, name: NOME_MITTENTE, subject: "Prova mail della biblioteca",
    body: "Se leggi questa mail, le notifiche delle richieste di prestito funzionano.\n\n" + URL_SITO });
  console.log("Mail di prova inviata a " + a + ". Mail rimaste oggi: " + MailApp.getRemainingDailyQuota());
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
