-- ============================================================
-- SCHEMA SUPABASE — Gestione Tombola
-- Incolla ed esegui questo script in: Supabase > SQL Editor > New query
-- ============================================================

-- 1) DISPOSIZIONE DELLA MAPPA (una riga per sezione di sedie)
--    Viene scritta/aggiornata quando premi "Salva" o "Esci" in Editing Mode.
create table if not exists layout_sections (
  id          text primary key,          -- es. 'section-1'
  label       text,                      -- es. 'Sezione 1'
  rows        int not null default 1,
  cols        int not null default 1,
  pos_x       numeric not null default 0, -- posizione nel "mondo" (px)
  pos_y       numeric not null default 0,
  rotation    numeric not null default 0, -- gradi
  seats       jsonb not null default '[]', -- matrice righe/colonne con i numeri/etichette dei posti (null = cella vuota/corridoio)
  updated_at  timestamptz not null default now()
);

-- 2) VENDITE/OCCUPAZIONE DEI POSTI, UNA RIGA PER POSTO PER GIORNO
--    Viene scritta quando premi "CONFERMA PAGAMENTO" / "CONFERMA GRATIS",
--    e viene cancellata quando liberi un posto.
create table if not exists seats_bookings (
  id          bigint generated always as identity primary key,
  event_date  date not null,
  seat_code   text not null,                -- il numero/etichetta del posto (come impostato in Editing Mode)
  status      text not null check (status in ('paid','free')),
  price       numeric not null default 0,
  updated_at  timestamptz not null default now(),
  unique (event_date, seat_code)             -- necessario per l'upsert "aggiorna se esiste, altrimenti crea"
);

create index if not exists idx_seats_bookings_date on seats_bookings(event_date);

-- ============================================================
-- ROW LEVEL SECURITY
-- L'app usa la chiave "anon" / "publishable" (pubblica) dal browser:
-- è normale e sicuro usarla lato client SOLO se, come qui sotto,
-- ogni tabella ha RLS attiva con policy che permettono la LETTURA
-- a chiunque ma la SCRITTURA (insert/update/delete) solo a chi ha
-- effettuato il login tramite Supabase Auth (staff).
--
-- Se dovessi rieseguire lo script su un DB che ha già le vecchie
-- policy permissive, queste righe le rimuovono prima di ricrearle.
-- ============================================================

alter table layout_sections enable row level security;
alter table seats_bookings  enable row level security;

drop policy if exists "layout_sections_all" on layout_sections;
drop policy if exists "seats_bookings_all" on seats_bookings;

-- LAYOUT_SECTIONS: tutti possono leggere la disposizione della mappa,
-- solo lo staff autenticato può crearla/modificarla/cancellarla.
create policy "layout_sections_select" on layout_sections
  for select using (true);

create policy "layout_sections_insert" on layout_sections
  for insert with check (auth.role() = 'authenticated');

create policy "layout_sections_update" on layout_sections
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "layout_sections_delete" on layout_sections
  for delete using (auth.role() = 'authenticated');

-- SEATS_BOOKINGS: tutti possono vedere quali posti sono occupati,
-- solo lo staff autenticato può venderli/liberarli.
create policy "seats_bookings_select" on seats_bookings
  for select using (true);

create policy "seats_bookings_insert" on seats_bookings
  for insert with check (auth.role() = 'authenticated');

create policy "seats_bookings_update" on seats_bookings
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create policy "seats_bookings_delete" on seats_bookings
  for delete using (auth.role() = 'authenticated');

-- ============================================================
-- UTENTE STAFF
-- Crea almeno un utente da cui fare login nell'app:
-- Supabase Dashboard > Authentication > Users > Add user
-- (inserisci email + password, spunta "Auto Confirm User").
-- Con quelle credenziali lo staff farà login dal bottone
-- "Accedi staff" in alto nell'app.
-- ============================================================
