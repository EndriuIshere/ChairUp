/* ============================================================
   GESTIONE TOMBOLA — app.js
   - Mappa con pan (trascinamento) e zoom (rotellina), stile Maps
   - Editing Mode stile Canva: resize dall'angolo, rotazione, spostamento,
     rinumerazione dei posti
   - Persistenza su Supabase (layout + vendite multi-giorno)
   ============================================================ */

const CELL = 44;      // dimensione di ogni sedia in px
const GAP = 6;         // spazio tra le sedie
const MIN_CELLS = 1;
// Nessun limite "basso" imposto dall'app: le sezioni possono crescere
// quanto serve per ricoprire tutta l'area di sedie. Teniamo comunque un
// tetto molto alto solo come rete di sicurezza contro drag anomali
// (es. puntatore trascinato fuori schermo), non come limite d'uso reale.
const MAX_CELLS = 100;

let supabaseClient = null;

/* ---------- STATO ---------- */

let layout = [];                 // array di sezioni {id,label,rows,cols,x,y,rotation,seats}
let bookings = new Map();        // seat_code -> {status:'paid'|'free', price}
let selected = new Set();        // posti selezionati (non ancora confermati) nel giorno corrente
let currentDate = todayStr();
let isPastDate = false;

let editMode = false;
let renameTarget = null;         // {sectionId, r, c}
let pendingFreeSeat = null;

let viewport = { x: 0, y: 0, scale: 1 };
let currentDrag = null;          // {type, ...}

let stage = { width: 700, height: 400 }; // dimensioni del PALCO, ridimensionabile in Editing Mode
const STAGE_MIN = 100;
const STAGE_MAX = 2000;

let currentUser = null;          // sessione Supabase Auth (null = anonimo, sola lettura)

/* ---------- UTILITY ---------- */

function todayStr(){
    return new Date().toISOString().slice(0, 10);
}

function clamp(v, min, max){
    return Math.min(max, Math.max(min, v));
}

function getSection(id){
    return layout.find(s => s.id === id);
}

/* ---------- LAYOUT DI DEFAULT ---------- */

function buildDefaultLayout(){
    const defs = [
        { id: "section-1", label: "Sezione 1", rows: 6, cols: 8, x: 20,   y: 460, rotation: 0 },
        { id: "section-2", label: "Sezione 2", rows: 6, cols: 8, x: 460,  y: 460, rotation: 0 },
        { id: "section-3", label: "Sezione 3", rows: 6, cols: 5, x: 900,  y: 460, rotation: 0 },
        { id: "section-4", label: "Sezione 4", rows: 8, cols: 4, x: 1150, y: 20,  rotation: 0 },
        { id: "section-5", label: "Sezione 5", rows: 8, cols: 4, x: 1150, y: 280, rotation: 0 }
    ];

    let counter = 1;
    return defs.map(def => {
        const seats = [];
        for(let r = 0; r < def.rows; r++){
            const row = [];
            for(let c = 0; c < def.cols; c++){
                row.push(String(counter++));
            }
            seats.push(row);
        }
        return { ...def, seats, cache: {} };
    });
}

// Calcola il prossimo numero progressivo libero, guardando tutti i codici
// numerici già usati in tutte le sezioni. Serve per numerare automaticamente
// i nuovi posti creati (ingrandendo una sezione o creandone una nuova).
function nextSeatNumber(){
    let max = 0;
    layout.forEach(sec => {
        sec.seats.forEach(row => row.forEach(code => {
            if(code !== null && code !== undefined && code !== ""){
                const n = parseInt(code, 10);
                if(!isNaN(n) && n > max) max = n;
            }
        }));
    });
    return max + 1;
}

/* ---------- CARICAMENTO DATI DA SUPABASE ---------- */

