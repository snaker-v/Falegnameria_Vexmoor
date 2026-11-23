# Falegnameria Vexmoor

Gestionale RP per Rhodes, anno 1900. Prima versione operativa per l'avvio e il collaudo.

## Avvio

Con Node.js 24 o superiore, eseguire `npm test` e `npm start`. Aprire http://localhost:3000.
Il database locale viene creato al primo avvio in `data/vexmoor.sqlite`. Il catalogo è pubblico. Gli articoli diventano ordinabili quando l'Owner assegna il prezzo unitario.

Per il collaudo OAuth in locale, copiare `.env.example` in `.env`, impostare `NODE_ENV=development`, `BASE_URL=http://localhost:3000` e `DATA_DIR=./data`. Usare `node --env-file=.env server.mjs`. Registrare `http://localhost:3000/auth/callback` nell'app Discord dedicata. L'Owner viene riconosciuto tramite l'ID Discord numerico verificato da OAuth2.

## Railway

Creare un progetto Railway dedicato, collegare un nuovo repository privato e montare un volume su `/data`. Impostare le variabili dell'esempio nel servizio. `BASE_URL` deve corrispondere al dominio HTTPS del servizio. Configurare il redirect Discord su `BASE_URL/auth/callback`. Usare un solo processo e una sola replica con SQLite. Impostare il controllo stato su `/api/health` e i backup del volume. Per un backup manuale a processo fermo copiare l'intera directory dati. In esercizio usare uno snapshot consistente o il comando SQLite `.backup`.

## Scelte tecniche

La Fonderia Ford, commit `318140e638b04039ed60566e6214239eee6dafd2`, è il riferimento per accesso Discord, sessioni persistenti, approvazione Owner, permessi, ordini multiarticolo e riscontro incassi. La Falegnameria conserva Node.js e SQLite, con moduli separati e librerie standard Node. Schema e dati iniziali sono indipendenti. Le scorte partono a zero e i prezzi di vendita sono da definire. I prezzi di riferimento e quelli concorrenti sono separati.

## Ambito della versione

Disponibili vetrina iniziale, richieste di accesso e ruoli, permessi per utente e ruolo, registri iniziali di magazzino e produzione, lavorazioni multilivello, listini concorrenti con audit delle correzioni, costo standard, ordini multiarticolo, riserva di magazzino, consegna, verifica incassi, forniture con costo monetario registrato e ticket con storico dei messaggi.

Da completare secondo capitolato restano dashboard definitiva, catalogo illustrato per articolo, identità grafica completa dei cinque ambienti, magazzini multipli e inventario avanzato, assegnazioni e collegamenti di produzione agli ordini, gestione avanzata dei fornitori e delle notifiche dei ticket, personale, contabilità estesa e costo effettivo, documenti ed esportazioni. Collaudare accesso Discord reale e deploy Railway prima dell'utilizzo.

## Aggiornamento 0.2 — Vetrina e gestionale

La vetrina pubblica e l'area riservata usano rispettivamente `/` e `/gestionale`.
Lo schema SQLite passa automaticamente dalla versione 1 alla 2 in una transazione.
Prima del deploy, verificare che `DATA_DIR` punti al database corrente e creare un backup consistente sul volume Railway.
Conservare le variabili di ambiente e il redirect OAuth configurati.

La migrazione aggiunge soglie materiali, assegnazioni e storico ordini, lavorazioni collegate e movimenti contabili. Gli ordini preesistenti conservano lo stato corrente. Lo storico cronologico copre gli eventi registrati dopo l'aggiornamento.
I valori delle scorte usano i prezzi di riferimento disponibili. Il margine lordo resta indeterminato finché manca una rilevazione storica del costo del venduto.

## Aggiornamento 0.3 — Acquisti e controlli Owner

L'aggiornamento aggiunge Acquisti in Commercio, gestione account e permessi in Sistema e rettifiche/anagrafica Owner nel Magazzino. SQLite migra automaticamente lo schema da v2 a v3 in una transazione. Verificare il volume persistente e conservare un backup consistente prima del deploy sul servizio esistente.

Il fabbisogno comprende ordini accettati, in preparazione o in produzione, soglie, craft programmati e aggiunte manuali. Gli ordini già pronti hanno già scaricato la riserva dal magazzino. Le consegne attese riducono la lista residua, ma solo la registrazione della ricezione aggiorna la scorta. Per evitare registrazioni duplicate riutilizzare il riferimento originale della ricezione o del pagamento in caso di tentativo ripetuto. Il confronto applica sconti documentati e verifica la disponibilità solo se registrata. Se i costi di trasporto non sono confrontabili fra tutte le offerte, la graduatoria usa il solo prezzo dei materiali.
