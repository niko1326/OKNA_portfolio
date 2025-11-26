(function () {
  // ========= KONFIG =========
  const API = window.BK_API_BASE; // ustawiony w /rezerwacja/index.html lub w cennik/index.html
  if (!API) {
    console.warn("BK_API_BASE nie jest ustawione");
  }

  // ========= ELEMENTY =========
  const $grid = document.getElementById("bk-grid");
  const $form = document.getElementById("bookingForm");
  const $status = document.getElementById("bk-status");
  const $hint = document.getElementById("bk-hint");
  const $offer = document.getElementById("bk-offer");
  const $prev = document.getElementById("bk-prev");
  const $next = document.getElementById("bk-next");
  const $title = document.getElementById("bk-title");
  const $refresh = document.getElementById("bk-refresh"); // opcjonalny

  // ========= STAN =========
  let requiredBlocks = null; // ile bloków musi wybrać klient (z oferty / kalkulatora)
  let blockMinutes = 60; // długość bloku (wykrywana z API lub 60m)
  let weekData = []; // [{date:'YYYY-MM-DD', slots:[{time, available}]}]
  let selection = {
    date: null,
    times: [],
  }; // aktualnie wybrane czasy dla jednego dnia
  let currentWeekStart = null;
  const weekCache = new Map();
  let inflight = null; // { controller, startISO }
  const DEFAULT_BLOCK_MIN = 60;
  let currentReqId = 0;
  let isLoading = false;
  let calcMeta = null; // stan z kalkulatora (BK_CALC_STATE)

  // ========= UTILS =========

  // Live format telefonu z użyciem onlyDigits / formatDisplay / isValidPhone
  function attachPhoneFormatting() {
    const $prefix = document.getElementById("bk-prefix");
    const $phone = document.getElementById("bk-phone");
    if (!$prefix || !$phone) return;

    // placeholder pod PL/inne
    function updatePlaceholder() {
      $phone.placeholder =
        $prefix.value === "+48" ? "123 123 123" : "wpisz numer";
    }

    // ile cyfr jest przed kursorem
    function digitsBeforeCaret(input) {
      const pos = input.selectionStart || 0;
      let count = 0;
      for (let i = 0; i < pos; i++) if (/\d/.test(input.value[i])) count++;
      return count;
    }

    // ustaw kursor po N-tej cyfrze w sformatowanym stringu
    function setCaretByDigitIndex(input, digitIndex, formatted) {
      if (digitIndex <= 0) {
        input.value = formatted;
        input.setSelectionRange(0, 0);
        return;
      }
      let seen = 0,
        pos = formatted.length;
      for (let i = 0; i < formatted.length; i++) {
        if (/\d/.test(formatted[i])) seen++;
        if (seen === digitIndex) {
          pos = i + 1;
          break;
        }
      }
      input.value = formatted;
      input.setSelectionRange(pos, pos);
    }

    // właściwe formatowanie na żywo
    function reformatPreservingCaret() {
      const before = digitsBeforeCaret($phone); // liczba cyfr przed kursem
      const raw = onlyDigits($phone.value); // -> helper
      const fmt = formatDisplay($prefix.value, raw); // -> helper
      setCaretByDigitIndex($phone, Math.min(before, raw.length), fmt);
    }

    // podpięcie eventów
    $phone.addEventListener("input", reformatPreservingCaret);
    $phone.addEventListener("blur", reformatPreservingCaret);
    $phone.addEventListener("paste", () =>
      setTimeout(reformatPreservingCaret)
    );
    $prefix.addEventListener("change", () => {
      updatePlaceholder();
      reformatPreservingCaret();
    });

    // start
    updatePlaceholder();
    reformatPreservingCaret();
  }

  // ===== integracja z kalkulatorem na stronie cennika =====
  function applyCalcStateFromCalculator() {
    if (!window.BK_CALC_STATE) return;

    calcMeta = window.BK_CALC_STATE;

    // jeśli mamy dodatni wynik – ustaw wymaganą liczbę bloków
    if (typeof calcMeta.blocks === "number" && calcMeta.blocks > 0) {
      requiredBlocks = calcMeta.blocks;
    } else {
      requiredBlocks = null;
    }

    // opis oferty nad siatką – WERSJA B
    if ($offer) {
      if (requiredBlocks) {
        $offer.textContent = `Na podstawie kalkulatora: ${requiredBlocks} bloków`;
      } else {
        $offer.textContent = "Standardowe bloki godzinowe";
      }
    }

    // po zmianie requiredBlocks warto odświeżyć zaznaczenia
    if ($grid && weekData && weekData.length) {
      const tbl = $grid.querySelector('div[style*="grid-template-columns"]');
      if (tbl) {
        repaintAll(tbl);
      }
    }
  }

  function onlyDigits(s) {
    return (s || "").replace(/\D+/g, "");
  }

  function formatDisplay(prefix, rawDigits) {
    // PL: 9 cyfr → 3-3-3, inne: grupy po 3
    if (prefix === "+48") {
      const d = rawDigits.slice(0, 9);
      return d.replace(
        /(\d{3})(\d{0,3})(\d{0,3}).*/,
        (_, a, b, c) => [a, b, c].filter(Boolean).join(" ")
      );
    }
    // ogólnie: do 15 cyfr, grupy 3-3-3-...
    const d = rawDigits.slice(0, 15);
    return d.replace(/(\d{1,3})(?=(\d{3})+(?!\d))/g, "$& ").trim();
  }

  function isValidPhone(prefix, rawDigits) {
    if (prefix === "+48") return rawDigits.length === 9;
    return rawDigits.length >= 7 && rawDigits.length <= 15; // E.164
  }

  function rangeHours(start = 7, end = 18, step = DEFAULT_BLOCK_MIN) {
    const out = [];
    for (let m = start * 60; m <= end * 60 - step; m += step) {
      const H = String(Math.floor(m / 60)).padStart(2, "0");
      const M = String(m % 60).padStart(2, "0");
      out.push(`${H}:${M}`);
    }
    return out;
  }

  function renderSkeleton() {
    $grid.innerHTML = "";
    const tbl = document.createElement("div");
    Object.assign(tbl.style, {
      display: "grid",
      gridTemplateColumns: "repeat(7,1fr)",
      gap: "8px",
      width: "100%",
    });

    // head
    for (let i = 0; i < 7; i++) {
      const h = document.createElement("div");
      Object.assign(h.style, {
        fontWeight: "700",
        textAlign: "center",
        padding: "6px 4px",
        borderRadius: "10px",
        border: "1px solid var(--line)",
        background: "var(--card)",
      });
      h.textContent = wkdays[i];
      tbl.appendChild(h);
    }

    const hours = rangeHours();
    for (const hhmm of hours) {
      for (let i = 0; i < 7; i++) {
        const cell = document.createElement("div");
        Object.assign(cell.style, {
          border: "1px solid var(--line)",
          borderRadius: "12px",
          minHeight: "44px",
          background: "color-mix(in oklab, var(--card) 70%, transparent)",
          position: "relative",
          overflow: "hidden",
        });
        // prosty shimmer
        const shim = document.createElement("div");
        Object.assign(shim.style, {
          position: "absolute",
          inset: "0",
          transform: "translateX(-100%)",
          background:
            "linear-gradient(90deg, transparent, color-mix(in oklab, var(--line) 60%, transparent), transparent)",
          animation: "sh 1.2s infinite",
        });
        cell.appendChild(shim);
        tbl.appendChild(cell);
      }
    }
    // animacja (raz wstrzykujemy)
    const id = "bk-shimmer";
    if (!document.getElementById(id)) {
      const s = document.createElement("style");
      s.id = id;
      s.textContent = "@keyframes sh{to{transform:translateX(100%)}}";
      document.head.appendChild(s);
    }
    $grid.appendChild(tbl);
  }

  function setLoading(on) {
    isLoading = on;
    if (on) {
      renderSkeleton();
      setStatus("Ładuję tydzień…");
    } else {
      setStatus("");
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

  const wkdays = ["Pn", "Wt", "Śr", "Cz", "Pt", "So", "Nd"];

  function todayISO() {
    const d = new Date();
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  }

  function addDaysISO(iso, days) {
    const d = new Date(iso + "T00:00:00");
    d.setDate(d.getDate() + days);
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  }

  function toISO(d) {
    const off = d.getTimezoneOffset();
    return new Date(d.getTime() - off * 60000).toISOString().slice(0, 10);
  }

  function fmtDDMM(iso) {
    // "YYYY-MM-DD" -> "DD.MM"
    return iso.slice(8, 10) + "." + iso.slice(5, 7);
  }

  function startOfWeekISO(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    // poniedziałek jako 1… niedziela 0 → dostosuj do poniedziałku
    const day = (d.getDay() + 6) % 7; // 0=pon
    d.setDate(d.getDate() - day);
    return toISO(d);
  }

  function setStatus(msg) {
    if ($status) $status.textContent = msg || "";
  }

  function parseParams() {
    return new URLSearchParams(location.search);
  }

  function hhmmToDate(dateStr, hhmm) {
    const [H, M] = hhmm.split(":").map(Number);
    const [y, m, d] = dateStr.split("-").map(Number);
    return new Date(y, m - 1, d, H, M, 0, 0);
  }

  function msDiffMin(a, b) {
    return Math.round((b - a) / 60000);
  }

  function isConsecutive(dateStr, chosen, stepMin) {
    if (chosen.length <= 1) return true;
    const times = chosen
      .map((t) => hhmmToDate(dateStr, t))
      .sort((a, b) => a - b);
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
    const [H, M] = hhmm.split(":").map(Number);
    const d = new Date(2000, 0, 1, H, M, 0, 0);
    d.setMinutes(d.getMinutes() + mins);
    return `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes()
    ).padStart(2, "0")}`;
  }

  function rangeLabel(hhmm) {
    const end = addMinutes(hhmm, blockMinutes);
    // pokazujemy tylko godziny, bez minut
    const startHour = parseInt(hhmm.split(":")[0], 10);
    const endHour = parseInt(end.split(":")[0], 10);
    return `${startHour}–${endHour}`;
  }

  function cmpHHMM(a, b) {
    return a === b ? 0 : a < b ? -1 : 1;
  }

  function nextHHMM(hhmm, stepMin = 60) {
    const [H, M] = hhmm.split(":").map(Number);
    const d = new Date(2000, 0, 1, H, M, 0, 0);
    d.setMinutes(d.getMinutes() + stepMin);
    return `${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes()
    ).padStart(2, "0")}`;
  }

  /** Zwraca pełną listę slotów od start do end włącznie, skok = blockMinutes */
  function rangeHHMM(start, end, stepMin) {
    const out = [];
    let t = start;
    while (cmpHHMM(t, end) <= 0) {
      out.push(t);
      t = nextHHMM(t, stepMin);
    }
    return out;
  }

  function repaintAll(tbl) {
    const buttons = tbl.querySelectorAll("button[data-date][data-time]");
    const sorted = selection.date ? [...selection.times].sort(cmpHHMM) : [];
    const left = sorted[0];
    const right = sorted[sorted.length - 1];

    buttons.forEach((btn) => {
      const date = btn.getAttribute("data-date");
      const time = btn.getAttribute("data-time");

      const day = weekData.find((d) => d.date === date);
      const slot = day?.slots.find((s) => s.time === time);
      const avail = !!(slot && slot.available && !isPast(date, time));

      const sel = selection.date === date && selection.times.includes(time);
      const middle = sel && sorted.length > 1 && time !== left && time !== right;

      // styl + (un)clickable
      btn.disabled = !avail || middle;
      btn.style.cursor = !avail || middle ? "not-allowed" : "pointer";
      btn.style.background = avail ? "var(--card)" : "var(--line)";
      btn.style.color = avail ? "inherit" : "var(--muted)";
      btn.style.outline = sel ? "2px solid var(--accent)" : "none";
    });
  }

  // ========= RENDER =========
  function renderWeek() {
    $grid.innerHTML = "";
    if (!weekData.length) {
      $grid.textContent = "Brak danych";
      return;
    }

    const hours = weekData[0].slots.map((s) => s.time);

    const tbl = document.createElement("div");
    tbl.style.display = "grid";
    tbl.style.gridTemplateColumns = "repeat(7, 1fr)"; // 7 kolumn – bez lewej etykiety
    tbl.style.gap = "8px";

    // nagłówek (7 komórek)
    for (let i = 0; i < 7; i++) {
      const d = weekData[i];
      const h = document.createElement("div");
      h.style.fontWeight = "700";
      h.style.textAlign = "center";
      h.style.padding = "6px 4px";
      h.style.borderRadius = "10px";
      h.style.border = "1px solid var(--line)";
      h.style.background = "var(--card)";
      h.innerHTML = `${wkdays[i]}<br><span class="bk-daynum">${fmtDDMM(d.date)}</span>`;
      // 🔴 highlight "today"
      if (d.date === todayISO()) {
        h.style.borderColor = "#e5484d";
        h.style.fontWeight = "800";
      }
      tbl.appendChild(h);
    }

    // rzędy godzin (po 7 komórek na wiersz)
    for (const hhmm of hours) {
      for (let dayIdx = 0; dayIdx < 7; dayIdx++) {
        const day = weekData[dayIdx];
        const slot = day.slots.find((s) => s.time === hhmm);

        // niedostępne, jeśli zajęte albo przeszłe
        const available = slot && slot.available && !isPast(day.date, hhmm);

        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = rangeLabel(hhmm); // "08:00–09:00"
        btn.title = `${day.date} ${hhmm}`;
        btn.setAttribute("data-date", day.date);
        btn.setAttribute("data-time", hhmm);

        Object.assign(btn.style, {
          border: "1px solid var(--line)",
          borderRadius: "12px",
          padding: "12px 10px",
          minHeight: "44px",
          background: available ? "var(--card)" : "var(--line)",
          color: available ? "inherit" : "var(--muted)",
          cursor: available ? "pointer" : "not-allowed",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontWeight: "600",
        });

        if (!available) btn.disabled = true;

        const selected = () =>
          selection.date === day.date && selection.times.includes(hhmm);
        const paint = () => {
          btn.style.outline = selected() ? "2px solid var(--accent)" : "none";
        };
        paint();

        if (available) {
          btn.addEventListener("click", () => {
            // wybór tylko w obrębie jednego dnia
            if (selection.date && selection.date !== day.date) {
              selection = { date: day.date, times: [hhmm] };
            } else {
              selection.date = day.date;

              const already = selection.times.includes(hhmm);
              if (already) {
                // pozwalamy odznaczać WYŁĄCZNIE skrajne elementy
                const sorted = [...selection.times].sort(cmpHHMM);
                const left = sorted[0];
                const right = sorted[sorted.length - 1];

                if (sorted.length === 1) {
                  selection.times = [];
                } else if (hhmm === left) {
                  selection.times = sorted.slice(1);
                } else if (hhmm === right) {
                  selection.times = sorted.slice(0, -1);
                } else {
                  // środek – nic nie robimy (będzie disabled przez repaintAll)
                  return;
                }
              } else {
                // dodawanie – rozszerz do pełnego CIĄGŁEGO zakresu
                if (selection.times.length === 0) {
                  selection.times = [hhmm];
                } else {
                  const sorted = [...selection.times].sort(cmpHHMM);
                  const leftCandidate =
                    cmpHHMM(hhmm, sorted[0]) < 0 ? hhmm : sorted[0];
                  const rightCandidate =
                    cmpHHMM(hhmm, sorted[sorted.length - 1]) > 0
                      ? hhmm
                      : sorted[sorted.length - 1];

                  const full = rangeHHMM(
                    leftCandidate,
                    rightCandidate,
                    blockMinutes
                  );

                  // sprawdź, czy po drodze wszystkie są dostępne
                  const isTimeAvail = (t) => {
                    const s = day.slots.find((x) => x.time === t);
                    return !!(s && s.available && !isPast(day.date, t));
                  };
                  if (!full.every(isTimeAvail)) {
                    // zakres zderza się z zajętym slotem – nic nie zmieniamy
                    return;
                  }
                  selection.times = full;
                }
              }

              // jeśli wymagane bloki – przytnij do żądanej długości, zostawiając zakres
              if (requiredBlocks && selection.times.length > requiredBlocks) {
                const sorted = [...selection.times].sort(cmpHHMM);
                // heurystyka: przycinamy od tej strony, gdzie kliknięto dalej
                if (
                  cmpHHMM(
                    hhmm,
                    sorted[Math.floor(sorted.length / 2)]
                  ) >= 0
                ) {
                  selection.times = sorted.slice(-requiredBlocks);
                } else {
                  selection.times = sorted.slice(0, requiredBlocks);
                }
              }
            }

            // odśwież wygląd całej siatki (blokuje środek)
            repaintAll(tbl);
          });
        }

        tbl.appendChild(btn);
      }
    }
    repaintAll(tbl);
    $grid.appendChild(tbl);
  }

  // ========= API =========
  async function fetchWeek(startISO, { preferCache = true } = {}) {
    const reqId = ++currentReqId; // token tego konkretnego żądania

    // 1) Szybka reakcja UI
    if (preferCache && weekCache.has(startISO)) {
      const cached = weekCache.get(startISO);
      weekData = cached.days;
      blockMinutes = cached.blockMinutes || DEFAULT_BLOCK_MIN;
      requiredBlocks = cached.requiredBlocks || requiredBlocks;
      currentWeekStart = startISO;
      setWeekTitle();
      renderWeek(); // natychmiastowy render z cache
      setStatus("");
    } else {
      setLoading(true); // skeleton na czas sieci
    }

    // 2) Anuluj poprzednie żądanie
    if (inflight && inflight.controller) inflight.controller.abort();
    const controller = new AbortController();
    inflight = { controller, startISO };

    try {
      const params = new URLSearchParams({ action: "week", start: startISO });
      const urlp = parseParams();
      if (urlp.get("job") && urlp.get("sig")) {
        params.set("job", urlp.get("job"));
        params.set("sig", urlp.get("sig"));
      }

      const res = await fetch(`${API}?${params.toString()}`, {
        method: "GET",
        mode: "cors",
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();

      // 3) Jeżeli w międzyczasie użytkownik kliknął dalej → ignorujemy ten wynik
      if (reqId !== currentReqId) return;

      // 4) Zapisz do cache + odśwież UI
      const pack = {
        days: data.days || [],
        blockMinutes: data.blockMinutes || DEFAULT_BLOCK_MIN,
        requiredBlocks: data.requiredBlocks || null,
      };
      weekCache.set(startISO, pack);

      weekData = pack.days;
      blockMinutes = pack.blockMinutes;
      // jeśli backend nic nie narzuca, zostaje to, co ustawił kalkulator
      requiredBlocks = pack.requiredBlocks || requiredBlocks;
      currentWeekStart = startISO;
      setWeekTitle();

      renderWeek();

      // nadpisz info z kalkulatora (jeśli jest) – wersja "B"
      applyCalcStateFromCalculator();

      setLoading(false); // skeleton znika

      // 5) Prefetch sąsiadów (w tle, bez wpływu na UI)
      prefetchNeighbors(startISO);
    } catch (err) {
      if (err.name === "AbortError") return; // przerwane – nic nie robimy
      if (reqId !== currentReqId) return; // nieaktualne – też nic
      console.error(err);
      setStatus("Błąd pobierania tygodnia.");
    } finally {
      if (reqId === currentReqId) inflight = null;
    }
  }

  function prefetchNeighbors(startISO) {
    const prev = addDaysISO(startISO, -7);
    const next = addDaysISO(startISO, +7);

    [prev, next].forEach(async (s) => {
      if (weekCache.has(s)) return;
      try {
        const params = new URLSearchParams({ action: "week", start: s });
        const urlp = parseParams();
        if (urlp.get("job") && urlp.get("sig")) {
          params.set("job", urlp.get("job"));
          params.set("sig", urlp.get("sig"));
        }
        const res = await fetch(`${API}?${params.toString()}`, {
          method: "GET",
          mode: "cors",
        });
        if (!res.ok) return;
        const data = await res.json();
        const pack = {
          days: data.days || [],
          blockMinutes: data.blockMinutes || DEFAULT_BLOCK_MIN,
          requiredBlocks: data.requiredBlocks || null,
        };
        weekCache.set(s, pack);
      } catch (_) {
        /* cicho ignorujemy błędy prefetchu */
      }
    });
  }

  async function submitBooking(ev) {
    ev.preventDefault();
    const date = selection.date;
    const chosen = [...selection.times].sort();

    const name = document.getElementById("bk-name").value.trim();
    const prefix = document.getElementById("bk-prefix").value;
    const phoneDisplay = document.getElementById("bk-phone").value;
    const phoneRaw = onlyDigits(phoneDisplay);
    const email = document.getElementById("bk-email").value.trim();
    const address = document.getElementById("bk-address").value.trim();
    const notes = document.getElementById("bk-notes").value.trim();

    const requireCalcSelection = !!window.BK_REQUIRE_CALC_SELECTION;
    const calcState = window.BK_CALC_STATE || {};

    // MINIMALNA WARTOŚĆ ZLECENIA – 100 zł PO RABACIE
    if (requireCalcSelection) {
      const basePrice = calcState.totalPrice || 0;           // cena przed rabatem
      const percent   = calcState.discountPercent || 0;      // % rabatu z kalkulatora
      const finalPrice = percent > 0
        ? Math.round(basePrice * (1 - percent / 100))
        : basePrice;

      if (finalPrice > 0 && finalPrice < 100) {
        setStatus("Minimalna wartość zlecenia to 100 zł (liczona po rabacie). Dodaj więcej okien, aby kontynuować.");
        return;
      }
    }

    if (requireCalcSelection && (!calcState.windowsCount || calcState.windowsCount <= 0)) {
      setStatus("Najpierw wybierz przybliżoną liczbę okien w kalkulatorze powyżej.");
      return;
    }

    if (!isValidPhone(prefix, phoneRaw)) {
      setStatus(
        prefix === "+48"
          ? "Numer telefonu musi mieć 9 cyfr (format: 123 123 123)."
          : "Numer telefonu powinien mieć od 7 do 15 cyfr."
      );
      return;
    }

    // prosta walidacja e-mail
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setStatus("Podaj poprawny adres e-mail.");
      return;
    }

    const phoneE164 = prefix + phoneRaw; // np. +48123123123

    if (!date || chosen.length === 0) {
      setStatus("Zaznacz bloki w jednym dniu.");
      return;
    }
    if (requiredBlocks && chosen.length !== requiredBlocks) {
      setStatus(`Wybierz dokładnie ${requiredBlocks} blok(i).`);
      return;
    }
    if (!isConsecutive(date, chosen, blockMinutes)) {
      setStatus("Wybierz kolejne bloki.");
      return;
    }

    setStatus("Wysyłam zgłoszenie…");
    try {
      const body = new URLSearchParams({
        action: "book",
        date,
        name,
        phone: phoneE164,
        email,
        address,
        notes,
        blocks: JSON.stringify(chosen),
      });

      // dorzucamy dane z kalkulatora (jeśli są)
      if (calcMeta) {
        body.set("calcText", calcMeta.text || "");
        body.set(
          "calcTextClient",
          calcMeta.textClient || calcMeta.text || ""
        ); // skrót dla klienta
        body.set("calcBlocks", String(calcMeta.blocks || ""));
        body.set("calcWindows", String(calcMeta.windowsCount || 0));
        body.set("calcPrice", String(calcMeta.totalPrice || 0));
        body.set("calcTimeMin", String(calcMeta.totalMinutes || 0));
      }

      const urlp = parseParams();
      if (urlp.get("job") && urlp.get("sig")) {
        body.set("job", urlp.get("job"));
        body.set("sig", urlp.get("sig"));
      }

      const res = await fetch(API, {
        method: "POST",
        body,
      });

      const data = await res.json();
      if (data.ok) {
        // zapisz pakiet do sessionStorage (widoczny po przejściu na /)
        sessionStorage.setItem(
          "booking_success",
          JSON.stringify({
            date,
            times: chosen, // np. ["12:00","13:00"]
            bmin: blockMinutes, // długość bloku (żeby poprawnie policzyć koniec)
            name,
          })
        );

        // przekieruj na stronę główną
        window.location.href = "/";
        return;
      }

      setStatus(data.message || "Błąd serwera — spróbuj później.");
    } catch (err) {
      console.error(err);
      setStatus("Błąd serwera — spróbuj później.");
    }
  }

  // ========= INIT =========
  (function init() {
    currentWeekStart = startOfWeekISO(todayISO());
    fetchWeek(currentWeekStart);

    // spróbuj od razu użyć stanu z kalkulatora (jeśli już policzony)
    applyCalcStateFromCalculator();

    // reaguj na kolejne zmiany kalkulatora (cennik wysyła custom event)
    window.addEventListener("bk-calc-change", () => {
      applyCalcStateFromCalculator();
    });

    $prev?.addEventListener("click", () => {
      const target = addDaysISO(currentWeekStart, -7);
      fetchWeek(target);
    });
    $next?.addEventListener("click", () => {
      const target = addDaysISO(currentWeekStart, +7);
      fetchWeek(target);
    });

    $refresh?.addEventListener("click", () => fetchWeek(currentWeekStart));
    $form?.addEventListener("submit", submitBooking);
    attachPhoneFormatting();
  })();
})();