async function loadLayout(){
    try{
        const { data, error } = await supabaseClient.from("layout_sections").select("*");
        if(!error && data && data.length > 0){
            const stageRow = data.find(row => row.id === "palco");
            if(stageRow){
                stage = {
                    width: Number(stageRow.cols) || 700,
                    height: Number(stageRow.rows) || 400
                };
            }

            layout = data
                .filter(row => row.id !== "palco")
                .map(row => ({
                    id: row.id,
                    label: row.label,
                    rows: row.rows,
                    cols: row.cols,
                    x: Number(row.pos_x),
                    y: Number(row.pos_y),
                    rotation: Number(row.rotation),
                    seats: row.seats,
                    cache: {}
                }));

            if(layout.length === 0) layout = buildDefaultLayout();
        } else {
            layout = buildDefaultLayout();
        }
    } catch(e){
        console.error("Errore nel caricamento del layout, uso quello di default.", e);
        layout = buildDefaultLayout();
    }
}

async function loadBookingsForDate(date){
    bookings.clear();
    selected.clear();

    try{
        const { data, error } = await supabaseClient
            .from("seats_bookings")
            .select("seat_code,status,price")
            .eq("event_date", date);

        if(!error && data){
            data.forEach(row => bookings.set(row.seat_code, { status: row.status, price: Number(row.price) }));
        }
    } catch(e){
        console.error("Errore nel caricamento delle prenotazioni.", e);
    }

    isPastDate = date < todayStr();
    renderMap();
    renderInfoPanel();
}

/* ---------- RENDER MAPPA ---------- */

function renderMap(){
    const world = document.getElementById("map-world");
    world.querySelectorAll(".section-box").forEach(el => el.remove());
    layout.forEach(section => world.appendChild(buildSectionEl(section)));
    renderPalco();
}

function renderPalco(){
    const palco = document.getElementById("palco");
    palco.style.width = stage.width + "px";
    palco.style.height = stage.height + "px";
    palco.classList.toggle("editing", editMode);

    let handle = palco.querySelector(".resize-handle");
    if(editMode){
        if(!handle){
            handle = document.createElement("div");
            handle.className = "resize-handle";
            handle.title = "Trascina per ridimensionare il palco";
            handle.addEventListener("pointerdown", (e) => {
                e.stopPropagation();
                startStageResize(e);
            });
            palco.appendChild(handle);
        }
    } else if(handle){
        handle.remove();
    }
}

function buildSectionEl(section){
    const box = document.createElement("div");
    box.className = "section-box" + (editMode ? " editing" : "");
    box.dataset.id = section.id;

    const w = section.cols * (CELL + GAP) + GAP;
    const h = section.rows * (CELL + GAP) + GAP;
    box.style.width = w + "px";
    box.style.height = h + "px";
    box.style.left = section.x + "px";
    box.style.top = section.y + "px";
    box.style.transform = `rotate(${section.rotation}deg)`;

    const grid = document.createElement("div");
    grid.className = "seat-grid";
    grid.style.gridTemplateColumns = `repeat(${section.cols}, ${CELL}px)`;
    grid.style.gridTemplateRows = `repeat(${section.rows}, ${CELL}px)`;
    grid.style.gap = GAP + "px";
    grid.style.padding = GAP + "px";

    section.seats.forEach((row, r) => {
        row.forEach((code, c) => {
            const cell = document.createElement("div");
            cell.className = "seat-cell";

            if(code === null || code === ""){
                cell.classList.add("empty-cell");
            } else {
                const btn = document.createElement("button");
                btn.className = "chair-btn";
                btn.dataset.code = code;

                const status = bookings.get(code);
                if(status && status.status === "paid") btn.classList.add("occupied", "paid");
                if(status && status.status === "free") btn.classList.add("occupied", "free");
                if(selected.has(code)) btn.classList.add("selected");
                if(isPastDate && !editMode) btn.classList.add("locked");

                btn.innerHTML = `<i class="fa-solid fa-chair"></i><span>${code}</span>`;
                btn.addEventListener("click", (e) => {
                    e.stopPropagation();
                    onSeatClick(section.id, r, c, code);
                });

                cell.appendChild(btn);
            }

            grid.appendChild(cell);
        });
    });

    box.appendChild(grid);

    const label = document.createElement("div");
    label.className = "section-label";
    label.textContent = section.label || section.id;
    box.appendChild(label);

    if(editMode){
        box.addEventListener("pointerdown", (e) => {
            if(e.target.closest(".resize-handle,.rotate-handle,.chair-btn")) return;
            startSectionMove(e, section.id);
        });

        const resizeHandle = document.createElement("div");
        resizeHandle.className = "resize-handle";
        resizeHandle.title = "Trascina per ridimensionare (righe/colonne)";
        resizeHandle.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            startSectionResize(e, section.id);
        });
        box.appendChild(resizeHandle);

        const rotateHandle = document.createElement("div");
        rotateHandle.className = "rotate-handle";
        rotateHandle.title = "Trascina per ruotare";
        rotateHandle.innerHTML = '<i class="fa-solid fa-rotate"></i>';
        rotateHandle.addEventListener("pointerdown", (e) => {
            e.stopPropagation();
            startSectionRotate(e, section.id);
        });
        box.appendChild(rotateHandle);
    }

    return box;
}

