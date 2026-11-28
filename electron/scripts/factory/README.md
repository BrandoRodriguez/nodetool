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

Todo el estado vive en `nodetool-dev-env/`, junto a `nodetool/` en la carpeta raíz del proyecto (se detecta a partir de la ubicación de los scripts), fuera del
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
| Temporales y sockets (`TMPDIR`) | temporal del sistema | `nodetool-dev-env/tmp`, mediante el enlace corto `/tmp/nodetool-factory-<uid>` |

Más detalles:

- `HOME` apunta a `nodetool-dev-env/home` solo en los procesos del entorno.
  Las CLI de agentes que el backend detecta (Claude, Codex, Gemini) ven, por
  tanto, un HOME vacío y no heredan tus sesiones.
- Las actualizaciones automáticas no se ejecutan: Electron las omite cuando la
  app no está empaquetada.
- El navegador de agentes usa por defecto el transporte `local`: Chrome
  headless con un perfil temporal, nunca tu Chrome con sesión iniciada. Con
  `NODETOOL_BROWSER_TRANSPORT=orca` usa pestañas de Orca en el perfil aislado
  "AI Content Factory" (ver
  [factory-browser-orca](../../../packages/factory-browser-orca/README.md)).
- `TMPDIR` aislado también separa el puente de la extensión: sus sockets viven
  en `TMPDIR`, así que el backend de desarrollo no encuentra el host nativo
  que arranca la extensión de Chrome de la app instalada. El enlace va por
  `/tmp` porque macOS limita la ruta de un socket unix a 104 bytes;
  `dev-env.sh` comprueba que el enlace es tuyo y apunta al entorno.
- No se copia ninguna credencial de la app instalada. Las claves de proveedores
  se añaden desde Ajustes de la versión de desarrollo.

## Primera instalación

```bash
cd <carpeta raíz>/nodetool
electron/scripts/factory/install-node.sh            # Node de .nvmrc, darwin-arm64, con checksum
source electron/scripts/factory/dev-env.sh
npm ci --no-audit --no-fund                          # dependencias de la raíz; mobile/ no se instala
node electron/node_modules/electron/install.js       # solo si falta el binario de Electron
npm run build:packages
```

## Uso diario

```bash
electron/scripts/factory/dev-desktop.sh web      # backend en 7778 + Vite en 3000, sin Electron
electron/scripts/factory/dev-desktop.sh start    # Vite + Electron; Electron arranca el backend en 7778
electron/scripts/factory/dev-desktop.sh status
electron/scripts/factory/dev-desktop.sh stop
electron/scripts/factory/dev-desktop.sh server   # solo backend en 7778, sin ventana
```

`start` y `web` se niegan a arrancar si el puerto 7778 o el 3000 están
ocupados, y `stop` detiene únicamente los procesos que arrancó, según sus PID
en `nodetool-dev-env/run/`. Ninguno actúa sobre la app instalada.

Vite escucha solo en `127.0.0.1`. El script oficial de `web/package.json` usa
`0.0.0.0`, que expondría la interfaz y su proxy en la red local.

## Modo navegador (`web`)

Abre `http://localhost:3000` en cualquier navegador, por ejemplo el de Orca.
La página usa URLs relativas (`/api`, `/trpc`, `/ws`, `/storage`) y Vite las
reenvía a `PROXY_API_TARGET`, es decir, al backend aislado en 7778. El backend
reconoce `localhost:3000` como cliente local, así que no hace falta iniciar
sesión.

`scripts/dev-server.mjs` arranca el backend con `tsx watch`, que lo reinicia al
cambiar código de `packages/*/src`. Vite recarga en caliente los cambios de
`web/src`.

### Qué funciona en el navegador y qué requiere Electron

| Área | Navegador | Notas |
|---|---|---|
| Editor de workflows, ejecución, chat, agentes, assets, timeline, storyboard, sketch, 3D, mini apps, modelos de proveedores | Sí | Todo va por HTTP, tRPC y WebSocket al backend |
| Navegador de agentes (`lib.browser.Screenshot`, herramientas de navegación) | Sí | Lo ejecuta el backend con Chrome por CDP |
| Portapapeles | Sí, con límites | Usa `navigator.clipboard`. Copiar imágenes y leer HTML dependen de los permisos del navegador |
| Selección de archivos en listas de imagen, audio, vídeo y texto | Sí | Selector del navegador en lugar del diálogo nativo. El archivo se sube al backend |
| Referenciar un archivo local en su ruta original | No | `window.api.files`. En el navegador el archivo se sube como asset |
| Elegir carpeta de proyecto | Sí | Sin diálogo nativo: usa `FileBrowserDialog`, que lista carpetas a través del backend |
| Instalar runtimes (Python/conda, paquetes) y node packs | No | `window.api.packages`. La interfaz muestra un aviso de solo escritorio |
| Vaults (varias bases de datos) | No | `window.api.vaults` |
| Instrumentos VST en el timeline | No | Proceso nativo `vst-host` |
| Cuenta en la nube, publicar y sincronizar | No | `window.api.cloudAccount` y `window.api.cloud` |
| Mostrar en Finder, abrir carpetas de modelos, abrir el log | No | `window.api.shell` y `showItemInFolder` |
| Menú nativo, bandeja, atajos globales, notificaciones del sistema, reinicio del backend | No | Proceso principal de Electron |
| Ajustes de escritorio (canal de actualización, configuración MCP de clientes) | No | `window.api.settings` y `window.api.mcp` |

La vista previa de archivos locales del backend queda limitada al HOME aislado,
que es la raíz por defecto de `NODETOOL_LOCAL_FILE_ROOTS`, así que no expone
tus archivos reales.

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
- `packages/browser/src/browser-page.ts` y `transport-registry.ts` (nuevos):
  interfaz `BrowserPage` y registro de transportes de navegador.
  `actions.ts`, `capture.ts` y `upload.ts` usan `BrowserPage` en vez de
  `CdpPage`, y la salida `transport` de `browser_status`/`browser_restart` es
  un string. Los transportes `local` y `extension` no pasan por el registro.

Sin las variables nuevas, el comportamiento es idéntico al oficial.
