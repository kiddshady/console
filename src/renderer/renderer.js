/* Console — Terminal · Renderer logic */
/* v0.1.0 — Terminal PTY + tabs + window controls + command palette */

/* ========== DIAGNOSTIC LOGGING ========== */
console.log('[CONSOLE] renderer.js loaded');
console.log('[CONSOLE] window.Terminal:', typeof window.Terminal);
console.log('[CONSOLE] window.FitAddon:', typeof window.FitAddon);
console.log('[CONSOLE] window.WebLinksAddon:', typeof window.WebLinksAddon);
console.log('[CONSOLE] window.umbrovex:', typeof window.umbrovex);
console.log('[CONSOLE] readyState:', document.readyState);

const Terminal = window.Terminal;
const FitAddon = window.FitAddon?.FitAddon || window.FitAddon;
const WebLinksAddon = window.WebLinksAddon?.WebLinksAddon || window.WebLinksAddon;
const WebglAddon = window.WebglAddon?.WebglAddon || window.WebglAddon;

const umbrovexAPI = window.umbrovex;

if (!Terminal) console.error('[CONSOLE] FATAL: window.Terminal is undefined! xterm.js did not load correctly.');
if (!FitAddon) console.error('[CONSOLE] FATAL: window.FitAddon is undefined! addon-fit did not load correctly.');
if (!umbrovexAPI) console.error('[CONSOLE] FATAL: window.umbrovex is undefined! preload.js did not load correctly.');

/* ========== STATE ========== */
const state = {
  tabs: [],
  activeTabId: null,
  tabIdCounter: 0,
  paletteOpen: false,
  paletteItems: [],
  paletteSelected: 0,
  currentView: 'sessions',
  snippets: [],
  snippetIdCounter: 0,
  history: [],
};

/* ========== THEME (xterm) ========== */
const CONSOLE_THEME = {
  // Transparente para que el grid de #terminal-container se vea a través del
  // terminal (con allowTransparency). Con WebGL, un bg opaco taparía el grid.
  background: 'rgba(10,10,15,0)',
  foreground: '#e0e0f0',
  cursor: '#00fff5',
  cursorAccent: '#0a0a0f',
  selectionBackground: 'rgba(0,255,245,.22)',
  black: '#0a0a0f',
  red: '#ff0044',
  green: '#00ff88',
  yellow: '#ffee00',
  blue: '#0088ff',
  magenta: '#ff00aa',
  cyan: '#00fff5',
  white: '#e0e0f0',
  brightBlack: '#555577',
  brightRed: '#ff5577',
  brightGreen: '#55ffaa',
  brightYellow: '#ffee55',
  brightBlue: '#55aaff',
  brightMagenta: '#ff55cc',
  brightCyan: '#55ffff',
  brightWhite: '#ffffff',
};

/* ========== TABS ========== */
// Parsea el payload de un OSC 7 (file://host/path) al path nativo del SO. Devuelve
// null si no se puede interpretar (dejamos el cwd anterior).
function parseOsc7Cwd(data) {
  if (!data) return null;
  let p = data;
  const m = /^file:\/\/[^/]*(\/.*)$/i.exec(data);
  if (m) p = m[1];
  try { p = decodeURIComponent(p); } catch { /* si el decode falla, usamos el raw */ }
  // Windows: file:///C:/... → /C:/... → sacamos la barra líder y usamos backslashes.
  if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
  if (umbrovexAPI && umbrovexAPI.platform === 'win32') p = p.replace(/\//g, '\\');
  return p || null;
}

// Tope de shells simultáneas. El guard vive acá (y no en cada entry point) para
// cubrir de una las tres vías: botón +, Ctrl+Shift+T y el command palette.
const MAX_TABS = 4;

function createTab(name) {
  if (state.tabs.length >= MAX_TABS) return null;
  const id = ++state.tabIdCounter;
  const tab = {
    id,
    name: name || `shell ${id}`,
    ptyId: null,
    term: null,
    fitAddon: null,
    cwd: umbrovexAPI.defaultCwd, // toda shell nueva arranca en C:\ (ver preload/main)
    cmdBuffer: '', // línea a medio tipear (para el history); por tab, no global
  };
  state.tabs.push(tab);
  state.activeTabId = id;
  renderTabs();
  // Animate the new tab in
  const newEl = document.querySelector(`.tab[data-tab-id="${id}"]`);
  if (newEl) {
    newEl.classList.add('tab-entering');
    newEl.addEventListener('animationend', () => newEl.classList.remove('tab-entering'), { once: true });
  }
  initTerminal(tab);
  return tab;
}

function closeTab(id) {
  const idx = state.tabs.findIndex(t => t.id === id);
  if (idx === -1) return;
  const tab = state.tabs[idx];
  const tabEl = document.querySelector(`.tab[data-tab-id="${id}"]`);
  const doClose = () => {
    if (tab.ptyId) umbrovexAPI.pty.kill(tab.ptyId);
    if (tab.term) tab.term.dispose();
    state.tabs.splice(idx, 1);
    if (state.activeTabId === id) {
      state.activeTabId = state.tabs[0]?.id || null;
    }
    renderTabs();
    if (state.activeTabId) switchTab(state.activeTabId);
    else if (state.tabs.length === 0) createTab();
  };
  if (tabEl) {
    tabEl.classList.add('tab-leaving');
    setTimeout(doClose, 180);
  } else {
    doClose();
  }
}

// Enfoca la terminal del tab activo cuando la ventana recupera el foco (alt-tab,
// click en taskbar, tray, hotkey). Corre en rAF para pisar el restore de foco
// interno de Chromium, que si no puede devolverle el foco a otro elemento justo
// después. No robamos el foco si estás tipeando en otro campo (paleta, snippets):
// el helper-textarea del propio xterm se excluye para que enfocar la terminal sea
// idempotente cuando ya la tenías. Requiere cursorRevealed (no mostrar cursor antes
// del prompt).
function focusActiveTerminal() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (!tab?.term || !tab.cursorRevealed) return;
  const ae = document.activeElement;
  if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA')
      && !ae.classList.contains('xterm-helper-textarea')) return;
  requestAnimationFrame(() => tab.term.focus());
}

