# Console

Terminal con estética cyberpunk. Electron + xterm.js + node-pty.

La terminal de **Umbrovex Systems**: real, rápida y con onda neón, sin nada de más.

## Setup

```bash
cd C:\tools\console
npm install
npm start
```

> `node_modules` viene con `node-pty` ya compilado para Electron 40. Si clonás en
> limpio y `npm install` recompila, necesitás las build tools de Windows.

## Estructura

```
console/
├── package.json
├── src/
│   ├── main.js          # Proceso principal (Electron + PTY + auto-update + tray)
│   ├── preload.js       # Bridge seguro contextIsolation (window.umbrovex)
│   ├── shell/           # Init de shell (OSC 7 para reportar la cwd)
│   └── renderer/
│       ├── index.html   # UI
│       ├── styles.css   # Estética cyberpunk neon
│       └── renderer.js  # Lógica del renderer (tabs, terminal, palette, snippets, history)
└── mockup/              # Diseño original de referencia
```

## Atajos

| Atajo | Acción |
|---|---|
| `Ctrl+Shift+T` | Nueva tab |
| `Ctrl+Shift+W` | Cerrar tab |
| `Ctrl+Shift+P` | Command palette |
| `Ctrl+L` | Limpiar terminal |
| `Ctrl+Alt+C` | Mostrar / ocultar la ventana (global) |

## Features

- Terminal PTY real (node-pty + xterm.js) con renderer WebGL
- Tabs múltiples con crossfade
- Window controls (frameless) + minimizar a tray
- Sidebar: Sessions / Snippets / History / Command palette
- Command palette (`Ctrl+Shift+P`)
- Snippets y History persistentes (localStorage)
- Status bar (cwd + branch + shell + reloj + exit code)
- Auto-update (electron-updater) con toast
- Estética cyberpunk neon: CRT scanlines, cursor glow, scrollbars y selección propias

## Notas

Console es **Razor sin el AI Dock**: mismo terminal y misma estética, pero sin el
agente de IA, sin el panel de Settings (que era solo config de IA) ni la barra de
detección de errores. Es una terminal pura.

El namespace interno del bridge de JS es `window.umbrovex` (por Umbrovex Systems);
no se usa `window.console` porque ya existe en el navegador.