/* ---------- CLICK SU UN POSTO ---------- */

function onSeatClick(sectionId, r, c, code){
    if(editMode){
        openRenameModal(sectionId, r, c, code);
        return;
    }

    if(isPastDate) return;

    const status = bookings.get(code);
    if(status){
        if(!requireAuth()) return;
        openFreeModal(code);
        return;
    }

    if(selected.has(code)) selected.delete(code);
    else selected.add(code);

    renderMap();
    renderInfoPanel();
}

/* ---------- PAN & ZOOM DELLA MAPPA ---------- */

function applyViewportTransform(){
    document.getElementById("map-world").style.transform =
        `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`;
}

function zoomAt(mx, my, factor){
    const newScale = clamp(viewport.scale * factor, 0.3, 3);
    const wx = (mx - viewport.x) / viewport.scale;
    const wy = (my - viewport.y) / viewport.scale;
    viewport.scale = newScale;
    viewport.x = mx - wx * newScale;
    viewport.y = my - wy * newScale;
    applyViewportTransform();
}

function setupViewportInteractions(){
    const viewportEl = document.getElementById("map-viewport");

    viewportEl.addEventListener("wheel", (e) => {
        e.preventDefault();
        const rect = viewportEl.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        zoomAt(mx, my, e.deltaY < 0 ? 1.1 : 0.9);
    }, { passive: false });

    viewportEl.addEventListener("pointerdown", (e) => {
        if(e.button !== 0) return;
        if(e.target.closest(".section-box")) return; // gestito dalla sezione stessa
        currentDrag = { type: "pan", offsetX: e.clientX - viewport.x, offsetY: e.clientY - viewport.y };
        viewportEl.classList.add("panning");
    });

    document.getElementById("zoom-in-btn").addEventListener("click", () => {
        const rect = viewportEl.getBoundingClientRect();
        zoomAt(rect.width / 2, rect.height / 2, 1.2);
    });
    document.getElementById("zoom-out-btn").addEventListener("click", () => {
        const rect = viewportEl.getBoundingClientRect();
        zoomAt(rect.width / 2, rect.height / 2, 0.8);
    });
    document.getElementById("zoom-reset-btn").addEventListener("click", () => {
        viewport = { x: 40, y: 20, scale: 1 };
        applyViewportTransform();
    });
}

/* ---------- DRAG GLOBALE (pan / move / resize / rotate) ---------- */