// Crossfade entre shells: los .term-instance se apilan en el mismo inset absoluto,
// así que fundimos opacidad entre el entrante y los salientes. El entrante suma una
// animación corta de entrada (fade + slide lateral); los inactivos vuelven a
// display:none recién al terminar su fade-out (así no conviven dos canvas WebGL
// pintando, y las shells ocultas no se comen layout/paint).
function showTerminalFor(id) {
  const targetId = `term-${id}`;
  document.querySelectorAll('.term-instance').forEach(el => {
    if (el.id === targetId) {
      clearTimeout(el._hideTimer);
      el.style.display = '';
      void el.offsetWidth; // comprometer opacity:0 antes de activar (si venía oculto)
      el.classList.add('term-active', 'term-switch-in');
      el.addEventListener('animationend', () => el.classList.remove('term-switch-in'), { once: true });
    } else if (el.classList.contains('term-active') || el.style.display !== 'none') {
      el.classList.remove('term-active');
      clearTimeout(el._hideTimer);
      el._hideTimer = setTimeout(() => {
        if (!el.classList.contains('term-active')) el.style.display = 'none';
      }, 200);
    }
  });
}

function switchTab(id) {
  const tab = state.tabs.find(t => t.id === id);
  if (!tab) return;
  // Click en el tab ya activo: sólo re-enfocar, sin re-disparar el fundido.
  if (state.activeTabId === id &&
      document.getElementById(`term-${id}`)?.classList.contains('term-active')) {
    if (tab.term) tab.term.focus();
    return;
  }
  state.activeTabId = id;
  showTerminalFor(id);          // crossfade: entra el activo, se desvanecen los demás
  if (tab.fitAddon) tab.fitAddon.fit();
  if (tab.term) tab.term.focus();
  renderTabs();
}

function renderTabs() {
  const container = document.getElementById('tabs');
  container.innerHTML = '';
  state.tabs.forEach(tab => {
    const el = document.createElement('div');
    el.className = `tab ${tab.id === state.activeTabId ? 'active' : ''}`;
    el.dataset.tabId = tab.id;
    el.innerHTML = `
      <span class="tab-dot"></span>
      <svg class="tab-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 17 10 11 4 5"></polyline><line x1="12" y1="19" x2="20" y2="19"></line></svg>
      <span class="tab-name">${escapeHtml(tab.name)}</span>
      <span class="tab-close"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg></span>
    `;
    el.addEventListener('click', (e) => {
      if (e.target.closest('.tab-close')) {
        closeTab(tab.id);
      } else {
        switchTab(tab.id);
      }
    });
    container.appendChild(el);
  });
  // Al límite de shells, el + se atenúa (la transición está en el CSS) y su tooltip
  // explica por qué no responde.
  const plusBtn = document.getElementById('new-tab');
  if (plusBtn) {
    const atLimit = state.tabs.length >= MAX_TABS;
    plusBtn.classList.toggle('at-limit', atLimit);
    plusBtn.dataset.tip = atLimit ? `Shell limit reached (${MAX_TABS} max)` : 'New tab (Ctrl+Shift+T)';
  }
}

