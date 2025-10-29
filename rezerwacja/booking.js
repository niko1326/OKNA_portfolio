(function() {
    // ========= KONFIG =========
    const API = window.BK_API_BASE; // ustawiony w /rezerwacja/index.html
    if (!API) {
        console.warn('BK_API_BASE nie jest ustawione');
    }

    // ========= ELEMENTY =========
    const $grid = document.getElementById('bk-grid');
    const $form = document.getElementById('bookingForm');
    const $status = document.getElementById('bk-status');
    const $hint = document.getElementById('bk-hint');
    const $offer = document.getElementById('bk-offer');
    const $refresh = document.getElementById('bk-refresh');
    const $prev = document.getElementById('bk-prev');
    const $next = document.getElementById('bk-next');
    const $title = document.getElementById('bk-title');


    // ========= STAN =========
    let requiredBlocks = null; // ile bloków musi wybrać klient (z oferty)
    let blockMinutes = 60; // długość bloku (wykrywana lub 60m)
    let weekData = []; // [{date:'YYYY-MM-DD', slots:[{time, available}]}]
    let selection = {
        date: null,
        times: []
    }; // aktualnie wybrane czasy dla jednego dnia
    let currentWeekStart = null;
    const weekCache = new Map();
    let inflight = null;                   // { controller, startISO }
    const DEFAULT_BLOCK_MIN = 60;
    let currentReqId = 0;                  // <<< NOWE
    let isLoading = false;                 // <<< NOWE


    // ========= UTILS =========
    function rangeHours(start=7, end=18, step=DEFAULT_BLOCK_MIN){
  const out = [];
  for(let m=start*60; m <= (end*60 - step); m+=step){
    const H = String(Math.floor(m/60)).padStart(2,'0');
    const M = String(m%60).padStart(2,'0');
    out.push(`${H}:${M}`);
  }
  return out;
}

function renderSkeleton(){
  $grid.innerHTML = '';
  const tbl = document.createElement('div');
  Object.assign(tbl.style, { display:'grid', gridTemplateColumns:'repeat(7,1fr)', gap:'8px', width:'100%' });

  // head
  for(let i=0;i<7;i++){
    const h = document.createElement('div');
    Object.assign(h.style, {fontWeight:'700',textAlign:'center',padding:'6px 4px',borderRadius:'10px',border:'1px solid var(--line)',background:'var(--card)'});
    h.textContent = wkdays[i];
    tbl.appendChild(h);
  }

  const hours = rangeHours();
  for(const hhmm of hours){
    for(let i=0;i<7;i++){
      const cell = document.createElement('div');
      Object.assign(cell.style, {
        border:'1px solid var(--line)', borderRadius:'12px', minHeight:'44px',
        background:'color-mix(in oklab, var(--card) 70%, transparent)',
        position:'relative', overflow:'hidden'
      });
      // prosty shimmer
      const shim = document.createElement('div');
      Object.assign(shim.style, {
        position:'absolute', inset:'0', transform:'translateX(-100%)',
        background:'linear-gradient(90deg, transparent, color-mix(in oklab, var(--line) 60%, transparent), transparent)',
        animation:'sh 1.2s infinite'
      });
      cell.appendChild(shim);
      tbl.appendChild(cell);
    }
  }
  // animacja (raz wstrzykujemy)
  const id = 'bk-shimmer';
  if(!document.getElementById(id)){
    const s = document.createElement('style'); s.id = id;
    s.textContent = '@keyframes sh{to{transform:translateX(100%)}}';
    document.head.appendChild(s);
  }
  $grid.appendChild(tbl);
}

function setLoading(on){
  isLoading = on;
  if (on) {
    renderSkeleton();
    setStatus('Ładuję tydzień…');
  } else {
    setStatus('');
    // nic nie trzeba czyścić – renderWeek() nadpisuje #bk-grid
  }
}


    function setWeekTitle() {
        if (!$title) return;
        // currentWeekStart = YYYY-MM-DD (poniedziałek)
        const start = currentWeekStart;
        const end = addDaysISO(currentWeekStart, 6); // niedziela
        $title.textContent = `Tydzień ${fmtDDMM(start)}–${fmtDDMM(end)}`;
    }

    const wkdays = ['Pn', 'Wt', 'Śr', 'Cz', 'Pt', 'So', 'Nd'];

    function todayISO() {
        const d = new Date();
        const off = d.getTimezoneOffset();
        return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
    }

    function addDaysISO(iso, days) {
        const d = new Date(iso + 'T00:00:00');
        d.setDate(d.getDate() + days);
        const off = d.getTimezoneOffset();
        return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
    }

    function toISO(d) {
        const off = d.getTimezoneOffset();
        return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
    }

    function fmtDDMM(iso){ // "YYYY-MM-DD" -> "DD.MM"
    return iso.slice(8,10) + "." + iso.slice(5,7);
    }

    function startOfWeekISO(dateStr) {
        const d = new Date(dateStr + 'T00:00:00');
        // poniedziałek jako 1… niedziela 0 → dostosuj do poniedziałku
        const day = (d.getDay() + 6) % 7; // 0=pon
        d.setDate(d.getDate() - day);
        return toISO(d);
    }

    function setStatus(msg) {
        $status.textContent = msg || '';
    }

    function parseParams() {
        return new URLSearchParams(location.search);
    }

    function hhmmToDate(dateStr, hhmm) {
        const [H, M] = hhmm.split(':').map(Number);
        const [y, m, d] = dateStr.split('-').map(Number);
        return new Date(y, m - 1, d, H, M, 0, 0);
    }

    function msDiffMin(a, b) {
        return Math.round((b - a) / 60000);
    }

    function isConsecutive(dateStr, chosen, stepMin) {
        if (chosen.length <= 1) return true;
        const times = chosen.map(t => hhmmToDate(dateStr, t)).sort((a, b) => a - b);
        for (let i = 1; i < times.length; i++)
            if (msDiffMin(times[i - 1], times[i]) !== stepMin) return false;
        return true;
    }

    function isPast(dateStr, hhmm) {
        const now = new Date();
        const slotStart = hhmmToDate(dateStr, hhmm);
        return slotStart < now;
    }

    function addMinutes(hhmm, mins) {
        const [H, M] = hhmm.split(':').map(Number);
        const d = new Date(2000, 0, 1, H, M, 0, 0);
        d.setMinutes(d.getMinutes() + mins);
        return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    }

    function rangeLabel(hhmm){
    const end = addMinutes(hhmm, blockMinutes);
    // pokaż tylko godziny, bez minut
    const startHour = parseInt(hhmm.split(':')[0], 10);
    const endHour = parseInt(end.split(':')[0], 10);
    return `${startHour}–${endHour}`;
    }

    // ========= RENDER =========
    function renderWeek() {
        $grid.innerHTML = '';
        if (!weekData.length) {
            $grid.textContent = 'Brak danych';
            return;
        }

        const hours = weekData[0].slots.map(s => s.time);

        const tbl = document.createElement('div');
        tbl.style.display = 'grid';
        tbl.style.gridTemplateColumns = 'repeat(7, 1fr)'; // 7 kolumn – bez lewej etykiety
        tbl.style.gap = '8px';

        // nagłówek (7 komórek)
        for (let i = 0; i < 7; i++) {
            const d = weekData[i];
            const h = document.createElement('div');
            h.style.fontWeight = '700';
            h.style.textAlign = 'center';
            h.style.padding = '6px 4px';
            h.style.borderRadius = '10px';
            h.style.border = '1px solid var(--line)';
            h.style.background = 'var(--card)';
            h.innerHTML = `${wkdays[i]}<br>${fmtDDMM(d.date)}`;
            tbl.appendChild(h);
        }

        // rzędy godzin (po 7 komórek na wiersz)
        for (const hhmm of hours) {
            for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
                const day = weekData[dayIdx];
                const slot = day.slots.find(s => s.time === hhmm);

                // niedostępne, jeśli zajęte albo przeszłe
                const available = slot && slot.available && !isPast(day.date, hhmm);

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.textContent = rangeLabel(hhmm); // "08:00–09:00"
                btn.title = `${day.date} ${hhmm}`;

                // WYGLĄD: jedna linia, środek, większy „klik”
                Object.assign(btn.style, {
                    border: '1px solid var(--line)',
                    borderRadius: '12px',
                    padding: '12px 10px',
                    minHeight: '44px',
                    background: available ? 'var(--card)' : 'var(--line)',
                    color: available ? 'inherit' : 'var(--muted)',
                    cursor: available ? 'pointer' : 'not-allowed',
                    whiteSpace: 'nowrap', // NIE ZAWIJAJ
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontWeight: '600'
                });

                if (!available) btn.disabled = true;

                const selected = () => selection.date === day.date && selection.times.includes(hhmm);
                const paint = () => {
                    btn.style.outline = selected() ? '2px solid var(--accent)' : 'none';
                };
                paint();

                if (available) {
                    btn.addEventListener('click', () => {
                        // wybór tylko w obrębie jednego dnia
                        if (selection.date && selection.date !== day.date) {
                            selection = {
                                date: day.date,
                                times: [hhmm]
                            };
                        } else {
                            selection.date = day.date;
                            const idx = selection.times.indexOf(hhmm);
                            if (idx >= 0) selection.times.splice(idx, 1);
                            else selection.times.push(hhmm);
                        }
                        if (requiredBlocks && selection.times.length > requiredBlocks) {
                            selection.times.sort();
                            selection.times = selection.times.slice(-requiredBlocks);
                        }
                        // odśwież zaznaczenie
                        [...tbl.querySelectorAll('button')].forEach(b => b.style.outline = 'none');
                        for (const t of selection.times) {
                            const q = `button[title="${selection.date} ${t}"]`;
                            const el = tbl.querySelector(q);
                            if (el) el.style.outline = '2px solid var(--accent)';
                        }
                    });
                }

                tbl.appendChild(btn);
            }
        }
        $grid.appendChild(tbl);
    }


    // ========= API =========
async function fetchWeek(startISO, { preferCache = true } = {}) {
  const reqId = ++currentReqId;          // token tego konkretnego żądania

  // 1) Szybka reakcja UI
  if (preferCache && weekCache.has(startISO)) {
    const cached = weekCache.get(startISO);
    weekData       = cached.days;
    blockMinutes   = cached.blockMinutes || DEFAULT_BLOCK_MIN;
    requiredBlocks = cached.requiredBlocks || null;
    currentWeekStart = startISO;
    setWeekTitle();
    renderWeek();                         // natychmiastowy render z cache
    setStatus('');
  } else {
    setLoading(true);                     // skeleton na czas sieci
  }

  // 2) Anuluj poprzednie żądanie
  if (inflight && inflight.controller) inflight.controller.abort();
  const controller = new AbortController();
  inflight = { controller, startISO };

  try {
    const params = new URLSearchParams({ action: 'week', start: startISO });
    const urlp = parseParams();
    if (urlp.get('job') && urlp.get('sig')) {
      params.set('job', urlp.get('job'));
      params.set('sig', urlp.get('sig'));
    }

    const res = await fetch(`${API}?${params.toString()}`, { method: 'GET', mode: 'cors', signal: controller.signal });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();

    // 3) Jeżeli w międzyczasie użytkownik kliknął dalej → ignorujemy ten wynik
    if (reqId !== currentReqId) return;

    // 4) Zapisz do cache + odśwież UI
    const pack = {
      days: data.days || [],
      blockMinutes: data.blockMinutes || DEFAULT_BLOCK_MIN,
      requiredBlocks: data.requiredBlocks || null
    };
    weekCache.set(startISO, pack);

    weekData       = pack.days;
    blockMinutes   = pack.blockMinutes;
    requiredBlocks = pack.requiredBlocks;
    currentWeekStart = startISO;
    setWeekTitle();

    const hints = [];
    if (requiredBlocks) hints.push(`wymagane: ${requiredBlocks} blok(i)`);
    hints.push(`blok: ${blockMinutes} min`);
    $hint.textContent = hints.join(' • ');
    $offer.textContent = requiredBlocks ? `Oferta: ${requiredBlocks}×${blockMinutes} min` : 'Standardowe bloki';

    renderWeek();
    setLoading(false);                    // <<< skeleton znika

    // 5) Prefetch sąsiadów (w tle, bez wpływu na UI)
    prefetchNeighbors(startISO);

  } catch (err) {
    if (err.name === 'AbortError') return;    // przerwane – nic nie robimy
    if (reqId !== currentReqId) return;       // nieaktualne – też nic
    console.error(err);
    setStatus('Błąd pobierania tygodnia.');
  } finally {
    if (reqId === currentReqId) inflight = null;
  }
}


    function prefetchNeighbors(startISO){
    const prev = addDaysISO(startISO, -7);
    const next = addDaysISO(startISO, +7);

    [prev, next].forEach(async (s) => {
        if (weekCache.has(s)) return;
        try{
        const params = new URLSearchParams({ action:'week', start:s });
        const urlp = parseParams();
        if (urlp.get('job') && urlp.get('sig')) {
            params.set('job', urlp.get('job'));
            params.set('sig', urlp.get('sig'));
        }
        const res = await fetch(`${API}?${params.toString()}`, { method:'GET', mode:'cors' });
        if (!res.ok) return;
        const data = await res.json();
        const pack = {
            days: data.days || [],
            blockMinutes: data.blockMinutes || DEFAULT_BLOCK_MIN,
            requiredBlocks: data.requiredBlocks || null
        };
        weekCache.set(s, pack);
        }catch(_){ /* cicho ignorujemy błędy prefetchu */ }
    });
    }




    async function submitBooking(ev) {
        ev.preventDefault();
        const date = selection.date;
        const chosen = [...selection.times].sort();

        const name = document.getElementById('bk-name').value.trim();
        const phone = document.getElementById('bk-phone').value.trim();
        const address = document.getElementById('bk-address').value.trim();
        const notes = document.getElementById('bk-notes').value.trim();

        if (!date || chosen.length === 0) {
            setStatus('Zaznacz bloki w jednym dniu.');
            return;
        }
        if (requiredBlocks && chosen.length !== requiredBlocks) {
            setStatus(`Wybierz dokładnie ${requiredBlocks} blok(i).`);
            return;
        }
        if (!isConsecutive(date, chosen, blockMinutes)) {
            setStatus('Wybierz kolejne bloki.');
            return;
        }

        setStatus('Wysyłam zgłoszenie…');
        try {
            const body = new URLSearchParams({
                action: 'book',
                date,
                name,
                phone,
                address,
                notes,
                blocks: JSON.stringify(chosen)
            });
            const urlp = parseParams();
            if (urlp.get('job') && urlp.get('sig')) {
                body.set('job', urlp.get('job'));
                body.set('sig', urlp.get('sig'));
            }
            const res = await fetch(API, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
                },
                body
            });
            const data = await res.json();
            if (data.ok) {
            setStatus('Zgłoszenie przyjęte!');
            $form.reset();
            selection = { date:null, times:[] };

            // odśwież tylko aktualny tydzień; cache usuwamy, żeby przyszły świeże dane
            weekCache.delete(currentWeekStart);
            fetchWeek(currentWeekStart, { preferCache: false });
            } else {
            setStatus(data.message || 'Nie udało się zarezerwować.');
            }


        } catch (err) {
            console.error(err);
            setStatus('Błąd serwera — spróbuj później.');
        }
    }

    // ========= INIT =========
    (function init() {
        currentWeekStart = startOfWeekISO(todayISO());
        fetchWeek(currentWeekStart);

        $prev?.addEventListener('click', () => {
        const target = addDaysISO(currentWeekStart, -7);
        // natychmiastowa zmiana (z cache lub skeleton), fetch w tle
        fetchWeek(target);
        });
        $next?.addEventListener('click', () => {
        const target = addDaysISO(currentWeekStart, +7);
        fetchWeek(target);
        });


        $refresh?.addEventListener('click', () => fetchWeek(currentWeekStart));
        $form?.addEventListener('submit', submitBooking);
    })();
})();