function onPointerMove(e){
    if(!currentDrag) return;

    if(currentDrag.type === "pan"){
        viewport.x = e.clientX - currentDrag.offsetX;
        viewport.y = e.clientY - currentDrag.offsetY;
        applyViewportTransform();
        return;
    }

    if(currentDrag.type === "resize-stage"){
        const dxScreen = (e.clientX - currentDrag.startClientX) / viewport.scale;
        const dyScreen = (e.clientY - currentDrag.startClientY) / viewport.scale;

        stage.width = clamp(Math.round(currentDrag.startWidth + dxScreen), STAGE_MIN, STAGE_MAX);
        stage.height = clamp(Math.round(currentDrag.startHeight + dyScreen), STAGE_MIN, STAGE_MAX);

        const palco = document.getElementById("palco");
        palco.style.width = stage.width + "px";
        palco.style.height = stage.height + "px";
        return;
    }

    const sec = getSection(currentDrag.sectionId);
    if(!sec) return;

    if(currentDrag.type === "move-section"){
        const dx = (e.clientX - currentDrag.startClientX) / viewport.scale;
        const dy = (e.clientY - currentDrag.startClientY) / viewport.scale;
        sec.x = currentDrag.startX + dx;
        sec.y = currentDrag.startY + dy;
        const box = document.querySelector(`.section-box[data-id="${sec.id}"]`);
        if(box){
            box.style.left = sec.x + "px";
            box.style.top = sec.y + "px";
        }
    } else if(currentDrag.type === "resize-section"){
        const dxScreen = e.clientX - currentDrag.startClientX;
        const dyScreen = e.clientY - currentDrag.startClientY;
        const rad = -sec.rotation * Math.PI / 180;
        const localDX = (dxScreen * Math.cos(rad) - dyScreen * Math.sin(rad)) / viewport.scale;
        const localDY = (dxScreen * Math.sin(rad) + dyScreen * Math.cos(rad)) / viewport.scale;

        const newCols = clamp(currentDrag.startCols + Math.round(localDX / (CELL + GAP)), MIN_CELLS, MAX_CELLS);
        const newRows = clamp(currentDrag.startRows + Math.round(localDY / (CELL + GAP)), MIN_CELLS, MAX_CELLS);

        if(newCols !== sec.cols || newRows !== sec.rows){
            resizeSectionSeats(sec, newRows, newCols);
            renderMap();
        }
    } else if(currentDrag.type === "rotate-section"){
        const box = document.querySelector(`.section-box[data-id="${sec.id}"]`);
        if(!box) return;
        const rect = box.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const angle = Math.atan2(e.clientY - cy, e.clientX - cx) * 180 / Math.PI;
        sec.rotation = Math.round(angle + 90);
        box.style.transform = `rotate(${sec.rotation}deg)`;
    }
}

function onPointerUp(){
    if(currentDrag && currentDrag.type === "pan"){
        document.getElementById("map-viewport").classList.remove("panning");
    }
    currentDrag = null;
}

function startSectionMove(e, sectionId){
    const sec = getSection(sectionId);
    currentDrag = {
        type: "move-section", sectionId,
        startClientX: e.clientX, startClientY: e.clientY,
        startX: sec.x, startY: sec.y
    };
}

function startSectionResize(e, sectionId){
    const sec = getSection(sectionId);
    currentDrag = {
        type: "resize-section", sectionId,
        startClientX: e.clientX, startClientY: e.clientY,
        startCols: sec.cols, startRows: sec.rows
    };
}

function startSectionRotate(e, sectionId){
    currentDrag = { type: "rotate-section", sectionId };
}

function startStageResize(e){
    currentDrag = {
        type: "resize-stage",
        startClientX: e.clientX, startClientY: e.clientY,
        startWidth: stage.width, startHeight: stage.height
    };
}

function cacheKey(r, c){
    return r + "_" + c;
}

// Prima di cambiare forma alla griglia, ricordiamo tutti i posti attualmente
// visibili in una cache per-sezione: così, se una riga/colonna viene tolta
// restringendo e poi la sezione viene riallargata, i posti tornano al loro
// posto invece di sparire per sempre.
function syncCacheFromSeats(sec){
    if(!sec.cache) sec.cache = {};
    sec.seats.forEach((row, r) => row.forEach((code, c) => {
        const key = cacheKey(r, c);
        if(code !== null && code !== undefined && code !== "") sec.cache[key] = code;
        else delete sec.cache[key];
    }));
}

function resizeSectionSeats(sec, newRows, newCols){
    syncCacheFromSeats(sec);

    let nextNum = nextSeatNumber();

    const newSeats = [];
    for(let r = 0; r < newRows; r++){
        const row = [];
        for(let c = 0; c < newCols; c++){
            const key = cacheKey(r, c);
            if(Object.prototype.hasOwnProperty.call(sec.cache, key)){
                row.push(sec.cache[key]);
            } else {
                // cella nuova: le assegniamo subito un numero di posto
                // progressivo, così la sedia compare davvero (invece di
                // restare una cella vuota da rinumerare a mano)
                const code = String(nextNum++);
                row.push(code);
                sec.cache[key] = code;
            }
        }
        newSeats.push(row);
    }
    sec.rows = newRows;
    sec.cols = newCols;
    sec.seats = newSeats;
}