/* ========== TERMINAL ========== */
function initTerminal(tab) {
  console.log('[CONSOLE] initTerminal called for tab', tab.id);
  const container = document.getElementById('terminal-container');

  // Create a div for this terminal instance
  const termEl = document.createElement('div');
  termEl.id = `term-${tab.id}`;
  termEl.className = 'term-instance';
  // OJO: el FitAddon mide ESTE elemento (padre del .xterm) y NO descuenta su
  // padding. Por eso el margen externo va como `inset` (posición), no como
  // `padding`: así el ancho que mide el FitAddon es exacto y el texto no se
  // desborda bajo la scrollbar. El gutter interno (texto↔scrollbar) va en el .xterm.
  // Derecha en 0: el .xterm-viewport es absolute con right:0, o sea que ignora el
  // padding del .xterm y su scrollbar queda pegada a este borde (como en settings).
  termEl.style.cssText = 'position:absolute;inset:14px 0 14px 18px;';
  container.appendChild(termEl);
  // Crossfade: el term nuevo entra con fundido y los demás se desvanecen.
  showTerminalFor(tab.id);

  if (!Terminal) {
    console.error('[CONSOLE] Cannot create terminal: Terminal constructor is undefined');
    termEl.innerHTML = '<pre style="color:#ff0044;padding:20px;font-family:monospace">[CONSOLE] Error: xterm.js no se cargó correctamente.\nRevisá la consola (Ctrl+Shift+I) para más info.</pre>';
    return;
  }

  let term;
  let fitAddon;
  try {
    term = new Terminal({
    fontFamily: "'JetBrains Mono', 'Cascadia Code', monospace",
    fontSize: 14,
    // 1.2 y no más: la ventana es de alto fijo, así que el line-height es lo único que
    // decide cuántas filas entran. A 1.5 daba 19 — apretado para los TUIs que se corren
    // acá adentro (Claude Code, vim, less), que se pasan la vida scrolleando. A 1.2 son
    // 24 (+26%) sin perder legibilidad con JetBrains Mono a 14px.
    lineHeight: 1.2,
    // Medio paso de peso más que el 400 por defecto: sobre el fondo casi negro el trazo
    // de JetBrains Mono a 400 se lava, y a 500 el texto se lee sin llegar a engordar.
    // Mismo peso que Console Mobile, que bundlea estos mismos .woff2.
    // No toca la grilla, por dos motivos independientes: el CharSizeService de xterm 5.5
    // mide la celda con fontSize + fontFamily nada más (el peso no entra en la medición),
    // y los cuatro pesos de JetBrains Mono son monoespaciados de verdad, con el mismo
    // avance — así que el glifo tampoco se sale de la celda ya medida.
    // El bold queda en 700: el contraste normal/negrita se mantiene igual.
    fontWeight: 500,
    fontWeightBold: 700,
    theme: CONSOLE_THEME,
    // Cursor block idéntico en reposo y al escribir: mismo estilo con y sin foco
    // (block), sin blink, así el halo cyan (glow div) lo acompaña siempre. Arranca
    // con inactiveStyle 'none' y SIN foco: el cursor no se dibuja hasta el reveal
    // (ver positionGlow), que lo pasa a 'block' + foco. Evita el "agujero" en (0,0)
    // antes de que cargue el profile.
    cursorStyle: 'block',
    cursorInactiveStyle: 'none',
    cursorBlink: false,
    allowTransparency: true,
    scrollback: 10000,
    convertEol: false,
  });

  fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  try { term.loadAddon(new WebLinksAddon()); } catch {}

  term.open(termEl);
    fitAddon.fit();
    // Red de seguridad para el race de la web font. Normalmente la shell 1 ya se crea
    // con JetBrains Mono cargada (init() espera document.fonts antes del primer
    // createTab), pero si por lo que sea xterm midió el glyph con el fallback, hay que
    // RE-MEDIR la celda, no solo re-fitear: fitAddon.fit() recomputa la grilla
    // (cols/rows) a partir de las métricas de celda YA cacheadas, así que corrige el
    // desborde horizontal pero deja el prompt corrido en vertical. Tocar una opción de
    // fuente dispara el CharSizeService de xterm, que vuelve a medir el glyph con la
    // fuente real; recién ahí fiteamos con las métricas correctas.
    const remeasure = () => {
      try {
        const ff = term.options.fontFamily;
        term.options.fontFamily = ff + ', monospace'; // cambio real → gatilla el re-measure
        term.options.fontFamily = ff;                 // volvemos al valor original, ya re-medido
        fitAddon.fit();
      } catch {}
    };
    requestAnimationFrame(remeasure);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(remeasure);

    // Renderer WebGL: dibuja en GPU y clippea la selección al viewport. Evita el
    // fantasma del DOM renderer (una selección scrolleada fuera de pantalla se
    // clampa al tope y pinta sobre texto no seleccionado). Fallback al DOM
    // renderer si el contexto WebGL se pierde o no está disponible.
    if (WebglAddon) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => { try { webgl.dispose(); } catch {} });
        term.loadAddon(webgl);
      } catch (e) {
        console.warn('[CONSOLE] WebGL no disponible, uso DOM renderer:', e && e.message);
      }
    }

    // Cursor glow: un div sigue al cursor y le pone el halo cyan (WebGL dibuja
    // el cursor en canvas, sin nodo DOM que pueda llevar el box-shadow).
    const glowEl = document.createElement('div');
    glowEl.className = 'cursor-glow';
    const positionGlow = () => {
      const screenEl = termEl.querySelector('.xterm-screen');
      const xtermEl = termEl.querySelector('.xterm');
      if (!screenEl || !xtermEl) return;
      if (glowEl.parentNode !== screenEl) screenEl.appendChild(glowEl);
      const buf = term.buffer.active;
      // Glow en reposo Y al escribir: el cursor es un block idéntico con o sin foco,
      // así que el halo cyan lo acompaña siempre. Excepciones donde se oculta: al
      // arrancar, con la terminal vacía y el cursor en el origen (0,0) el glow
      // quedaría pegado arriba a la izquierda sin prompt; cuando la app oculta el
      // cursor (DECTCEM ESC[?25l — spinners de CLIs, TUIs) xterm saca el block y el
      // glow no debe quedar flotando solo; tampoco scrolleado en el historial ni con
      // una selección activa.
      const atOrigin = buf.cursorX === 0 && buf.cursorY === 0; // terminal vacía / sin prompt aún
      if (!tab.shellStarted || atOrigin || tab.cursorHidden || buf.viewportY !== buf.baseY || term.hasSelection()) { glowEl.style.display = 'none'; return; }
      // Revelamos el cursor recién en el primer frame en que el glow se muestra: pasamos
      // el inactiveStyle a 'block' y enfocamos, así el block y su glow aparecen SIEMPRE
      // juntos, nunca antes (ni un "agujero" en 0,0). Una sola vez por tab.
      if (!tab.cursorRevealed) {
        tab.cursorRevealed = true;
        term.options.cursorInactiveStyle = 'block'; // de acá en más el block se ve con o sin foco
        term.focus();
      }
      const cw = screenEl.clientWidth / term.cols;
      const ch = screenEl.clientHeight / term.rows;
      glowEl.style.display = 'block';
      glowEl.style.left = (buf.cursorX * cw) + 'px';
      glowEl.style.top = (buf.cursorY * ch) + 'px';
      glowEl.style.width = cw + 'px';
      glowEl.style.height = ch + 'px';
    };
    term.onCursorMove(positionGlow);
    term.onRender(positionGlow);
    term.onSelectionChange(positionGlow);
    // El foco togglea la clase .focus en el .xterm. Aunque el cursor ya no cambia
    // de forma con el foco, observamos ese atributo para re-evaluar el glow en las
    // transiciones de foco de forma confiable (más robusto que focusin/focusout).
    const xtermForObs = termEl.querySelector('.xterm');
    if (xtermForObs && window.MutationObserver) {
      new MutationObserver(positionGlow).observe(xtermForObs, { attributes: true, attributeFilter: ['class'] });
    }
    requestAnimationFrame(positionGlow);

    // DECTCEM (ESC[?25h / ESC[?25l): las apps que ocultan el cursor —spinners de CLIs,
    // TUIs como vim/less— sacan el block que dibuja xterm. El glow lo posicionamos
    // nosotros, así que sin esto quedaba el halo cyan flotando sin bloque adentro.
    // Trackeamos la visibilidad por CSI (private mode 25) y escondemos el glow junto
    // con el block. Devolvemos false: xterm igual procesa el hide/show real del cursor.
    try {
      const setCursorHidden = (hidden) => { tab.cursorHidden = hidden; positionGlow(); };
      term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
        if (params.includes(25)) setCursorHidden(false);
        return false;
      });
      term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
        if (params.includes(25)) setCursorHidden(true);
        return false;
      });
    } catch (e) { console.warn('[CONSOLE] CSI ?25 handler no disponible:', e && e.message); }

  // Ctrl+C: copy if selection exists, otherwise send SIGINT (\x03)
  term.attachCustomKeyEventHandler((e) => {
    if (e.ctrlKey && e.code === 'KeyC' && e.type === 'keydown') {
      const sel = term.getSelection();
      if (sel) {
        navigator.clipboard.writeText(sel).catch(() => {});
        term.clearSelection();
        return false; // prevent default (don't send \x03)
      }
      // no selection → let xterm send \x03 (SIGINT) to PTY
      return true;
    }
    // Ctrl+V: dejamos que xterm haga el paste nativo (evento 'paste' del DOM, que
    // respeta bracketed paste mode). NO pegamos a mano: el navegador dispara el
    // evento 'paste' igual, así que hacerlo acá lo duplicaba. Solo interceptamos el
    // keydown y devolvemos false para que xterm no mande ADEMÁS el control code
    // \x16 (Ctrl+V = "quoted insert").
    if (e.ctrlKey && e.code === 'KeyV' && e.type === 'keydown') {
      return false;
    }
    return true;
  });
  } catch (err) {
    console.error('[CONSOLE] Terminal creation FAILED:', err);
    termEl.innerHTML = `<pre style="color:#ff0044;padding:20px;font-family:monospace">[CONSOLE] Terminal init failed: ${err.message}</pre>`;
    return;
  }

  tab.term = term;
  tab.fitAddon = fitAddon;

  // OSC 7: el shell reporta su cwd en cada prompt (file:///path). Actualizamos
  // tab.cwd para reflejar el directorio real del usuario en la status bar.
  try {
    term.parser.registerOscHandler(7, (uri) => {
      const cwd = parseOsc7Cwd(uri);
      if (cwd) tab.cwd = cwd;
      return true; // consumido: xterm no debe imprimir la secuencia
    });
  } catch (e) { console.warn('[CONSOLE] OSC7 handler no disponible:', e && e.message); }

  // Terminal input → PTY. OJO: acá NO se loguea `data` — es cada tecla que tipea el
  // usuario, contraseñas incluidas, y los logs del renderer se reenvían al stdout del main.
  term.onData(data => {
    if (tab.ptyId) {
      umbrovexAPI.pty.write(tab.ptyId, data);
    } else {
      console.warn('[CONSOLE] term.onData but tab.ptyId is null! PTY not ready yet');
    }
    trackCommand(data, tab);
  });

  // Resize. Se registra ANTES de crear el PTY a propósito: el re-measure de la fuente
  // puede cambiar cols/rows mientras el create (IPC async) todavía está en vuelo, y esos
  // resizes tempranos se perdían silenciosamente porque el handler salía por tab.ptyId
  // null. Como la ventana no es redimensionable, nada volvía a dispararlos nunca: el PTY
  // se quedaba con un ancho distinto al de la grilla para toda la vida del tab. Un TUI
  // que lee el ancho del PTY (Claude Code, vim, less, fzf) dibujaba entonces contra una
  // grilla que no era la real y se veía roto.
  term.onResize(({ cols, rows }) => {
    if (tab.ptyId) umbrovexAPI.pty.resize(tab.ptyId, cols, rows);
  });

  // Create PTY
  const createdWith = { cols: term.cols, rows: term.rows };
  umbrovexAPI.pty.create({
    cols: createdWith.cols,
    rows: createdWith.rows,
    cwd: tab.cwd,
  }).then(ptyId => {
    tab.ptyId = ptyId;
    console.log('[CONSOLE] PTY created, ptyId=', ptyId);
    // Conciliación: si la grilla cambió mientras el create iba y venía, el PTY nació con
    // el tamaño viejo y hay que corregirlo ahora (el onResize de ese rato no tenía a
    // quién avisarle).
    if (term.cols !== createdWith.cols || term.rows !== createdWith.rows) {
      umbrovexAPI.pty.resize(ptyId, term.cols, term.rows);
    }
    // No enfocamos acá: el foco y el cursor block se revelan con el prompt (positionGlow).
  }).catch(err => {
    console.error('[CONSOLE] PTY creation FAILED:', err);
    term.write(`\r\n\x1b[38;2;255;0;68m[PTY ERROR: ${err.message || err}]\x1b[0m\r\n`);
  });

  // Focus on click — ensure terminal grabs keyboard focus when clicked
  termEl.addEventListener('mousedown', (e) => {
    if (tab.term) tab.term.focus();
  });
}

