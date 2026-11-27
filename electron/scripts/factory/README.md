# Entorno de desarrollo aislado (AI Content Factory)

Ejecuta nuestra versión de NodeTool en modo desarrollo junto a la aplicación
NodeTool instalada en macOS, sin compartir puerto, datos, configuración,
perfil de Electron ni credenciales.

## Requisitos

- macOS en Apple Silicon (arm64). Todo se ejecuta de forma nativa, sin Rosetta.
- Xcode o Command Line Tools, para compilar `better-sqlite3`.
- Google Chrome, para el navegador que usan los agentes y el nodo
  `lib.browser.Screenshot`.

## Qué queda aislado

Todo el estado vive en `AI Content Factory/nodetool-dev-env/`, fuera del
repositorio.

| Recurso | App instalada | Entorno de desarrollo |
|---|---|---|
| Puerto del backend | 7777 | 7778 (`FACTORY_API_PORT`) |
| Vite | no aplica | 3000 (fijado en `web/package.json`) |
| Base de datos SQLite, assets, workspaces, logs | `~/.local/share/nodetool` | `nodetool-dev-env/home/.local/share/nodetool` |
| Configuración (`settings.yaml`, `packs.json`) | `~/.config/nodetool` | `nodetool-dev-env/home/.config/nodetool` |
| Datos de Electron | `~/Library/Application Support/nodetool-electron` | `nodetool-dev-env/electron-user-data` |
| Clave maestra de secretos | Llavero de macOS (`nodetool`) | `nodetool-dev-env/secrets/master.key` (generada, 0600) |
| Node.js | integrado en la app | `nodetool-dev-env/toolchain` (versión de `.nvmrc`) |
| Caché de npm | no aplica | `nodetool-dev-env/npm-cache` |

Más detalles:

- `HOME` apunta a `nodetool-dev-env/home` solo en los procesos del entorno.
  Las CLI de agentes que el backend detecta (Claude, Codex, Gemini) ven, por
  tanto, un HOME vacío y no heredan tus sesiones.
- Las actualizaciones automáticas no se ejecutan: Electron las omite cuando la
  app no está empaquetada.
- El navegador de agentes usa CDP con un perfil temporal de Chrome
  (`NODETOOL_BROWSER_TRANSPORT=cdp`), nunca tu Chrome con sesión iniciada.
- No se copia ninguna credencial de la app instalada. Las claves de proveedores
  se añaden desde Ajustes de la versión de desarrollo.

## Primera instalación

```bash
cd "AI Content Factory/nodetool"
electron/scripts/factory/install-node.sh            # Node de .nvmrc, darwin-arm64, con checksum
source electron/scripts/factory/dev-env.sh
npm ci --no-audit --no-fund                          # dependencias de la raíz; mobile/ no se instala
node electron/node_modules/electron/install.js       # solo si falta el binario de Electron
npm run build:packages
```

## Uso diario

```bash
electron/scripts/factory/dev-desktop.sh start    # Vite + Electron; Electron arranca el backend en 7778
electron/scripts/factory/dev-desktop.sh status
electron/scripts/factory/dev-desktop.sh stop
electron/scripts/factory/dev-desktop.sh server   # solo backend en 7778, sin ventana
```

`start` se niega a arrancar si el puerto 7778 o el 3000 están ocupados, y
`stop` detiene únicamente los procesos que arrancó, según sus PID en
`nodetool-dev-env/run/`. Ninguno de los dos actúa sobre la app instalada.

Para ejecutar otros comandos del repositorio (pruebas, CLI) con el mismo
aislamiento:

```bash
source electron/scripts/factory/dev-env.sh
factory_runtime_env
npm run nodetool -- node run lib.browser.Screenshot --props '{"url":"https://example.com"}' --no-secrets
```

## Logs

| Archivo | Contenido |
|---|---|
| `nodetool-dev-env/logs/electron.log` | Proceso principal de Electron, backend y consola del renderer |
| `nodetool-dev-env/logs/web.log` | Vite |
| `nodetool-dev-env/home/.local/share/nodetool/logs/nodetool.log` | Log de NodeTool |

## Cambios respecto al código oficial

- `electron/src/desktopPort.ts` (nuevo): lee `NODETOOL_DESKTOP_PORT`, con 7777
  por defecto.
- `electron/src/server.ts` y `electron/src/state.ts`: usan ese puerto en lugar
  de 7777 fijo. Sin este cambio, la build de desarrollo detectaba el servidor
  de la app instalada en 7777 y ofrecía detenerlo o reutilizarlo.
- `electron/src/__tests__/desktopPort.test.ts`: pruebas del puerto
  configurable.

Si la variable no está definida, el comportamiento es idéntico al oficial.