/* ---------- EDITING MODE: AGGIUNTA NUOVA AREA ---------- */

function addSection(){
    if(!requireAuth()) return;

    const rows = 4, cols = 4; // area quadrata di default
    const w = cols * (CELL + GAP) + GAP;
    const h = rows * (CELL + GAP) + GAP;

    // la posizioniamo al centro di ciò che si vede ora nel viewport
    const viewportEl = document.getElementById("map-viewport");
    const rect = viewportEl.getBoundingClientRect();
    const worldCenterX = (rect.width / 2 - viewport.x) / viewport.scale;
    const worldCenterY = (rect.height / 2 - viewport.y) / viewport.scale;

    let nextNum = nextSeatNumber();
    const seats = [];
    const cache = {};
    for(let r = 0; r < rows; r++){
        const row = [];
        for(let c = 0; c < cols; c++){
            const code = String(nextNum++);
            row.push(code);
            cache[cacheKey(r, c)] = code;
        }
        seats.push(row);
    }

    const newSection = {
        id: "section-" + Date.now(),
        label: "Nuova sezione",
        rows, cols,
        x: Math.round(worldCenterX - w / 2),
        y: Math.round(worldCenterY - h / 2),
        rotation: 0,
        seats,
        cache
    };

    layout.push(newSection);
    renderMap();
    renderInfoPanel();
}

/* ---------- EDITING MODE: RINUMERAZIONE POSTO ---------- */

function openRenameModal(sectionId, r, c, code){
    renameTarget = { sectionId, r, c };
    document.getElementById("rename-input").value = code || "";
    document.getElementById("rename-modal-overlay").classList.remove("hidden");
}

function closeRenameModal(){
    renameTarget = null;
    document.getElementById("rename-modal-overlay").classList.add("hidden");
}

function applyRename(newValue){
    if(!renameTarget) return;
    const sec = getSection(renameTarget.sectionId);
    sec.seats[renameTarget.r][renameTarget.c] = newValue;

    if(!sec.cache) sec.cache = {};
    const key = cacheKey(renameTarget.r, renameTarget.c);
    if(newValue !== null && newValue !== "") sec.cache[key] = newValue;
    else delete sec.cache[key]; // "Svuota" rimuove il posto anche dalla cache, non deve ricomparire

    closeRenameModal();
    renderMap();
}

/* ---------- SALVATAGGIO LAYOUT (Editing Mode) ---------- */

async function saveLayout(){
    const status = document.getElementById("save-status");
    status.textContent = "Salvataggio mappa in corso...";

    const rows = layout.map(sec => ({
        id: sec.id,
        label: sec.label,
        rows: sec.rows,
        cols: sec.cols,
        pos_x: sec.x,
        pos_y: sec.y,
        rotation: sec.rotation,
        seats: sec.seats,
        updated_at: new Date().toISOString()
    }));

    // Riga speciale che memorizza solo le dimensioni del palco (non è una
    // sezione di sedie: "rows"/"cols" qui rappresentano altezza/larghezza in px)
    rows.push({
        id: "palco",
        label: "PALCO",
        rows: stage.height,
        cols: stage.width,
        pos_x: 0,
        pos_y: 0,
        rotation: 0,
        seats: [],
        updated_at: new Date().toISOString()
    });

    const { error } = await supabaseClient.from("layout_sections").upsert(rows, { onConflict: "id" });
    status.textContent = error ? ("Errore nel salvataggio: " + error.message) : "Mappa salvata su Supabase.";
}

function toggleEditMode(){
    if(!editMode && !requireAuth()) return; // per ENTRARE in edit mode serve il login
    editMode = !editMode;
    document.getElementById("edit-toggle-btn").classList.toggle("active", editMode);
    document.getElementById("edit-toolbar").classList.toggle("hidden", !editMode);
    selected.clear();
    renderMap();
    renderInfoPanel();
}