/* ========== STATUS BAR ========== */
function updateStatusExit(code) {
  const el = document.getElementById('status-exit');
  if (code === 0) {
    el.innerHTML = `<span style="color:var(--text-faint)">exit </span><span style="color:var(--green)">0</span>`;
  } else {
    el.innerHTML = `<span style="color:var(--text-faint)">exit </span><span class="err">${code}</span>`;
  }
}

function updateClock() {
  const el = document.getElementById('status-time');
  if (!el) return;
  const now = new Date();
  el.textContent = now.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/* ========== AUTO-UPDATE TOAST ========== */
/* Refleja el flujo del updater del main: checking → available → downloading (barra) →
   downloaded → install. Un solo nodo que muta de estado con transiciones; durante la
   descarga sólo movemos el ancho de la barra (sin reconstruir) para que la animación
   de width sea continua. Los checks automáticos (manual=false) que no traen novedad se
   silencian; los manuales (comando de la paleta) siempre dan feedback. */
const UT_SVG = {
  rocket: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
  down: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
  check: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
  alert: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
  spin: '<svg class="ut-spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.22-8.56"/></svg>',
  restart: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  x: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
};

const updateToast = {
  _node: null,
  _hideTimer: 0,
  get node() { return this._node || (this._node = document.getElementById('update-toast')); },
  _endMorph: null,
  render(inner, variant) {
    const n = this.node; if (!n) return;
    clearTimeout(this._hideTimer);

    // ¿Es una entrada (toast oculto/vacío) o una mutación de un toast ya visible?
    const visible = n.classList.contains('show') && n.innerHTML !== '';
    const fromH = visible ? n.getBoundingClientRect().height : 0;
    this._stopMorph();

    n.classList.remove('ready', 'error');
    if (variant) n.classList.add(variant);
    n.innerHTML = inner;

    if (!visible) {
      // Entrada: forzamos un reflow para que el estado "oculto" (opacity 0 + translateX)
      // quede comprometido ANTES de agregar .show; si no, el navegador coalesce ambos
      // frames y la caja aparece de golpe en vez de deslizarse.
      void n.offsetWidth;
      n.classList.add('show');
      return;
    }

    // Mutación: el contenido nuevo ya define el alto final; interpolamos desde el viejo.
    const toH = n.getBoundingClientRect().height;
    if (Math.round(fromH) === Math.round(toH)) return; // mismo alto: nada que animar
    n.style.height = fromH + 'px';
    n.classList.add('morphing');
    void n.offsetHeight; // comprometer el alto viejo con la transición ya activa
    n.style.height = toH + 'px';
    this._endMorph = (e) => {
      if (e && e.propertyName !== 'height') return;
      this._stopMorph();
    };
    n.addEventListener('transitionend', this._endMorph);
  },
  // Vuelve a height:auto. Idempotente: lo llama el transitionend, el próximo render y dismiss().
  _stopMorph() {
    const n = this.node; if (!n) return;
    if (this._endMorph) { n.removeEventListener('transitionend', this._endMorph); this._endMorph = null; }
    n.classList.remove('morphing');
    n.style.height = '';
  },
  autoDismiss(ms) {
    clearTimeout(this._hideTimer);
    this._hideTimer = setTimeout(() => this.dismiss(), ms);
  },
  dismiss() {
    const n = this.node; if (!n) return;
    clearTimeout(this._hideTimer);
    this._stopMorph(); // que un morph a medio camino no deje el alto fijado en px
    n.classList.remove('show');
    // Limpiamos el contenido recién cuando terminó la transición de salida.
    this._hideTimer = setTimeout(() => {
      if (!n.classList.contains('show')) { n.innerHTML = ''; updateToastPhase = null; }
    }, 340);
  },
};
let updateToastPhase = null;

function utRow(icon, label, title, sub, closable) {
  return (
    `<div class="ut-row">` +
      `<span class="ut-icon">${icon}</span>` +
      `<div class="ut-content">` +
        `<div class="ut-label">${label}</div>` +
        `<div class="ut-title">${title}</div>` +
        (sub ? `<div class="ut-sub">${sub}</div>` : '') +
      `</div>` +
      (closable ? `<button class="ut-close" data-ut="later" data-tip="Dismiss">${UT_SVG.x}</button>` : '') +
    `</div>`
  );
}

function renderUpdate(status) {
  const phase = status.phase;
  const version = status.version ? escapeHtml(String(status.version)) : '';
  const manual = !!status.manual;

  // Descarga en curso: sólo actualizamos la barra (transición de width continua).
  if (phase === 'downloading' && updateToastPhase === 'downloading') {
    const pct = Math.max(0, Math.min(100, Math.round(status.percent || 0)));
    const bar = updateToast.node?.querySelector('.ut-progress-bar');
    const num = updateToast.node?.querySelector('.ut-pct');
    if (bar) bar.style.width = pct + '%';
    if (num) num.textContent = pct + '%';
    return;
  }
  updateToastPhase = phase;

  switch (phase) {
    case 'checking':
      if (!manual) return; // auto-check: en silencio hasta que haya novedad
      updateToast.render(utRow(UT_SVG.spin, 'Checking', 'Checking for updates…', '', false));
      break;
    case 'available':
      updateToast.render(
        utRow(UT_SVG.rocket, 'Update', `Console <b>v${version}</b> is available`, 'A new version is ready to download.', true) +
        `<div class="ut-actions">` +
          `<button class="ut-btn primary" data-ut="download">Download</button>` +
          `<button class="ut-btn ghost" data-ut="later">Later</button>` +
        `</div>`
      );
      break;
    case 'downloading': {
      const pct = Math.max(0, Math.min(100, Math.round(status.percent || 0)));
      updateToast.render(
        utRow(UT_SVG.down, 'Downloading', `Downloading update… <span class="ut-pct">${pct}%</span>`, '', false) +
        `<div class="ut-progress"><div class="ut-progress-bar" style="width:${pct}%"></div></div>`
      );
      break;
    }
    case 'downloaded':
      updateToast.render(
        utRow(UT_SVG.check, 'Ready', `Console <b>v${version}</b> downloaded`, 'Restart to finish installing.', true) +
        `<div class="ut-actions">` +
          `<button class="ut-btn primary" data-ut="install">Restart & install</button>` +
          `<button class="ut-btn ghost" data-ut="later">Later</button>` +
        `</div>`,
        'ready'
      );
      break;
    case 'none':
      if (!manual) { updateToast.dismiss(); return; }
      updateToast.render(utRow(UT_SVG.check, 'Up to date', 'Already on the latest version.', '', true), 'ready');
      updateToast.autoDismiss(2800);
      break;
    case 'error':
      if (!manual) { updateToast.dismiss(); return; }
      updateToast.render(utRow(UT_SVG.alert, 'Update failed', escapeHtml(status.error || 'Couldn\'t check for updates.'), '', true), 'error');
      updateToast.autoDismiss(4200);
      break;
    case 'sim-install':
      updateToast.render(utRow(UT_SVG.restart, 'Installing', 'Restarting to install… (simulated in dev)', '', false), 'ready');
      updateToast.autoDismiss(2800);
      break;
  }
}

umbrovexAPI.update.onStatus(renderUpdate);

// Delegación de clicks del toast: descargar / instalar / descartar.
updateToast.node?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-ut]');
  if (!btn) return;
  const act = btn.dataset.ut;
  if (act === 'download') {
    umbrovexAPI.update.download();
    renderUpdate({ phase: 'downloading', percent: 0 }); // feedback inmediato al click
  } else if (act === 'install') {
    umbrovexAPI.update.install();
  } else {
    updateToast.dismiss();
  }
});

