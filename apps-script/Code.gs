/**
 * Biblioteca del Circolo ARCI Aurora (Leccio) — backend del catalogo
 * ===================================================================
 * Fase 1: catalogo pubblico, login dell'area riservata, inserimento libri.
 * Fase 2: richieste di prestito dal sito, con mail alla bibliotecaria e conferma a chi chiede.
 *
 * Ricerca ISBN: il sito interroga Google Books e Open Library; il catalogo nazionale SBN passa da qui (azione "isbn").
 *
 * Foto delle copertine: l'area riservata le carica qui (azione "caricaCopertina"); finiscono nella cartella Drive
 * "Biblioteca Circolo Aurora – copertine", visibili a chi ha il link, e nel catalogo va il loro indirizzo.
 *
 * DOPO AVER INCOLLATO UNA VERSIONE NUOVA: esegui una volta "provaMail", "provaIsbn" e "provaDrive" dall'editor e
 * concedi i permessi (email, siti esterni, Drive), poi pubblica la nuova versione (vedi sotto).
 *
 * GESTIONE DEI PRESTITI NEL FOGLIO (tab Prestiti, colonna "stato"):
 *   richiesto   → la riga la crea il sito; il libro risulta "prenotato"
 *   in prestito → quando lo consegni; data_ritiro e scadenza (+2 mesi) si compilano da sole
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
const MESI_PRESTITO = 2;
const DURATA_CACHE = 600;   // secondi di validità del catalogo in cache
const NOME_MITTENTE = "Biblioteca del Circolo ARCI Aurora";   // nome che compare nelle mail
const URL_SITO = "https://circolo-aurora.github.io/biblioteca/";

const TAB = {
  Libri:    ["id", "isbn", "titolo", "autori", "editore", "anno", "categoria", "copertina", "trama", "stato", "data_inserimento", "collana", "genere", "copie", "copertina_cercata", "isbn_trovato"],
  Prestiti: ["id_prestito", "id_libro", "titolo", "nome", "email", "telefono", "data_richiesta", "data_ritiro", "data_restituzione", "stato", "scadenza", "chiave"],
  Desideri: ["id_desiderio", "data", "titolo", "autore", "nota", "nome", "email", "stato"],
  Preferiti: ["chiave", "id_libro", "data"],
  Rimossi:  ["id", "isbn", "titolo", "autori", "editore", "anno", "categoria", "copertina", "trama", "stato", "data_inserimento", "collana", "genere", "copie", "data_rimozione", "motivo"],
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
const CAMPI_PUBBLICI = ["id", "isbn", "titolo", "autori", "editore", "anno", "categoria", "copertina", "trama", "stato", "data_inserimento", "collana", "genere"];

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
      case "miei":          out = miei_(d); break;
      case "preferito":     out = preferito_(d); break;
      case "caricaCopertina": out = caricaCopertina_(d); break;
      case "prestiti":      out = prestiti_(d); break;
      case "cambiaPrestito": out = cambiaPrestito_(d); break;
      case "modificaLibro": out = modificaLibro_(d); break;
      case "desiderio":     out = desiderio_(d); break;
      case "desideri":      out = desideri_(d); break;
      case "cambiaDesiderio": out = cambiaDesiderio_(d); break;
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
  return { libri: libri, categorie: categorie_(), mappa: mappa_() };
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
      data_inserimento: new Date(),
      collana: pulisci_(d.collana, 150)
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
  // chiave personale: generata dal sito alla prima richiesta e conservata nel telefono; identifica "i miei libri"
  const chiave = /^[a-z0-9]{16,64}$/.test(String(d.chiave || "")) ? String(d.chiave) : "";
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
      data_richiesta: new Date(), stato: "richiesto", chiave: chiave
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
  try { mailRichiedente_(libro, nome, email, chiave); } catch (err) { mail = false; console.error("Conferma non inviata: " + err); }
  try { mailBibliotecaria_(libro, id, nome, email, telefono); } catch (err) { console.error("Avviso non inviato: " + err); }
  return { ok: true, id: id, mail: mail };
}

function mailRichiedente_(libro, nome, email, chiave) {
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
      "I tuoi libri, le scadenze e la tua storia di lettura sono qui (il link vale anche su un altro telefono):",
      URL_SITO + (chiave ? "?chiave=" + chiave : ""),
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
  const cStato = c("stato"), cRitiro = c("data_ritiro"), cScad = c("scadenza");
  const tocca = col => col && range.getColumn() <= col && range.getLastColumn() >= col;
  // cambiata a mano la data di ritiro: ricalcola la scadenza
  if (tocca(cRitiro) && cScad) {
    for (let r = Math.max(2, range.getRow()); r <= range.getLastRow(); r++) {
      const d = sh.getRange(r, cRitiro).getValue();
      sh.getRange(r, cScad).setValue(d instanceof Date ? scadenza_(d) : "");
    }
  }
  if (!tocca(cStato)) return;   // colonna stato non toccata
  for (let r = Math.max(2, range.getRow()); r <= range.getLastRow(); r++) applicaStatoPrestito_(sh, r, String(sh.getRange(r, cStato).getValue()).trim());
  cacheSvuota_("catalogo");
}

// "I miei libri": i prestiti legati a una chiave personale (nessun login: la chiave sta nel telefono
// e nel link della mail di conferma). Restituisce solo i dati del prestito e del libro, niente contatti.
function miei_(d) {
  const chiave = String(d.chiave || "");
  if (!/^[a-z0-9]{16,64}$/.test(chiave)) return { ok: true, prestiti: [], preferiti: [] };
  const libri = {}; leggiTab_("Libri").forEach(l => { libri[String(l.id)] = l; });
  const campi = ["id_prestito", "id_libro", "titolo", "data_richiesta", "data_ritiro", "data_restituzione", "stato", "scadenza"];
  let nome = "";
  const prestiti = leggiTab_("Prestiti").filter(r => String(r.chiave || "") === chiave).map(r => {
    const o = {}; campi.forEach(k => { o[k] = formatta_(r[k]); });
    const l = libri[String(r.id_libro)] || {};
    o.autori = formatta_(l.autori); o.copertina = formatta_(l.copertina); o.categoria = formatta_(l.categoria);
    nome = formatta_(r.nome) || nome;
    return o;
  });
  const preferiti = leggiTab_("Preferiti").filter(r => String(r.chiave || "") === chiave && libri[String(r.id_libro)]).map(r => {
    const l = libri[String(r.id_libro)];
    return { id_libro: String(r.id_libro), titolo: formatta_(l.titolo), autori: formatta_(l.autori), copertina: formatta_(l.copertina), categoria: formatta_(l.categoria), stato: formatta_(l.stato) };
  });
  return { ok: true, nome: nome.split(" ")[0], prestiti: prestiti, preferiti: preferiti, oggi: formatta_(new Date()) };
}

// Cuore sulla scheda del libro: aggiunge o toglie il libro dai preferiti di quella chiave (tab Preferiti).
function preferito_(d) {
  const chiave = String(d.chiave || ""), id = String(d.id_libro || "").trim();
  if (!/^[a-z0-9]{16,64}$/.test(chiave) || !/^L\d{4,}$/.test(id)) throw new Error("Richiesta non valida.");
  const sh = tab_("Preferiti");
  const righe = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues() : [];
  const trovata = righe.findIndex(r => String(r[0]) === chiave && String(r[1]) === id);
  if (d.attivo && trovata < 0) scriviRiga_("Preferiti", { chiave: chiave, id_libro: id, data: new Date() });
  if (!d.attivo && trovata >= 0) sh.deleteRow(trovata + 2);
  return { ok: true, attivo: !!d.attivo };
}

// ---- Area riservata: prestiti ------------------------------------------------------

// Elenco per la gestione: tutti i prestiti aperti (richiesto, in prestito) e gli ultimi 30 chiusi.
function prestiti_(d) {
  verificaPassword_(d.password);
  const tutti = leggiTab_("Prestiti").filter(r => r.id_prestito);
  const aperti = tutti.filter(r => ["richiesto", "in prestito"].indexOf(String(r.stato).trim()) >= 0);
  const chiusi = tutti.filter(r => ["richiesto", "in prestito"].indexOf(String(r.stato).trim()) < 0).slice(-30).reverse();
  const campi = ["id_prestito", "id_libro", "titolo", "nome", "email", "telefono", "data_richiesta", "data_ritiro", "data_restituzione", "stato", "scadenza"];
  const pulito = r => { const o = {}; campi.forEach(k => { o[k] = formatta_(r[k]); }); return o; };
  return { ok: true, aperti: aperti.map(pulito), chiusi: chiusi.map(pulito), oggi: formatta_(new Date()) };
}

// Cambio di stato dall'area riservata (stessa logica delle modifiche a mano nel foglio).
function cambiaPrestito_(d) {
  verificaPassword_(d.password);
  const stato = String(d.stato || "").trim();
  if (STATI_PRESTITO.indexOf(stato) < 0) throw new Error("Stato non valido.");
  const sh = tab_("Prestiti");
  const cId = indice_(sh, "id_prestito"), cStato = indice_(sh, "stato");
  const n = sh.getLastRow() - 1;
  if (n < 1) throw new Error("Prestito non trovato.");
  const ids = sh.getRange(2, cId, n, 1).getValues().map(r => String(r[0]).trim());
  const i = ids.indexOf(String(d.id_prestito || "").trim());
  if (i < 0) throw new Error("Prestito non trovato.");
  const riga = i + 2;
  sh.getRange(riga, cStato).setValue(stato);
  applicaStatoPrestito_(sh, riga, stato);
  cacheSvuota_("catalogo");
  return { ok: true };
}

// Effetti di uno stato su una riga di Prestiti: date e stato del libro.
function applicaStatoPrestito_(sh, riga, stato) {
  const testa = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const c = n => testa.indexOf(n) + 1;
  const libroPer = { "richiesto": "prenotato", "in prestito": "in prestito", "restituito": "disponibile", "annullato": "disponibile" };
  const idLibro = String(sh.getRange(riga, c("id_libro")).getValue()).trim();
  if (!libroPer[stato] || !idLibro) return;
  const oggi = new Date();
  if (stato === "in prestito" && c("data_ritiro") && !sh.getRange(riga, c("data_ritiro")).getValue()) {
    sh.getRange(riga, c("data_ritiro")).setValue(oggi);
    if (c("scadenza")) sh.getRange(riga, c("scadenza")).setValue(scadenza_(oggi));
  }
  if (stato === "restituito" && c("data_restituzione") && !sh.getRange(riga, c("data_restituzione")).getValue()) sh.getRange(riga, c("data_restituzione")).setValue(oggi);
  impostaStatoLibro_(idLibro, libroPer[stato]);
  log_("stato prestito", sh.getRange(riga, c("id_prestito")).getValue(), idLibro + " → " + stato);
}

// ---- Area riservata: modifica dei libri ------------------------------------------------

// Aggiorna i campi di un libro esistente (per id). Con rimuovi=true la riga passa nel tab Rimossi.
function modificaLibro_(d) {
  verificaPassword_(d.password);
  const sh = tab_("Libri");
  const cId = indice_(sh, "id");
  const n = sh.getLastRow() - 1;
  if (n < 1) throw new Error("Libro non trovato.");
  const ids = sh.getRange(2, cId, n, 1).getValues().map(r => String(r[0]).trim());
  const i = ids.indexOf(String(d.id || "").trim());
  if (i < 0) throw new Error("Libro non trovato: ricarica la pagina.");
  const riga = i + 2;
  const testa = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const c = k => testa.indexOf(k) + 1;

  if (d.rimuovi) {
    const valori = sh.getRange(riga, 1, 1, sh.getLastColumn()).getValues()[0];
    const obj = {}; testa.forEach((h, k) => { if (h) obj[h] = valori[k]; });
    obj.data_rimozione = new Date(); obj.motivo = pulisci_(d.motivo, 200);
    scriviRiga_("Rimossi", obj);
    sh.deleteRow(riga);
    log_("rimuoviLibro", d.id, String(obj.titolo || "") + (obj.motivo ? " — " + obj.motivo : ""));
    cacheSvuota_("catalogo");
    return { ok: true, rimosso: true };
  }

  const titolo = pulisci_(d.titolo, 300);
  if (!titolo) throw new Error("Manca il titolo.");
  const isbn = d.isbn ? normalizzaIsbn_(d.isbn) : "";
  if (d.isbn && !isbn) throw new Error("ISBN non valido: controlla le cifre.");
  const categoria = pulisci_(d.categoria, 100);
  const categorie = categorie_();
  if (categorie.length && categorie.indexOf(categoria) < 0) throw new Error("Scegli uno scaffale dall'elenco.");
  const nuovi = {
    isbn: isbn, titolo: titolo, autori: pulisci_(d.autori, 300), editore: pulisci_(d.editore, 150), anno: pulisci_(d.anno, 10),
    categoria: categoria, copertina: /^https:\/\//.test(String(d.copertina || "")) ? pulisci_(d.copertina, 500) : "",
    trama: pulisci_(d.trama, 3000), genere: pulisci_(d.genere, 100), collana: pulisci_(d.collana, 150)
  };
  if (d.stato && STATI_LIBRO.indexOf(String(d.stato)) >= 0) nuovi.stato = String(d.stato);
  Object.keys(nuovi).forEach(k => { if (c(k)) sh.getRange(riga, c(k)).setValue(nuovi[k]); });
  log_("modificaLibro", d.id, titolo);
  cacheSvuota_("catalogo");
  return { ok: true, id: d.id };
}

// ---- Lista dei desideri ----------------------------------------------------------------

// Dal sito: "suggerisci un libro". Nome e mail facoltativi.
function desiderio_(d) {
  const titolo = pulisci_(d.titolo, 200);
  if (!titolo) throw new Error("Scrivi almeno il titolo.");
  const email = pulisci_(d.email, 200);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("L'indirizzo email non sembra giusto: controllalo.");
  const id = "D" + String(leggiTab_("Desideri").filter(r => r.id_desiderio).length + 1).padStart(4, "0");
  scriviRiga_("Desideri", { id_desiderio: id, data: new Date(), titolo: titolo, autore: pulisci_(d.autore, 200), nota: pulisci_(d.nota, 500),
    nome: pulisci_(d.nome, 120), email: email, stato: "nuovo" });
  log_("desiderio", id, titolo);
  try {
    const a = PropertiesService.getScriptProperties().getProperty("EMAIL_BIBLIOTECARIA");
    if (a) MailApp.sendEmail({ to: a, name: NOME_MITTENTE, subject: "Libro suggerito: " + titolo,
      body: ["Qualcuno ha suggerito un libro per la biblioteca (" + id + ")", "", "Titolo: " + titolo, "Autore: " + (pulisci_(d.autore, 200) || "—"),
        "Nota: " + (pulisci_(d.nota, 500) || "—"), "", "Da: " + (pulisci_(d.nome, 120) || "anonimo") + (email ? " <" + email + ">" : ""),
        "", "Lo trovi nell'area riservata, scheda Desideri, e nel foglio: " + SpreadsheetApp.getActiveSpreadsheet().getUrl()].join("\n") });
  } catch (err) { console.error("Avviso desiderio non inviato: " + err); }
  return { ok: true, id: id };
}

function desideri_(d) {
  verificaPassword_(d.password);
  const campi = ["id_desiderio", "data", "titolo", "autore", "nota", "nome", "email", "stato"];
  const lista = leggiTab_("Desideri").filter(r => r.id_desiderio).reverse().map(r => { const o = {}; campi.forEach(k => { o[k] = formatta_(r[k]); }); return o; });
  return { ok: true, desideri: lista };
}

function cambiaDesiderio_(d) {
  verificaPassword_(d.password);
  const stato = String(d.stato || "").trim();
  if (STATI_DESIDERIO.indexOf(stato) < 0) throw new Error("Stato non valido.");
  const sh = tab_("Desideri");
  const cId = indice_(sh, "id_desiderio"), cStato = indice_(sh, "stato");
  const n = sh.getLastRow() - 1;
  const ids = n > 0 ? sh.getRange(2, cId, n, 1).getValues().map(r => String(r[0]).trim()) : [];
  const i = ids.indexOf(String(d.id_desiderio || "").trim());
  if (i < 0) throw new Error("Suggerimento non trovato.");
  sh.getRange(i + 2, cStato).setValue(stato);
  return { ok: true };
}

function scadenza_(dataRitiro) {
  const d = new Date(dataRitiro); d.setMonth(d.getMonth() + MESI_PRESTITO); return d;
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

// Foto della copertina scattata dall'area riservata (JPEG già ritagliato e ridotto dal browser).
function caricaCopertina_(d) {
  verificaPassword_(d.password);
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/.exec(String(d.immagine || ""));
  if (!m) throw new Error("Immagine non valida.");
  const byte = Utilities.base64Decode(m[2]);
  if (byte.length > 3 * 1024 * 1024) throw new Error("Immagine troppo grande.");
  const nome = (normalizzaIsbn_(d.isbn || "") || pulisci_(d.titolo, 60) || "copertina") + " " +
    Utilities.formatDate(new Date(), FUSO, "yyyy-MM-dd HH.mm") + "." + (m[1] === "jpeg" ? "jpg" : m[1]);
  const file = cartellaCopertine_().createFile(Utilities.newBlob(byte, "image/" + m[1], nome));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  log_("copertina", file.getId(), nome);
  return { ok: true, id: file.getId(), url: "https://drive.google.com/thumbnail?id=" + file.getId() + "&sz=w600" };
}

function cartellaCopertine_() {
  const prop = PropertiesService.getScriptProperties();
  const id = prop.getProperty("CARTELLA_COPERTINE");
  if (id) { try { return DriveApp.getFolderById(id); } catch (err) {} }
  const cartella = DriveApp.createFolder("Biblioteca Circolo Aurora – copertine");
  prop.setProperty("CARTELLA_COPERTINE", cartella.getId());
  return cartella;
}

// ---- Copertine dal foglio -----------------------------------------------------------
// UNA funzione per tutto. Per ogni libro senza copertina prova prima con l'ISBN (Google Books, Open Library, Amazon)
// e poi per titolo e autore (Google Books, poi Open Library); se trova per titolo scrive anche l'ISBN dell'edizione
// trovata in "isbn_trovato" (non in "isbn": è un'altra edizione, la copertina può differire dalla copia fisica).
// Segna in "copertina_cercata" cosa ha provato, così non riprova. Lavora 4 minuti e mezzo, salva, e si
// riprogramma da sola dopo un minuto finché non ha finito: si lancia UNA volta dall'editor e si segue
// l'avanzamento nel tab Log (riga "copertine"). Per fermarla prima: fermaCopertine.
// Se Google risponde "troppe richieste" (429: quota giornaliera di 1000, si azzera alle 9 ora italiana) aspetta
// mezz'ora e riprova da sola. La quota si alza da Google Cloud (Quote → Books API → Queries per day).
function cercaCopertine() {
  const inizio = Date.now();
  const sh = tab_("Libri");
  const testa = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const c = n => { const i = testa.indexOf(n); if (i < 0) throw new Error("Manca la colonna " + n + ": esegui setup."); return i + 1; };
  const cIsbn = c("isbn"), cTit = c("titolo"), cAut = c("autori"), cCop = c("copertina"), cCerc = c("copertina_cercata"), cTrov = c("isbn_trovato");
  const n = sh.getLastRow() - 1;
  if (n < 1) return;
  const v = sh.getRange(2, 1, n, sh.getLastColumn()).getValues();
  // le scritture si accumulano e si salvano a blocchi (cella per cella era lentissimo)
  const cop = v.map(r => [r[cCop - 1]]), cerc = v.map(r => [r[cCerc - 1]]), trov = v.map(r => [r[cTrov - 1]]);
  const salva = () => { sh.getRange(2, cCop, n).setValues(cop); sh.getRange(2, cCerc, n).setValues(cerc); sh.getRange(2, cTrov, n).setValues(trov); };
  let fatti = 0, trovate = 0, restano = 0;
  const chiudi = msg => { salva(); cacheSvuota_("catalogo"); console.log(msg); log_("copertine", "", msg); };
  for (let i = 0; i < n; i++) {
    const r = v[i], k = normalizzaIsbn_(r[cIsbn - 1]), titolo = String(r[cTit - 1] || "").trim(), marca = cerc[i][0];
    if (cop[i][0] || !titolo) continue;
    // marcatore vecchio (solo data): con ISBN era stato provato solo l'ISBN, senza ISBN era già stato provato il titolo
    const titoloFatto = /titolo/.test(String(marca)) || (marca instanceof Date && !k);
    if (titoloFatto) { restano++; continue; }
    if (Date.now() - inizio > 270000) {
      chiudi("Pausa: " + fatti + " controllati, " + trovate + " copertine trovate. Riparte da sola tra un minuto.");
      riprogramma_("cercaCopertine", 1);
      return;
    }
    let url = "", isbnTrovato = "";
    if (k && !marca) url = copertinaPerIsbn_(k);
    if (!url) {
      try { const e = cercaPerTitolo_(titolo, String(r[cAut - 1] || "")); if (e) { url = e.copertina; isbnTrovato = e.isbn; } }
      catch (e) {
        if (/429/.test(String(e))) {   // quota di Google esaurita (1000 al giorno, si azzera alle 9 ora italiana): riprova da sola ogni mezz'ora
          chiudi("Pausa: quota Google Books esaurita, riprovo tra mezz'ora. " + String(e).replace(/^Error: /, "") + " (" + fatti + " controllati, " + trovate + " trovate)");
          riprogramma_("cercaCopertine", 30);
          return;
        }
      }
    }
    if (url) { cop[i][0] = url; if (isbnTrovato && !k) trov[i][0] = isbnTrovato; trovate++; } else restano++;
    cerc[i][0] = (k ? "isbn+titolo " : "titolo ") + Utilities.formatDate(new Date(), FUSO, "dd/MM/yyyy HH:mm");
    fatti++;
    if (fatti % 25 === 0) salva();
  }
  fermaCopertine();
  chiudi("finito: " + fatti + " controllati, " + trovate + " copertine trovate. Senza copertina restano " + restano + " libri già cercati: per riprovarli esegui riprovaCopertine e poi di nuovo cercaCopertine.");
}

// Trigger a tempo per continuare da sola; fermaCopertine li toglie (si può eseguire anche a mano per interrompere).
function riprogramma_(nome, minuti) {
  fermaCopertine();
  ScriptApp.newTrigger(nome).timeBased().after(minuti * 60 * 1000).create();
}
function fermaCopertine() {
  ScriptApp.getProjectTriggers().forEach(t => { if (t.getHandlerFunction() === "cercaCopertine") ScriptApp.deleteTrigger(t); });
}

// Cancella il segno "già cercato" dei libri ancora senza copertina, così cercaCopertine li riprova
// (utile dopo aver corretto titoli/autori nel foglio o aggiunto la chiave di Google Books).
function riprovaCopertine() {
  const sh = tab_("Libri");
  const testa = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
  const cCop = testa.indexOf("copertina") + 1, cCerc = testa.indexOf("copertina_cercata") + 1;
  const n = sh.getLastRow() - 1;
  if (n < 1 || !cCop || !cCerc) return;
  const cop = sh.getRange(2, cCop, n).getValues(), cerc = sh.getRange(2, cCerc, n).getValues();
  let azzerati = 0;
  for (let i = 0; i < n; i++) if (!cop[i][0] && cerc[i][0]) { cerc[i][0] = ""; azzerati++; }
  sh.getRange(2, cCerc, n).setValues(cerc);
  console.log(azzerati + " libri da ricercare. Ora esegui cercaCopertine.");
}

// Per capire PERCHÉ un libro non si trova: prende 12 libri a caso senza copertina (o quelli con la cella
// "copertina_cercata" uguale a "?") e scrive nel registro cosa hanno risposto le fonti e perché è stato scartato.
// Non modifica il foglio.
function diagnosiCopertine() {
  const libri = leggiTab_("Libri").filter(l => l.titolo && !l.copertina);
  const scelti = libri.filter(l => String(l.copertina_cercata).trim() === "?");
  const lista = scelti.length ? scelti : libri.slice().sort(() => Math.random() - 0.5).slice(0, 12);
  console.log("Senza copertina: " + libri.length + " libri. Ne provo " + lista.length + (scelti.length ? " (quelli segnati con ?)" : "") + ".\n");
  lista.forEach(l => {
    const righe = [l.id + " · " + l.titolo + " — " + (l.autori || "(senza autore)")];
    const k = normalizzaIsbn_(l.isbn);
    if (k) {
      const u = copertinaPerIsbn_(k);
      righe.push("  ISBN " + k + ": " + (u ? "trovata " + u : "nessuna copertina su Google Books, Open Library, Amazon"));
    } else righe.push("  senza ISBN");
    try {
      const e = cercaPerTitolo_(String(l.titolo), String(l.autori || ""), righe);
      righe.push(e ? "  → TROVATA " + e.copertina : "  → niente di buono");
    } catch (err) { righe.push("  Google Books: " + err); }
    console.log(righe.join("\n"));
  });
}

// Confronto: tutte le parole "significative" del nostro titolo devono stare nel titolo trovato (o viceversa)
// e il cognome del primo autore deve comparire tra gli autori trovati (bastano le prime 4 lettere: le
// traslitterazioni variano). Chi chiama passa "diario" (un array) per sapere il motivo di uno scarto.
function norm_(s) { return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim(); }
function parole_(s) { return norm_(s).split(" ").filter(w => w.length > 2 && ["the", "and", "del", "della", "dei", "degli", "delle", "con", "per", "una", "uno", "gli", "nel", "nella", "vol"].indexOf(w) < 0); }
// Titolo "base": la parte prima di due punti o punto (via sottotitoli e "Vol. 2"), se resta qualcosa di sensato
function titoloBase_(t) { const p = String(t || "").split(/[.:]/)[0].trim(); return parole_(p).length >= 2 || parole_(t).length < 2 ? p : String(t || "").trim(); }
function cognome_(autori) {
  const primo = String(autori || "").split(/[,;]/)[0].trim();
  if (!primo || /^aa\.?\s?vv/i.test(primo)) return "";
  return norm_(primo).split(" ").filter(w => w.length > 1).pop() || "";
}
function corrisponde_(titolo, autori, tTrovato, aTrovati, diario) {
  const a = parole_(titoloBase_(titolo));
  // il titolo trovato vale sia intero sia senza sottotitolo (dopo i due punti): basta che una delle due forme vada bene
  const forme = [parole_(tTrovato)]; if (tTrovato.indexOf(":") > 0) forme.unshift(parole_(tTrovato.split(":")[0]));
  const scarta = m => { if (diario) diario.push("    scartato «" + tTrovato + "» (" + (aTrovati || []).join(", ") + "): " + m); return false; };
  const dentro = (x, y) => x.every(w => y.indexOf(w) >= 0);
  const perche = forme.map(b => {
    if (!a.length || !b.length) return "titolo vuoto";
    if (!dentro(a, b)) return "non contiene tutte le parole del nostro titolo";
    if (b.length > a.length * 2 + 1) return "titolo troppo diverso";
    if (a.length === 1 && b.length > 1) return "titolo di una parola: serve uguale";
    return "";
  });
  if (perche.every(Boolean)) return scarta(perche[perche.length - 1]);
  const cognome = cognome_(autori);
  if (!cognome) return true;
  if (norm_(aTrovati.join(" ") + " " + tTrovato).indexOf(cognome.slice(0, 4)) >= 0) return true;   // vale anche nel sottotitolo ("Colloquio di Mario Telò…")
  // senza autori nella fonte (capita con i libri vecchi): va bene solo se il titolo coincide parola per parola
  if (!aTrovati.length && forme.some(b => b.length === a.length && dentro(a, b))) return true;
  return scarta(aTrovati.length ? "autore diverso da " + cognome : "fonte senza autore e titolo non identico");
}

// Cerca per titolo e autore: Google Books (prima una ricerca stretta, poi una larga), poi Open Library.
function cercaPerTitolo_(titolo, autori, diario) {
  const cognome = cognome_(autori), base = titoloBase_(titolo);
  const key = PropertiesService.getScriptProperties().getProperty("GOOGLE_BOOKS_KEY");
  const nota = m => { if (diario) diario.push("  " + m); };
  // 1) Google Books, una sola ricerca a parole libere (quella "stretta" con intitle/inauthor non trovava mai niente).
  //    country=IT è obbligatorio dai server di Apps Script, altrimenti 403 "Cannot determine user location".
  {
    Utilities.sleep(key ? 150 : 500);
    const q = encodeURIComponent(base + (cognome ? " " + cognome : ""));
    const r = googleBooks_("https://www.googleapis.com/books/v1/volumes?q=" + q + "&maxResults=10&printType=books&country=IT" + (key ? "&key=" + key : ""));
    let perche = ""; if (r.getResponseCode() !== 200) { try { perche = JSON.parse(r.getContentText()).error.message; } catch (e) {} }
    if (r.getResponseCode() === 429) throw new Error("429 troppe richieste: " + perche);
    if (r.getResponseCode() !== 200) nota("Google Books: risposta " + r.getResponseCode() + (perche ? " — " + perche : ""));
    const items = r.getResponseCode() === 200 ? JSON.parse(r.getContentText()).items || [] : [];
    if (r.getResponseCode() === 200) nota("Google Books: " + items.length + " risultati");
    for (const it of items) {
      const vi = it.volumeInfo || {};
      const img = vi.imageLinks && (vi.imageLinks.thumbnail || vi.imageLinks.smallThumbnail);
      if (!img) { nota("    «" + (vi.title || "") + "» senza copertina"); continue; }
      if (!corrisponde_(titolo, autori, (vi.title || "") + (vi.subtitle ? ": " + vi.subtitle : ""), vi.authors || [], diario)) continue;
      const id13 = (vi.industryIdentifiers || []).find(x => x.type === "ISBN_13");
      return { copertina: img.replace(/^http:/, "https:").replace("&edge=curl", ""), isbn: id13 ? id13.identifier : "" };
    }
  }
  // 2) Open Library (lenta e con poche copertine italiane: solo se Google non ha trovato niente)
  const u = "https://openlibrary.org/search.json?title=" + encodeURIComponent(base) + (cognome ? "&author=" + encodeURIComponent(cognome) : "") + "&limit=5&fields=title,author_name,cover_i,isbn,language";
  try {
    const o = UrlFetchApp.fetch(u, { muteHttpExceptions: true });
    if (o.getResponseCode() === 200) {
      const docs = JSON.parse(o.getContentText()).docs || [];
      nota("Open Library: " + docs.length + " risultati per «" + base + "»" + (cognome ? " + " + cognome : ""));
      for (const d of docs) {
        if (!d.cover_i) { nota("    «" + (d.title || "") + "» senza copertina"); continue; }
        if (!corrisponde_(titolo, autori, d.title || "", d.author_name || [], diario)) continue;
        const isbn = (d.isbn || []).find(x => /^97[89]\d{10}$/.test(x)) || "";
        return { copertina: "https://covers.openlibrary.org/b/id/" + d.cover_i + "-M.jpg", isbn: isbn };
      }
    } else nota("Open Library: risposta " + o.getResponseCode());
  } catch (e) { nota("Open Library: errore " + e); }
  return null;
}

// Google Books dai server di Apps Script risponde spesso 503 "temporarily unavailable" a caso: si riprova una volta.
function googleBooks_(url) {
  let r;
  for (let t = 0; t < 2; t++) {
    if (t) Utilities.sleep(400);
    r = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (r.getResponseCode() !== 503) break;
  }
  return r;
}

function copertinaPerIsbn_(isbn) {
  const prova = (url, minimo) => {
    try {
      const r = UrlFetchApp.fetch(url, { muteHttpExceptions: true, followRedirects: true });
      return r.getResponseCode() === 200 && r.getBlob().getBytes().length > minimo ? url : "";
    } catch (e) { return ""; }
  };
  try {
    const key = PropertiesService.getScriptProperties().getProperty("GOOGLE_BOOKS_KEY");
    const r = googleBooks_("https://www.googleapis.com/books/v1/volumes?q=isbn:" + isbn + "&maxResults=1&country=IT" + (key ? "&key=" + key : ""));
    const v = r.getResponseCode() === 200 ? (JSON.parse(r.getContentText()).items || [])[0] : null;
    const img = v && v.volumeInfo && v.volumeInfo.imageLinks && (v.volumeInfo.imageLinks.thumbnail || v.volumeInfo.imageLinks.smallThumbnail);
    if (img) return img.replace(/^http:/, "https:").replace("&edge=curl", "");
  } catch (e) {}
  const ol = prova("https://covers.openlibrary.org/b/isbn/" + isbn + "-M.jpg?default=false", 1000);
  if (ol) return ol.replace("?default=false", "");
  const i10 = isbn10_(isbn);
  return i10 ? prova("https://images-na.ssl-images-amazon.com/images/P/" + i10 + ".01.L.jpg", 1000) : "";   // 43 byte = immagine vuota
}

function isbn10_(i13) {
  if (!/^978\d{10}$/.test(i13)) return "";
  const b = i13.slice(3, 12);
  const k = (11 - b.split("").reduce((t, c, i) => t + Number(c) * (10 - i), 0) % 11) % 11;
  return b + (k === 10 ? "X" : String(k));
}

// Da eseguire una volta dall'editor: concede il permesso di usare Drive e crea la cartella delle copertine.
function provaDrive() {
  console.log("Cartella delle copertine: " + cartellaCopertine_().getUrl());
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
    else {
      // fogli già creati: aggiunge in fondo le colonne nuove (es. "collana"), senza toccare le altre
      const presenti = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(h => String(h).trim());
      const nuove = TAB[nome].filter(h => presenti.indexOf(h) < 0);
      if (nuove.length) sh.getRange(1, sh.getLastColumn() + 1, 1, nuove.length).setValues([nuove]);
    }
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
  colonna_(libri, "copertina_cercata").setNumberFormat("@");
  colonna_(libri, "categoria").setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInRange(cfg.getRange("A2:A"), true).setAllowInvalid(false).build());
  colonna_(libri, "stato").setDataValidation(menu_(STATI_LIBRO));

  // Prestiti: formati e menu prima, formula della scadenza per ultima
  const pre = ss.getSheetByName("Prestiti");
  ["data_richiesta", "data_ritiro", "data_restituzione", "scadenza"].forEach(c => colonna_(pre, c).setNumberFormat("dd/mm/yyyy"));
  colonna_(pre, "telefono").setNumberFormat("@");
  colonna_(pre, "stato").setDataValidation(menu_(STATI_PRESTITO));
  // la scadenza (data_ritiro + 2 mesi) la scrive lo script quando il prestito passa a "in prestito"
  // o quando si cambia a mano data_ritiro (vedi onEdit); niente formule, che dipendono dalla lingua del foglio
  pre.getRange(1, indice_(pre, "scadenza")).setValue("scadenza");

  colonna_(ss.getSheetByName("Desideri"), "stato").setDataValidation(menu_(STATI_DESIDERIO));
  colonna_(ss.getSheetByName("Log"), "timestamp").setNumberFormat("dd/mm/yyyy hh:mm:ss");
  colonna_(ss.getSheetByName("Preferiti"), "data").setNumberFormat("dd/mm/yyyy hh:mm");

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

// Tab "Mappa" (facoltativo): disegno della scaffalatura. Ogni colonna è una scaffalatura (prima riga: il nome,
// es. "Scaffale 1"), sotto i ripiani dall'alto in basso con il nome dello scaffale/categoria che ci sta.
function mappa_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName("Mappa");
  if (!sh || sh.getLastRow() < 2) return null;
  return sh.getDataRange().getValues().map(r => r.map(v => String(v || "").trim()));
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
