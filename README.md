# Biblioteca del Circolo Aurora — Leccio

Catalogo online della biblioteca del circolo Arci Aurora: consultazione pubblica dei libri, richiesta di prestito, inserimento dei libri da parte della bibliotecaria.

Sito: `https://circolo-aurora.github.io/biblioteca/` · area riservata: `https://circolo-aurora.github.io/biblioteca/admin.html`

Repository: `Circolo-Aurora/biblioteca` · backend: web app Apps Script dell'account della sagra (URL in `API_URL` di `index.html` e `admin.html`).

---

## Architettura

```
GitHub Pages (frontend statico)  ──fetch──>  Apps Script (web app)  ──>  Google Sheet
   index.html  catalogo + richiesta              doGet / doPost              Libri, Prestiti,
   admin.html  area riservata                    MailApp                     Desideri, Log
        │
        └──fetch──> Google Books / Open Library  (lookup ISBN, direttamente dal browser)
```

- **Frontend**: HTML/CSS/JS senza framework, pubblicato con GitHub Pages dall'organizzazione `Circolo-Aurora`, repo `biblioteca`.
- **Backend**: un progetto Apps Script collegato al Google Sheet, pubblicato come web app ("esegui come: me", "accesso: chiunque"). Account proprietario: quello della Sagra di Penco.
- **Dati**: un Google Sheet, modificabile anche a mano.
- **Lookup ISBN**: tre fonti in parallelo. Google Books e Open Library direttamente dal browser; il catalogo nazionale SBN (opac.sbn.it, servizio non documentato) tramite Apps Script, perché non accetta chiamate dal browser. Per ogni campo vale la prima fonte che lo ha (Google Books → SBN → Open Library); le copertine si provano in ordine (Google Books, Open Library, Amazon per ISBN-10) e vale la prima che si carica davvero. Amazon non è un servizio ufficiale: si spegne con `COPERTINE_AMAZON = false` in `admin.html`. Se non si trova niente, la copertina si fotografa (riquadro 2:3) o si sceglie dalla galleria e va su Drive.

## Struttura del repo

```
biblioteca/
├── index.html              catalogo pubblico (CSS e JS dentro il file)
├── admin.html              area riservata: login, scansione/ricerca ISBN, inserimento libri
├── manifest.webmanifest    app "Biblioteca" (apre il catalogo)
├── gestione.webmanifest    app "Gestione libri" (apre l'area riservata)
├── sw.js                   service worker: installabilità e apertura con poca rete
├── assets/
│   ├── logo-aurora.png
│   ├── icona-biblioteca.png
│   ├── libro-fiorito.svg   il disegno del libro ricalcato in vettoriale (per icone e materiali)
│   └── icone/              icone delle app, favicon, apple-touch-icon
├── apps-script/
│   └── Code.gs             copia versionata del codice Apps Script
└── README.md
```

- In cima allo script di `index.html` c'è `API_URL`: se è vuoto la pagina usa i libri di prova (`PROVA`) e mostra una fascia "Anteprima".
- `anteprima-biblioteca.html` è la stessa pagina con le immagini incorporate, da aprire al volo senza server. Non va nel repo.
- Il codice in `apps-script/` si incolla nell'editor Apps Script.

Stile: quello della biblioteca del Circolo (rosa carta, disegno a china del libro fiorito, titoli in Patrick Hand) con il rosso del logo Aurora; testo in Atkinson Hyperlegible. Senza immagine, la copertina è disegnata con il colore dello scaffale (`COLORI_SCAFFALE`).

## Google Sheet

Una copia per titolo: la disponibilità è un campo del libro.

### `Libri`
| colonna | note |
|---|---|
| `id` | progressivo, es. `L0001` — generato dallo script |
| `isbn` | ISBN-13 normalizzato (gli ISBN-10 vengono convertiti); può essere vuoto |
| `titolo` | |
| `autori` | separati da virgola |
| `editore` | |
| `anno` | |
| `categoria` | = scaffale; valori da elenco chiuso (convalida dati, foglio `Config`) |
| `copertina` | URL dell'immagine (da Google Books / Open Library) |
| `trama` | facoltativa |
| `stato` | `disponibile` · `prenotato` · `in prestito` |
| `data_inserimento` | |