async function exitEditMode(){
    await saveLayout();
    editMode = false;
    document.getElementById("edit-toggle-btn").classList.remove("active");
    document.getElementById("edit-toolbar").classList.add("hidden");
    renderMap();
    renderInfoPanel();
}

/* ---------- CONFERMA VENDITA / LIBERAZIONE POSTO ---------- */

async function confirmSelection(status){
    if(selected.size === 0 || isPastDate) return;
    if(!requireAuth()) return;

    const rows = Array.from(selected).map(code => ({
        event_date: currentDate,
        seat_code: code,
        status,
        price: status === "paid" ? PRICE : 0,
        updated_at: new Date().toISOString()
    }));

    const { error } = await supabaseClient
        .from("seats_bookings")
        .upsert(rows, { onConflict: "event_date,seat_code" });

    const saveStatus = document.getElementById("save-status");
    if(error){
        saveStatus.textContent = "Errore: " + error.message;
        return;
    }

    rows.forEach(r => bookings.set(r.seat_code, { status: r.status, price: r.price }));
    saveStatus.textContent = "Salvato.";
    selected.clear();
    renderMap();
    renderInfoPanel();
}

function openFreeModal(code){
    pendingFreeSeat = code;
    document.getElementById("modal-text").textContent = `Vuoi liberare il posto ${code}?`;
    document.getElementById("modal-overlay").classList.remove("hidden");
}

function closeFreeModal(){
    pendingFreeSeat = null;
    document.getElementById("modal-overlay").classList.add("hidden");
}

async function confirmFreeSeat(){
    if(pendingFreeSeat === null) return;
    const code = pendingFreeSeat;

    const { error } = await supabaseClient
        .from("seats_bookings")
        .delete()
        .eq("event_date", currentDate)
        .eq("seat_code", code);

    if(!error) bookings.delete(code);
    closeFreeModal();
    renderMap();
    renderInfoPanel();
}

/* ---------- PANNELLO INFO ---------- */

function renderInfoPanel(){
    const list = document.getElementById("seat-list");
    list.innerHTML = "";

    if(selected.size === 0){
        list.innerHTML = "<p class='empty-list'>Nessun posto selezionato</p>";
    } else {
        Array.from(selected).forEach(code => {
            const row = document.createElement("div");
            row.className = "seat-row";
            row.innerHTML = `<span>Posto ${code}</span><span>${PRICE}€</span>`;
            list.appendChild(row);
        });
    }

    document.getElementById("total-price").textContent = `Selezione: ${selected.size * PRICE}€`;

    let dayRevenue = 0;
    bookings.forEach(b => { if(b.status === "paid") dayRevenue += b.price; });
    document.getElementById("revenue-day").textContent = `Incasso giornata: ${dayRevenue}€`;

    const dayStatusEl = document.getElementById("day-status");
    if(isPastDate){
        dayStatusEl.textContent = "Giorno passato: sola consultazione, modifiche bloccate.";
        dayStatusEl.classList.add("locked");
    } else {
        dayStatusEl.textContent = currentDate === todayStr() ? "Oggi" : "Giorno futuro: modificabile.";
        dayStatusEl.classList.remove("locked");
    }

    document.getElementById("confirm-paid-btn").disabled = selected.size === 0 || isPastDate;
    document.getElementById("confirm-free-btn").disabled = selected.size === 0 || isPastDate;
}

/* ---------- INCASSO TOTALE COMPLESSIVO ---------- */

async function showOverallRevenue(){
    const btn = document.getElementById("total-overall-btn");
    btn.textContent = "Calcolo in corso...";

    const { data, error } = await supabaseClient
        .from("seats_bookings")
        .select("price")
        .eq("status", "paid");

    if(error){
        btn.textContent = "Errore nel calcolo";
        return;
    }

    const total = (data || []).reduce((sum, row) => sum + Number(row.price), 0);
    btn.textContent = `Incasso totale complessivo: ${total}€`;
}