/* ========== SVG ICONS (from Penumbra) ========== */
const SVG_ICONS = {
  plus: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  x: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>',
  rotate: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>',
  code: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  clock: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  play: '<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="6 4 20 12 6 20 6 4"/></svg>',
  trash: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/></svg>',
  download: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
};

/* ========== COMMAND PALETTE ========== */
const PALETTE_COMMANDS = [
  { id: 'new-tab', label: 'New tab', shortcut: 'Ctrl+Shift+T', icon: SVG_ICONS.plus, action: () => createTab() },
  { id: 'close-tab', label: 'Close active tab', shortcut: 'Ctrl+Shift+W', icon: SVG_ICONS.x, action: () => closeTab(state.activeTabId) },
  { id: 'clear', label: 'Clear terminal', shortcut: 'Ctrl+L', icon: SVG_ICONS.rotate, action: () => clearTerminal() },
  { id: 'snippets', label: 'View snippets', shortcut: '', icon: SVG_ICONS.code, action: () => switchView('snippets') },
  { id: 'history', label: 'View history', shortcut: '', icon: SVG_ICONS.clock, action: () => switchView('history') },
  { id: 'check-updates', label: 'Check for updates', shortcut: '', icon: SVG_ICONS.download, action: () => umbrovexAPI.update.check(true) },
];

