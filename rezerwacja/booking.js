(function(){
  // ========= KONFIG =========
  const API = window.BK_API_BASE; // ustawiony w /rezerwacja/index.html
  if(!API){ console.warn('BK_API_BASE nie jest ustawione'); }

  // ========= ELEMENTY =========
  const $grid   = document.getElementById('bk-grid');
  const $form   = document.getElementById('bookingForm');
  const $status = document.getElementById('bk-status');
  const $hint   = document.getElementById('bk-hint');
  const $offer  = document.getElementById('bk-offer');
  const $refresh= document.getElementById('bk-refresh');

  // ========= STAN =========
  let requiredBlocks = null;        // ile bloków musi wybrać klient (z oferty)
  let blockMinutes   = 60;          // długość bloku (wykrywana lub 60m)
  let weekData       = [];          // [{date:'YYYY-MM-DD', slots:[{time, available}]}]
  let selection      = { date:null, times:[] }; // aktualnie wybrane czasy dla jednego dnia

  // ========= UTILS =========
  const wkdays = ['Pn','Wt','Śr','Cz','Pt','So','Nd'];
  function todayISO(){
    const d = new Date();
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off*60000).toISOString().slice(0,10);
  }
  function toISO(d){
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off*60000).toISOString().slice(0,10);
  }
  function startOfWeekISO(dateStr){
    const d = new Date(dateStr + 'T00:00:00');
    // poniedziałek jako 1… niedziela 0 → dostosuj do poniedziałku
    const day = (d.getDay() + 6) % 7; // 0=pon
    d.setDate(d.getDate() - day);
    return toISO(d);
  }
  function setStatus(msg){ $status.textContent = msg || ''; }
  function parseParams(){ return new URLSearchParams(location.search); }

  function hhmmToDate(dateStr, hhmm){
    const [H,M] = hhmm.split(':').map(Number);
    const [y,m,d] = dateStr.split('-').map(Number);
    return new Date(y, m-1, d, H, M, 0, 0);
  }
  function msDiffMin(a,b){ return Math.round((b - a) / 60000); }
  function isConsecutive(dateStr, chosen, stepMin){
    if(chosen.length <= 1) return true;
    const times = chosen.map(t => hhmmToDate(dateStr, t)).sort((a,b)=>a-b);
    for(let i=1;i<times.length;i++) if(msDiffMin(times[i-1], times[i]) !== stepMin) return false;
    return true;
  }
  function isPast(dateStr, hhmm){
    const now = new Date();
    const slotStart = hhmmToDate(dateStr, hhmm);
    return slotStart < now;
  }
  function addMinutes(hhmm, mins){
    const [H,M] = hhmm.split(':').map(Number);
    const d = new Date(2000,0,1,H,M,0,0);
    d.setMinutes(d.getMinutes()+mins);
    return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
  function rangeLabel(hhmm){
    const end = addMinutes(hhmm, blockMinutes);
    return `${hhmm}–${end}`; // en dash
  }

  // ========= RENDER =========
  function renderWeek(){
    // zbuduj tabelę 7 kolumn (Pn-Nd), w wierszach godziny
    $grid.innerHTML = '';
    if(!weekData.length){ $grid.textContent = 'Brak danych'; return; }

    // ustal listę godzin z pierwszego dnia
    const hours = weekData[0].slots.map(s => s.time);

    const tbl = document.createElement('div');
    tbl.style.display = 'grid';
    tbl.style.gridTemplateColumns = 'repeat(8, 1fr)'; // 1 kolumna na etykiety godzin + 7 dni
    tbl.style.gap = '6px';

    // nagłówek
    const headEmpty = document.createElement('div'); tbl.appendChild(headEmpty);
    for(let i=0;i<7;i++){
      const d = weekData[i];
      const h = document.createElement('div');
      h.style.fontWeight = '600';
      h.style.textAlign = 'center';
      const label = `${wkdays[i]}\n${d.date.slice(5)}`;
      h.innerHTML = label.replace('\n','<br>');
      tbl.appendChild(h);
    }

    // wiersze godzin
    for(const hhmm of hours){
      const hourCell = document.createElement('div');
      hourCell.style.fontWeight = '600';
      hourCell.textContent = rangeLabel(hhmm);
      tbl.appendChild(hourCell);

      for(let dayIdx=0; dayIdx<7; dayIdx++){
        const day = weekData[dayIdx];
        const slot = day.slots.find(s => s.time === hhmm);

        // uwzględnij przeszłość: wszystko, co już minęło, jest niedostępne
        const available = slot && slot.available && !isPast(day.date, hhmm);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = rangeLabel(hhmm);
        btn.title = `${day.date} ${hhmm}`;
        btn.style.border = '1px solid var(--line)';
        btn.style.borderRadius = '10px';
        btn.style.padding = '10px';
        btn.style.minHeight = '42px';
        btn.style.background = available ? 'var(--card)' : 'var(--line)';
        btn.style.color = available ? 'inherit' : 'var(--muted)';
        btn.style.cursor = available ? 'pointer' : 'not-allowed';
        if(!available) btn.disabled = true;

        const selected = () => selection.date === day.date && selection.times.includes(hhmm);
        const paint = () => { btn.style.outline = selected() ? '2px solid var(--accent)' : 'none'; };
        paint();

        if(available){
          btn.addEventListener('click', () => {
            // wybór tylko w obrębie jednego dnia
            if(selection.date && selection.date !== day.date){
              selection = { date: day.date, times: [hhmm] };
            } else {
              selection.date = day.date;
              const idx = selection.times.indexOf(hhmm);
              if(idx >= 0) selection.times.splice(idx,1); else selection.times.push(hhmm);
            }
            // wymuś limit liczby bloków
            if(requiredBlocks && selection.times.length > requiredBlocks){
              selection.times.sort();
              selection.times = selection.times.slice(-requiredBlocks);
            }
            // podświetl i odśwież wszystkie przyciski
            [...tbl.querySelectorAll('button')].forEach(b => b.style.outline = 'none');
            for(const t of selection.times){
              const q = `button[title="${selection.date} ${t}"]`;
              const el = tbl.querySelector(q); if(el) el.style.outline = '2px solid var(--accent)';
            }
          });
        }

        tbl.appendChild(btn);
      }
    }

    $grid.appendChild(tbl);
  }

  // ========= API =========
  async function fetchWeek(startISO){
    setStatus('Ładuję tydzień…');
    try{
      const params = new URLSearchParams({ action:'week', start:startISO });
      const urlp = parseParams();
      if(urlp.get('job') && urlp.get('sig')){ params.set('job', urlp.get('job')); params.set('sig', urlp.get('sig')); }
      const res = await fetch(`${API}?${params.toString()}`, { method:'GET', mode:'cors' });
      if(!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      weekData = data.days || [];
      requiredBlocks = data.requiredBlocks || null;
      blockMinutes = data.blockMinutes || 60;

      // UI hinty
      const hints = [];
      if(requiredBlocks) hints.push(`wymagane: ${requiredBlocks} blok(i)`);
      hints.push(`blok: ${blockMinutes} min`);
      $hint.textContent = hints.join(' • ');
      $offer.textContent = requiredBlocks ? `Oferta: ${requiredBlocks}×${blockMinutes} min` : 'Standardowe bloki';

      renderWeek();
      setStatus('');
    }catch(err){ console.error(err); setStatus('Błąd pobierania tygodnia.'); }
  }

  async function submitBooking(ev){
    ev.preventDefault();
    const date = selection.date;
    const chosen = [...selection.times].sort();

    const name = document.getElementById('bk-name').value.trim();
    const phone = document.getElementById('bk-phone').value.trim();
    const address = document.getElementById('bk-address').value.trim();
    const notes = document.getElementById('bk-notes').value.trim();

    if(!date || chosen.length===0){ setStatus('Zaznacz bloki w jednym dniu.'); return; }
    if(requiredBlocks && chosen.length !== requiredBlocks){ setStatus(`Wybierz dokładnie ${requiredBlocks} blok(i).`); return; }
    if(!isConsecutive(date, chosen, blockMinutes)){ setStatus('Wybierz kolejne bloki.'); return; }

    setStatus('Wysyłam zgłoszenie…');
    try{
      const body = new URLSearchParams({ action:'book', date, name, phone, address, notes, blocks: JSON.stringify(chosen) });
      const urlp = parseParams();
      if(urlp.get('job') && urlp.get('sig')){ body.set('job', urlp.get('job')); body.set('sig', urlp.get('sig')); }
      const res = await fetch(API, { method:'POST', headers:{'Content-Type':'application/x-www-form-urlencoded;charset=UTF-8'}, body });
      const data = await res.json();
      if(data.ok){ setStatus('Zgłoszenie przyjęte!'); $form.reset(); selection={date:null,times:[]}; fetchWeek(startOfWeekISO(todayISO())); }
      else{ setStatus(data.message || 'Nie udało się zarezerwować.'); }
    }catch(err){ console.error(err); setStatus('Błąd serwera — spróbuj później.'); }
  }

  // ========= INIT =========
  (function init(){
    const start = startOfWeekISO(todayISO());
    fetchWeek(start);
    $refresh?.addEventListener('click', () => fetchWeek(startOfWeekISO(todayISO())));
    $form?.addEventListener('submit', submitBooking);
  })();
})();