### `Prestiti`
| colonna | note |
|---|---|
| `id_prestito` | progressivo |
| `id_libro` | |
| `titolo` | copiato per leggibilità |
| `nome` · `email` · `telefono` | del richiedente |
| `data_richiesta` | |
| `data_ritiro` | compilata a mano dalla bibliotecaria (o dalla dashboard, fase 3) |
| `data_restituzione` | |
| `stato` | `richiesto` · `in prestito` · `restituito` · `annullato` |
| `scadenza` | ultima colonna, calcolata: `data_ritiro` + 2 mesi (ARRAYFORMULA nell'intestazione, non si scrive a mano) |

### `Desideri`
`data` · `titolo` · `autore` · `nota` · `nome` · `email` (facoltativi) · `stato` (`nuovo` · `acquistato` · `scartato`)

### `Log`
`timestamp` · `azione` · `id` · `dettaglio`: una riga per ogni scrittura fatta dallo script.

### `Config`
Elenco delle categorie/scaffali (usato per la convalida e restituito al frontend per i filtri).

## API (Apps Script)

| chiamata | metodo | input | output |
|---|---|---|---|
| `?azione=catalogo` | GET | — | `{ libri: [...], categorie: [...] }` (solo campi pubblici) |
| `caricaCopertina` | POST | `password, immagine` (JPEG in base64, già ritagliato 600×900), `isbn`, `titolo` | file nella cartella Drive "Biblioteca Circolo Aurora – copertine" condiviso con chi ha il link; restituisce l'indirizzo dell'immagine |
| `?azione=isbn&isbn=…` | GET | — | ricerca nel catalogo nazionale SBN (titolo, autori, editore, anno), in cache 6 ore |
| `?azione=esito&rid=…` | GET | — | la risposta di un POST già inviato (se quella diretta si è persa) |
| `richiesta` | POST | `id_libro, nome, email, telefono` | riga in Prestiti (`P0001`…), libro → `prenotato`, mail alla bibliotecaria (rispondendo si scrive al richiedente) e conferma al richiedente; se il libro non è più disponibile `{ok:false, stato}` |
| `desiderio` | POST | `titolo, autore, nota, nome?, email?` | conferma (fase 4) |
| `login` | POST | `password` | ok / errore |
| `aggiungiLibro` | POST | `password` + campi libro | `id` assegnato |

Note tecniche:
- I POST si inviano come testo (JSON senza `Content-Type: application/json`), per evitare il preflight CORS che Apps Script non gestisce. Ogni POST ha un codice `rid`: la risposta resta in cache 6 ore e la pagina la può richiedere con `esito` (stesso schema delle prenotazioni della sagra).
- La password è salvata nelle **Proprietà dello script** (`ADMIN_PASSWORD`), mai nel repo. Con "Resta collegato" l'area riservata la ricorda nel telefono (`localStorage`), altrimenti solo finché resta aperta la scheda; "Esci" la cancella. Il modulo è fatto in modo che anche il gestore di password del browser possa salvarla.
- Il catalogo è in cache lato script (10 minuti, diviso in pezzi per il limite di 100 KB) e si svuota a ogni inserimento e a ogni modifica a mano del foglio (`onEdit`).
- Lato pagina, l'ultima copia del catalogo resta nel browser: alla riapertura i libri compaiono subito e si aggiornano quando risponde Apps Script.
- Il tab Libri si legge per nome di colonna: l'ordine delle colonne si può cambiare, i nomi no.
- Le mail partono da `MailApp` dell'account della sagra (limite account gratuito: 100 destinatari/giorno, ampiamente sufficiente).

## Frontend

### Catalogo (`index.html`)
- Intestazione con logo del circolo e "Biblioteca del Circolo Aurora".
- Ricerca libera su titolo, autori, editore, ISBN (nel browser, sui dati già caricati).
- Filtri: categoria/scaffale, solo disponibili.
- Griglia dei libri con copertina, titolo, autori, stato.
- Scheda libro: dati completi, scaffale ("Lo trovi qui: Narrativa per ragazzi"), pulsante "Richiedi in prestito" se disponibile.
- Form di richiesta: nome, email, telefono → messaggio di conferma con le indicazioni per il ritiro.

### Area riservata (`admin.html`)
- Login con password.
- Campo ISBN unico: accetta 10 o 13 cifre, con o senza trattini/spazi; controllo della cifra di verifica.
- "Cerca" → Google Books, poi Open Library se il primo non trova nulla → compila il form.
- Il form resta sempre modificabile; senza risultati si compila a mano.
- Scelta della categoria da menu; "Salva" → `aggiungiLibro`.

## App installabili

Il sito si installa come app dal telefono: su Android Chrome propone "Installa app" (o il pulsante in fondo alla pagina), su iPhone da Safari con Condividi → "Aggiungi alla schermata Home". Le app sono due: **Biblioteca** (catalogo) e **Gestione libri** (area riservata, icona con il "+").

- Le pagine HTML arrivano sempre dalla rete se c'è; immagini, icone, font e lettore di codici a barre restano salvati nel telefono.
- Se si cambiano immagini o icone, aumentare `VERSIONE` in `sw.js`.

## Regole del prestito

- Chiunque può richiedere un prestito; nessun limite di libri.
- La richiesta si fa solo su libri `disponibili` e li porta a `prenotato`.
- Ritiro in biblioteca negli orari di apertura. Al ritiro: `stato` del prestito → `in prestito`, compilata `data_ritiro`, libro → `in prestito`.
- Durata: 2 mesi dal ritiro.
- Alla restituzione: compilata `data_restituzione`, prestito → `restituito`, libro → `disponibile`.

La bibliotecaria cambia solo la colonna `stato` del tab Prestiti: il trigger `onEdit` aggiorna lo stato del libro in Libri e compila `data_ritiro` / `data_restituzione` con la data del giorno. `richiesto` → libro prenotato; `in prestito` → in prestito; `restituito` / `annullato` → disponibile.

## Fasi

### Fase 1 — Catalogo e inserimento
- [x] Creare l'organizzazione GitHub `Circolo-Aurora` e il repo `biblioteca`, attivare Pages
- [x] Creare il Google Sheet con i fogli e le intestazioni sopra
- [x] Apps Script: `setup`, `catalogo`, `login`, `aggiungiLibro`, `Log`
- [x] `index.html`: catalogo, ricerca, filtri, scheda libro con scaffale, form richiesta (in anteprima)
- [x] `admin.html`: login, lookup ISBN (Google Books + Open Library in parallelo), inserimento, avviso doppioni
- [ ] Inserire i primi libri (l'export di My Library ha 4 titoli: si ricaricano dall'area riservata)

### Fase 2 — Richiesta di prestito
- [x] Form nella scheda libro
- [x] Endpoint `richiesta` + mail alla bibliotecaria e conferma al richiedente
- [x] Allineamento automatico libro ↔ prestito quando si cambia lo stato nel foglio
- [x] Scansione del codice a barre nell'area riservata (BarcodeDetector del browser, altrimenti `barcode-detector@3.2.0` da jsDelivr)

### Fase 3 — Gestione prestiti
- [ ] Trigger giornaliero: reminder 7 giorni prima della scadenza e alla scadenza
- [ ] (eventuale) mini dashboard nell'area riservata: richieste aperte, prestiti in corso, scaduti

### Fase 4 — Scaffali e desideri
- [ ] Immagine/pianta degli scaffali con lo scaffale del libro evidenziato
- [ ] Form "Suggerisci un libro" → foglio `Desideri`

## Da definire

- Elenco definitivo delle categorie/scaffali
- Logo del circolo (file vettoriale se disponibile)
- Testo con orari e modalità di ritiro per la mail di conferma
- Indirizzo email della bibliotecaria per le notifiche

## Setup

1. Creare il Google Sheet dall'account della sagra; Estensioni → Apps Script → incollare `apps-script/Code.gs`.
2. Eseguire `setup` dall'editor: crea i tab, i menu a tendina e la formula della scadenza.
3. Impostazioni progetto → Proprietà script: `ADMIN_PASSWORD`, `EMAIL_BIBLIOTECARIA`. Controllo: eseguire `prova`.
4. Distribuisci → Applicazione web → esegui come: me, accesso: chiunque. Copiare l'URL.
5. Incollare l'URL in `API_URL` di `index.html` e `admin.html`, fare push su `main`.
6. GitHub → Settings → Pages → deploy da `main`, cartella root.

A ogni modifica dello script: nuovo deployment sulla **stessa** versione di deployment (Gestisci deployment → modifica), così l'URL non cambia.