function openPalette() {
  state.paletteOpen = true;
  state.paletteSelected = 0;
  const overlay = document.getElementById('palette-overlay');
  const input = document.getElementById('palette-input');
  overlay.classList.remove('hidden');
  input.value = '';
  input.focus();
  renderPalette('');
}

function closePalette() {
  state.paletteOpen = false;
  document.getElementById('palette-overlay').classList.add('hidden');
}

function renderPalette(query) {
  const results = document.getElementById('palette-results');
  const filtered = query
    ? PALETTE_COMMANDS.filter(c => c.label.toLowerCase().includes(query.toLowerCase()))
    : PALETTE_COMMANDS;
  state.paletteItems = filtered;
  state.paletteSelected = 0;
  results.innerHTML = '';
  filtered.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = `palette-item ${i === 0 ? 'selected' : ''}`;
    el.innerHTML = `
      <span class="pi-icon">${item.icon}</span>
      <span class="pi-label">${escapeHtml(item.label)}</span>
      ${item.shortcut ? `<span class="pi-shortcut">${item.shortcut}</span>` : ''}
    `;
    el.addEventListener('click', () => executePaletteItem(i));
    results.appendChild(el);
  });
}

function executePaletteItem(index) {
  const item = state.paletteItems[index];
  if (!item) return;
  closePalette();
  item.action();
}

function movePaletteSelection(dir) {
  if (!state.paletteItems.length) return; // filtro sin matches: nada que seleccionar (evita el % 0 → NaN)
  state.paletteSelected = (state.paletteSelected + dir + state.paletteItems.length) % state.paletteItems.length;
  document.querySelectorAll('.palette-item').forEach((el, i) => {
    el.classList.toggle('selected', i === state.paletteSelected);
  });
  const sel = document.querySelector('.palette-item.selected');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

/* ========== UTILS ========== */
function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function clearTerminal() {
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (tab?.term) tab.term.clear();
}

/* ========== VIEW SWITCHING ========== */
function switchView(view) {
  state.currentView = view;
  const termContainer = document.getElementById('terminal-container');
  const snippetsPanel = document.getElementById('snippets-panel');
  const historyPanel = document.getElementById('history-panel');

  termContainer.style.display = 'none';
  termContainer.classList.remove('view-active');
  snippetsPanel.classList.add('hidden');
  historyPanel.classList.add('hidden');

  if (view === 'sessions') {
    termContainer.style.display = '';
    termContainer.classList.add('view-active');
    const tab = state.tabs.find(t => t.id === state.activeTabId);
    if (tab?.fitAddon) tab.fitAddon.fit();
    if (tab?.term) tab.term.focus();
  } else if (view === 'snippets') {
    snippetsPanel.classList.remove('hidden');
    renderSnippets();
  } else if (view === 'history') {
    historyPanel.classList.remove('hidden');
    renderHistory();
  }

  document.querySelectorAll('.side-icon[data-view]').forEach(el => {
    el.classList.toggle('active', el.dataset.view === view);
  });
}

/* ========== SNIPPETS ========== */
function loadSnippets() {
  try {
    const saved = localStorage.getItem('umbrovex-snippets');
    if (saved) {
      state.snippets = JSON.parse(saved);
      state.snippetIdCounter = state.snippets.reduce((max, s) => Math.max(max, s.id), 0);
    }
  } catch {}
}

function saveSnippets() {
  try { localStorage.setItem('umbrovex-snippets', JSON.stringify(state.snippets)); } catch {}
}

function addSnippet() {
  const nameInput = document.getElementById('snippet-name');
  const cmdInput = document.getElementById('snippet-cmd');
  const name = nameInput.value.trim();
  const cmd = cmdInput.value.trim();
  if (!name || !cmd) return;
  state.snippets.unshift({ id: ++state.snippetIdCounter, name, cmd, created: Date.now() });
  saveSnippets();
  nameInput.value = '';
  cmdInput.value = '';
  renderSnippets();
  // Animar la entrada del nuevo snippet (queda primero por el unshift).
  const nuevo = document.querySelector('#snippet-list .snippet-item');
  if (nuevo) {
    nuevo.classList.add('snippet-entering');
    nuevo.addEventListener('animationend', () => nuevo.classList.remove('snippet-entering'), { once: true });
  }
}

function deleteSnippet(id) {
  // Animar la salida antes de sacarlo del estado y re-renderizar.
  const el = document.querySelector(`#snippet-list .snippet-item[data-id="${id}"]`);
  const doDelete = () => {
    state.snippets = state.snippets.filter(s => s.id !== id);
    saveSnippets();
    renderSnippets();
  };
  if (el) {
    el.classList.add('snippet-leaving');
    setTimeout(doDelete, 180);
  } else {
    doDelete();
  }
}

function runSnippet(id) {
  const snippet = state.snippets.find(s => s.id === id);
  if (!snippet) return;
  const tab = state.tabs.find(t => t.id === state.activeTabId);
  if (tab?.ptyId) umbrovexAPI.pty.write(tab.ptyId, snippet.cmd + '\r');
  switchView('sessions');
}

function renderSnippets() {
  const list = document.getElementById('snippet-list');
  if (!list) return;
  if (state.snippets.length === 0) {
    list.innerHTML = '<div class="panel-empty">No snippets saved.<br>Create one above.</div>';
    return;
  }
  list.innerHTML = '';
  state.snippets.forEach(s => {
    const el = document.createElement('div');
    el.className = 'snippet-item';
    el.dataset.id = s.id;
    el.innerHTML = `
      <div class="snippet-info">
        <div class="snippet-name">${escapeHtml(s.name)}</div>
        <div class="snippet-cmd">${escapeHtml(s.cmd)}</div>
      </div>
      <div class="snippet-actions">
        <button class="snippet-run" data-id="${s.id}" data-tip="Run">${SVG_ICONS.play}</button>
        <button class="snippet-del" data-id="${s.id}" data-tip="Delete">${SVG_ICONS.trash}</button>
      </div>
    `;
    list.appendChild(el);
  });
  list.querySelectorAll('.snippet-run').forEach(btn => {
    btn.addEventListener('click', () => runSnippet(parseInt(btn.dataset.id)));
  });
  list.querySelectorAll('.snippet-del').forEach(btn => {
    btn.addEventListener('click', () => deleteSnippet(parseInt(btn.dataset.id)));
  });
}

/* ========== HISTORY ========== */
function addHistoryEntry(cmd, tabName) {
  if (!cmd.trim()) return;
  state.history.unshift({ cmd, tab: tabName, time: Date.now() });
  if (state.history.length > 500) state.history.pop();
  if (state.currentView === 'history') renderHistory();
}

function renderHistory() {
  const list = document.getElementById('history-list');
  if (!list) return;
  if (state.history.length === 0) {
    list.innerHTML = '<div class="panel-empty">History is empty.<br>Run commands in the terminal to see them here.</div>';
    return;
  }
  list.innerHTML = '';
  state.history.forEach(h => {
    const el = document.createElement('div');
    el.className = 'history-item';
    const timeStr = new Date(h.time).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    el.innerHTML = `
      <div class="history-time">${timeStr}</div>
      <div class="history-cmd">${escapeHtml(h.cmd)}</div>
      <div class="history-tab">${escapeHtml(h.tab)}</div>
    `;
    el.addEventListener('click', () => {
      const tab = state.tabs.find(t => t.id === state.activeTabId);
      if (tab?.ptyId) umbrovexAPI.pty.write(tab.ptyId, h.cmd + '\r');
      switchView('sessions');
    });
    list.appendChild(el);
  });
}

function clearHistory() {
  state.history = [];
  renderHistory();
}

function trackCommand(data, tab) {
  // Strip ANSI escape sequences (CSI, OSC, SS3, etc.) before processing
  const clean = data.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '').replace(/\x1b./g, '');
  for (const ch of clean) {
    const code = ch.charCodeAt(0);
    if (ch === '\r' || ch === '\n') {
      if (tab.cmdBuffer.trim()) addHistoryEntry(tab.cmdBuffer.trim(), tab.name);
      tab.cmdBuffer = '';
    } else if (code === 127 || code === 8) {
      tab.cmdBuffer = tab.cmdBuffer.slice(0, -1);
    } else if (code === 3) {
      tab.cmdBuffer = '';
    } else if (code >= 32 && code < 127) {
      tab.cmdBuffer += ch;
    }
  }
}