/* ---------- AUTENTICAZIONE (Supabase Auth) ----------
   Solo gli utenti loggati (staff) possono modificare la mappa,
   confermare vendite/omaggi o liberare posti. La lettura resta
   pubblica (per un eventuale display di sola visualizzazione). */

function updateAuthUI(){
    const area = document.getElementById("auth-area");
    if(currentUser){
        area.innerHTML = `<span>${currentUser.email}</span><button id="logout-btn"><i class="fa-solid fa-right-from-bracket"></i> Esci account</button>`;
        document.getElementById("logout-btn").addEventListener("click", async () => {
            await supabaseClient.auth.signOut();
        });
    } else {
        area.innerHTML = `<button id="login-open-btn"><i class="fa-solid fa-right-to-bracket"></i> Accedi staff</button>`;
        document.getElementById("login-open-btn").addEventListener("click", openLoginModal);
    }
}

function openLoginModal(){
    document.getElementById("login-error").textContent = "";
    document.getElementById("login-modal-overlay").classList.remove("hidden");
}

function closeLoginModal(){
    document.getElementById("login-modal-overlay").classList.add("hidden");
}

async function doLogin(){
    const email = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;
    const errEl = document.getElementById("login-error");
    errEl.textContent = "Accesso in corso...";

    const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
    if(error){
        errEl.textContent = "Credenziali non valide.";
        return;
    }
    errEl.textContent = "";
    closeLoginModal();
}

async function initAuth(){
    const { data } = await supabaseClient.auth.getSession();
    currentUser = data.session ? data.session.user : null;
    updateAuthUI();

    supabaseClient.auth.onAuthStateChange((_event, session) => {
        currentUser = session ? session.user : null;
        updateAuthUI();
    });
}

// Da chiamare all'inizio di ogni azione che scrive sul DB (Editing Mode,
// conferma vendita/omaggio, liberazione posto). Se non autenticato, apre
// il login e blocca l'azione.
function requireAuth(){
    if(!currentUser){
        openLoginModal();
        return false;
    }
    return true;
}

/* ---------- INIZIALIZZAZIONE ---------- */

async function init(){
    supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

    const dateInput = document.getElementById("event-date");
    dateInput.value = currentDate;
    dateInput.addEventListener("change", async (e) => {
        currentDate = e.target.value || todayStr();
        await loadBookingsForDate(currentDate);
    });

    document.getElementById("edit-toggle-btn").addEventListener("click", toggleEditMode);
    document.getElementById("save-layout-btn").addEventListener("click", saveLayout);
    document.getElementById("exit-edit-btn").addEventListener("click", exitEditMode);
    document.getElementById("add-section-btn").addEventListener("click", addSection);

    document.getElementById("confirm-paid-btn").addEventListener("click", () => confirmSelection("paid"));
    document.getElementById("confirm-free-btn").addEventListener("click", () => confirmSelection("free"));
    document.getElementById("total-overall-btn").addEventListener("click", showOverallRevenue);

    document.getElementById("modal-cancel-btn").addEventListener("click", closeFreeModal);
    document.getElementById("modal-confirm-btn").addEventListener("click", confirmFreeSeat);

    document.getElementById("rename-cancel-btn").addEventListener("click", closeRenameModal);
    document.getElementById("rename-clear-btn").addEventListener("click", () => applyRename(null));
    document.getElementById("rename-confirm-btn").addEventListener("click", () => {
        const val = document.getElementById("rename-input").value.trim();
        applyRename(val === "" ? null : val);
    });

    document.getElementById("login-cancel-btn").addEventListener("click", closeLoginModal);
    document.getElementById("login-submit-btn").addEventListener("click", doLogin);

    document.addEventListener("pointermove", onPointerMove);
    document.addEventListener("pointerup", onPointerUp);

    setupViewportInteractions();

    if(window.innerWidth < 700) viewport.scale = 0.7;
    applyViewportTransform();

    await initAuth();
    await loadLayout();
    await loadBookingsForDate(currentDate);
}

window.addEventListener("DOMContentLoaded", init);