/* ========== EVENT LISTENERS ========== */
function setupEvents() {
  // PTY → terminal: UN solo par de listeners IPC para toda la app, ruteando por ptyId.
  // Registrar un par por tab (como era antes) filtrando adentro dejaba listeners
  // huérfanos al cerrar tabs — y como closeTab dispone la terminal ANTES de que llegue
  // el pty:exit del kill, el listener viejo escribía sobre una terminal disposed.
  // Con el ruteo por state.tabs, un tab cerrado ya no está en la lista y el evento
  // simplemente se ignora.
  umbrovexAPI.pty.onData((id, data) => {
    const tab = state.tabs.find(t => t.ptyId === id);
    if (!tab || !tab.term) return;
    tab.shellStarted = true; // primer output: abre el gate del glow (y del reveal del cursor)
    tab.term.write(data);
  });
  umbrovexAPI.pty.onExit((id, exitCode) => {
    const tab = state.tabs.find(t => t.ptyId === id);
    if (!tab || !tab.term) return;
    tab.term.write(`\r\n\x1b[38;2;136;136;170m[process exited with code ${exitCode}]\x1b[0m\r\n`);
    // La status bar refleja el tab que estás MIRANDO: un proceso que muere en un
    // tab de fondo no pisa el exit code del activo.
    if (tab.id === state.activeTabId) updateStatusExit(exitCode);
  });

  // Window controls
  document.getElementById('win-min').addEventListener('click', () => umbrovexAPI.minimize());
  document.getElementById('win-close').addEventListener('click', () => umbrovexAPI.close());

  // New tab button
  document.getElementById('new-tab').addEventListener('click', () => createTab());

  // Sidebar
  document.getElementById('open-palette').addEventListener('click', openPalette);
  document.querySelectorAll('.side-icon[data-view]').forEach(el => {
    el.addEventListener('click', () => switchView(el.dataset.view));
  });
  document.querySelectorAll('.panel-close').forEach(btn => {
    btn.addEventListener('click', () => switchView('sessions'));
  });

  // Snippets
  document.getElementById('snippet-save').addEventListener('click', addSnippet);
  document.getElementById('snippet-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('snippet-cmd').focus(); }
  });
  document.getElementById('snippet-cmd').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); addSnippet(); }
  });

  // History
  document.getElementById('history-clear').addEventListener('click', clearHistory);

  // Command palette
  document.getElementById('palette-input').addEventListener('input', (e) => renderPalette(e.target.value));
  document.getElementById('palette-input').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePalette();
    else if (e.key === 'ArrowDown') { e.preventDefault(); movePaletteSelection(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); movePaletteSelection(-1); }
    else if (e.key === 'Enter') { e.preventDefault(); executePaletteItem(state.paletteSelected); }
  });
  document.getElementById('palette-overlay').addEventListener('click', (e) => {
    if (e.target.id === 'palette-overlay') closePalette();
  });

  // Global keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+P → Command palette
    if (e.ctrlKey && e.shiftKey && e.key === 'P') {
      e.preventDefault();
      if (state.paletteOpen) closePalette();
      else openPalette();
      return;
    }
    // Ctrl+Shift+T → New tab. Antes era Ctrl+T, pero ese combo lo consume/escribe el
    // shell en la terminal (y lo teníamos con preventDefault, robándoselo). Con Shift
    // queda reservado sólo para tabs y Ctrl+T pasa limpio al shell.
    if (e.ctrlKey && e.shiftKey && (e.key === 'T' || e.key === 't')) {
      e.preventDefault();
      createTab();
      return;
    }
    // Ctrl+Shift+W → Close tab. Igual que new tab: Ctrl+W en el shell borra la palabra
    // anterior, así que lo reservamos con Shift y Ctrl+W pasa limpio a la terminal.
    if (e.ctrlKey && e.shiftKey && (e.key === 'W' || e.key === 'w')) {
      e.preventDefault();
      closeTab(state.activeTabId);
      return;
    }
    // Ctrl+L → Clear
    if (e.ctrlKey && !e.shiftKey && e.key === 'l') {
      e.preventDefault();
      clearTerminal();
      return;
    }
    // Escape → close palette
    if (e.key === 'Escape' && state.paletteOpen) {
      closePalette();
      return;
    }
  });

  // Focus terminal when window gains focus (clicking taskbar, alt-tab, hotkey, etc.).
  // Dos disparadores: el evento DOM del window y —más confiable en Windows para
  // captar TODOS los alt-tab— el aviso del main via BrowserWindow.on('focus').
  window.addEventListener('focus', focusActiveTerminal);
  if (umbrovexAPI?.onFocus) umbrovexAPI.onFocus(focusActiveTerminal);

  // Resize handler
  window.addEventListener('resize', () => {
    state.tabs.forEach(tab => {
      if (tab.fitAddon) tab.fitAddon.fit();
    });
  });
}

/* ========== DISABLE NATIVE TOOLTIPS ========== */
/* Los tooltips nativos salen del atributo `title` y no se pueden desactivar por
   CSS. Los sacamos de todo el DOM y observamos por si se agregan dinámicamente
   (tabs, snippets, history, palette, etc.). */
function disableTooltips() {
  const strip = (node) => {
    if (!node || node.nodeType !== 1) return;
    if (node.hasAttribute('title')) node.removeAttribute('title');
    node.querySelectorAll('[title]').forEach(el => el.removeAttribute('title'));
  };
  strip(document.body);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') {
        if (m.target.nodeType === 1 && m.target.hasAttribute('title')) m.target.removeAttribute('title');
      } else {
        m.addedNodes.forEach(strip);
      }
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['title'] });
}

/* ========== TOOLTIPS PROPIOS (data-tip) ========== */
/* Reemplazan al `title` nativo (que disableTooltips() sigue barriendo por si algún
   addon lo mete). Un solo nodo portaleado al body, posicionado bajo el target (o
   encima si no hay lugar), con delegación por mouseover para cubrir también los
   elementos que se crean dinámicamente (tabs, snippets, etc.). */
function initTooltips() {
  const tip = document.createElement('div');
  tip.id = 'tooltip';
  document.body.appendChild(tip);
  let timer = null;
  let current = null;
  const hide = () => {
    clearTimeout(timer);
    timer = null;
    current = null;
    tip.classList.remove('show');
  };
  const show = (target) => {
    const text = target.dataset.tip;
    if (!text || !target.isConnected) return; // el target pudo irse durante el delay
    tip.textContent = text;
    tip.classList.remove('above');
    // Medimos con el texto ya puesto (el nodo tiene layout aunque esté en opacity 0).
    const r = target.getBoundingClientRect();
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = Math.round(r.left + r.width / 2 - tw / 2);
    left = Math.max(6, Math.min(left, window.innerWidth - tw - 6));
    let top = Math.round(r.bottom + 7);
    if (top + th > window.innerHeight - 6) {
      top = Math.round(r.top - th - 7);
      tip.classList.add('above'); // entra deslizando desde el lado correcto
    }
    tip.style.left = left + 'px';
    tip.style.top = top + 'px';
    tip.classList.add('show');
  };
  document.addEventListener('mouseover', (e) => {
    const t = e.target.closest ? e.target.closest('[data-tip]') : null;
    if (t === current) return; // moviéndose dentro del mismo target
    hide();
    if (!t) return;
    current = t;
    timer = setTimeout(() => show(t), 350);
  });
  // Un click sobre el target suele cambiar el estado de la UI: el tooltip ya fue.
  document.addEventListener('mousedown', hide, true);
  document.addEventListener('mouseleave', hide); // el cursor salió de la ventana
  window.addEventListener('blur', hide);
}

/* ========== INIT ========== */
// Garantiza que las caras que renderiza la terminal estén cargadas ANTES del primer
// term.open() (que mide el glyph). Sin esto, la shell 1 se medía con el fallback
// (Cascadia Code) y quedaba con el prompt unos px corrido respecto de las demás.
// Pedimos explícitamente los estilos que xterm puede pintar (normal, bold=700, itálica)
// y esperamos también document.fonts.ready como refuerzo. Con las fuentes bundleadas
// localmente esto resuelve casi instantáneo; el timeout evita colgar el arranque si
// algo raro pasara (fonts.load nunca rechaza, así que el race es sólo por las dudas).
function ensureFontsReady() {
  if (!document.fonts || !document.fonts.load) return Promise.resolve();
  const faces = [
    "14px 'JetBrains Mono'",
    "700 14px 'JetBrains Mono'",
    "italic 14px 'JetBrains Mono'",
  ];
  const loaded = Promise.all(faces.map(f => document.fonts.load(f).catch(() => {})))
    .then(() => (document.fonts.ready || Promise.resolve()).catch(() => {}));
  const guard = new Promise(res => setTimeout(res, 1500)); // no bloquear el arranque > 1.5s
  return Promise.race([loaded, guard]);
}

async function init() {
  console.log('[CONSOLE] init() called');
  disableTooltips();
  initTooltips();
  loadSnippets();
  try {
    setupEvents();
    console.log('[CONSOLE] setupEvents() done');
  } catch (err) {
    console.error('[CONSOLE] setupEvents() FAILED:', err);
  }
  await ensureFontsReady(); // que la shell 1 mida el glyph con JetBrains Mono, no el fallback
  try {
    createTab('shell 1');
    console.log('[CONSOLE] createTab() done');
  } catch (err) {
    console.error('[CONSOLE] createTab() FAILED:', err);
  }
  updateClock();
  setInterval(updateClock, 1000);
}

// DOM is already parsed (script is at end of body), just init
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}