# @nodetool-ai/factory-browser-orca

Transporte de navegador de NodeTool para AI Content Factory. Maneja pestañas
del navegador integrado de Orca a través del CLI público `orca`, en el perfil
aislado "AI Content Factory". No usa endpoints privados de Orca, el perfil
`default` ni las cookies del usuario.

## Activación

```bash
source electron/scripts/factory/dev-env.sh
NODETOOL_BROWSER_TRANSPORT=orca electron/scripts/factory/dev-desktop.sh web
```

`dev-env.sh` ya define `NODETOOL_BROWSER_TRANSPORT_MODULES=orca=@nodetool-ai/factory-browser-orca`
y `FACTORY_ORCA_WORKTREE` (por defecto `path:<carpeta raíz>`, la carpeta que contiene `nodetool/`; debe estar registrada en Orca con `orca repo add --path <carpeta raíz> --kind folder`). Sin
`NODETOOL_BROWSER_TRANSPORT=orca`, NodeTool usa el transporte `local`.

Requisitos: Orca abierto y el perfil creado una vez:

```bash
orca tab profile create --label "AI Content Factory"
```

## Iniciar sesión en un proveedor

```bash
npm run login --workspace=packages/factory-browser-orca -- https://proveedor.example/login
```

Abre la página en una pestaña del perfil de la fábrica, delante, para que
inicies sesión a mano. La sesión queda guardada en ese perfil. El transporte
nunca escribe credenciales ni lee cookies. Los passkeys, llaves de seguridad,
captchas y pasos de verificación se dejan siempre al usuario: el transporte se
detiene con `human_action_required`.

## Proveedores multimedia (`openProviderTab`)

Un proveedor de NodeTool que trabaja sobre un sitio con sesión iniciada (por
ejemplo ChatGPT Images) pide su pestaña al transporte configurado a través de
`packages/runtime/src/providers/provider-tab.ts`. Con Orca:

- La pestaña es la que autorizas para ese proveedor en
  `FACTORY_ORCA_PROVIDER_TABS` (`chatgpt=<browserPageId>`), en el perfil y el
  espacio de la fábrica y exactamente en el host del proveedor. Las pestañas
  autorizadas para el navegador del agente no cuentan.
- Los scripts del proveedor van por un canal propio: se comprueba el host
  dentro del propio script y se rechaza cualquier resultado con forma de
  credencial (JWT, `Bearer`, claves `sk-`, campos `accessToken`, `cookie`…).
  Los agentes no llegan a ese canal y `FACTORY_ORCA_ALLOW_PAGE_SCRIPTS` no lo
  abre.
- La navegación queda dentro de `https://<host del proveedor>`.
- En modo asistido (`automated: false`) la pestaña solo se muestra
  (`tab switch --focus`): ningún script se ejecuta y nada se navega.

Con `NODETOOL_BROWSER_PROVIDER_POLICY=terms` (por defecto en `dev-env.sh`), un
proveedor cuyas condiciones prohíben el uso automatizado trabaja en modo
asistido. ChatGPT es uno de ellos (Terms of Use de OpenAI): NodeTool no envía
nada, enfoca tu pestaña de ChatGPT y el plano del storyboard queda en `failed`
con el prompt exacto y los pasos: generar en ChatGPT, descargar y usar "Sube
tu propio fotograma". Para renders automáticos, el proveedor OpenAI por API.

## Arquitectura

| Archivo | Responsabilidad |
|---|---|
| `src/orca-cli.ts` | Única llamada al CLI: `spawn` sin shell, `--json`, plazo y `AbortSignal`, límite de salida, valores secretos por stdin, cola por pestaña, concurrencia global, lecturas idénticas compartidas, reintento solo de lecturas |
| `src/policy.ts` | Lista blanca de comandos, `--page` y `--worktree` obligatorios, solo http(s) y `about:blank`, lista opcional de orígenes, ritmo y presupuesto de navegación por origen |
| `src/tab-scope.ts` | Perfil aislado (nunca `default`), pestañas abiertas por la fábrica o autorizadas, verificación de espacio y perfil antes de usar una pestaña |
| `src/orca-page.ts` | `BrowserPage` sobre una pestaña: evaluación con argumentos como literal JSON y resultado envuelto, efectos de cada acción, consola por sondeo |
| `src/media.ts` | Captura de medios con `fetch` dentro de la página, tamaño máximo, transferencia por trozos, liberación en `finally` |
| `src/config.ts` | Variables `FACTORY_ORCA_*`, límites y directorio de trabajo dentro del entorno aislado |
| `src/transport.ts` | Fábrica `browserTransport` y capacidades declaradas |
| `src/provider-tab.ts` | `openProviderTab`: pestaña autorizada por proveedor, canal de scripts del proveedor, modo asistido |

El núcleo solo aporta la interfaz `BrowserPage` y el registro de transportes
de `@nodetool-ai/browser` (`transport-registry.ts`).

## Capacidades y limitaciones

| Capacidad | Orca |
|---|---|
| CDP directo, eventos `Network`, cuerpos de respuesta | No |
| Consola | Sondeo tras las acciones, no eventos |
| Entrada por coordenadas | Sí (`mouse move/down/up`) |
| Ruta de descarga | No: una descarga de página va a `~/Downloads`; usa `capture_media` |
| Sesiones iniciadas a mano | Sí, en el perfil aislado |
| Tamaño máximo de medios | `FACTORY_ORCA_MAX_MEDIA_BYTES` (64 MB por defecto, techo 256 MB) |

No se pueden capturar URLs de un solo uso, streams MSE ni contenido con DRM.

Ejecución de JavaScript: las funciones fijas de NodeTool (leer la página,
desplazarse, capturar, subir) se ejecutan siempre, con sus argumentos como
datos JSON. El texto de script que escribe un agente (`browser_console_exec`)
se rechaza por defecto, porque la pestaña lleva tu sesión y ese código podría
leer `localStorage` o cookies no `HttpOnly` y enviarlas fuera.

HTTP 429: si una navegación o una captura recibe 429, el transporte se detiene
y bloquea ese origen durante su `Retry-After` (las capturas lo pueden leer) o
`FACTORY_ORCA_RATE_LIMIT_COOLDOWN_MS`. Ningún comando llega a ese origen antes.

Subidas: solo desde `TMPDIR` y el directorio de trabajo del paquete, comparando
rutas reales; la base de datos, los secretos y el HOME aislado quedan fuera.
Cada comando es una llamada al CLI (unos 120 ms una lectura, 300 ms una acción).

## Configuración

| Variable | Por defecto | Uso |
|---|---|---|
| `FACTORY_ORCA_WORKTREE` | `dev-env.sh`: el espacio de `ORCA_WORKTREE_ID` si su carpeta resuelve a la raíz del proyecto; si no, `path:<carpeta raíz>` | Espacio de Orca de la carpeta raíz del proyecto |
| `FACTORY_ORCA_PROFILE_LABEL` / `FACTORY_ORCA_PROFILE_ID` | `AI Content Factory` | Perfil aislado |
| `FACTORY_ORCA_AUTHORIZED_PAGES` | vacío | Pestañas existentes autorizadas (browserPageId, separadas por comas) |
| `FACTORY_ORCA_PAGE_ID` | vacío | Reutilizar una pestaña autorizada en vez de abrir una |
| `FACTORY_ORCA_KEEP_TABS` | `0` | `1` conserva al cerrar las pestañas abiertas por la fábrica |
| `FACTORY_ORCA_ALLOWED_ORIGINS` | vacío | Orígenes permitidos (`https://a.com`, `*.b.com`) |
| `FACTORY_ORCA_MIN_ACTION_INTERVAL_MS` | `250` | Separación mínima entre acciones por origen |
| `FACTORY_ORCA_MAX_NAVIGATIONS_PER_MINUTE` | `30` | Navegaciones por origen y minuto |
| `FACTORY_ORCA_COMMAND_TIMEOUT_MS` / `FACTORY_ORCA_NAVIGATION_TIMEOUT_MS` | `30000` / `60000` | Plazos |
| `FACTORY_ORCA_MAX_MEDIA_BYTES` / `FACTORY_ORCA_MEDIA_CHUNK_BYTES` | 64 MB / 4 MB | Medios |
| `FACTORY_ORCA_CONSOLE_POLL_MS` | `2000` | `0` desactiva el sondeo de consola |
| `FACTORY_ORCA_ALLOW_PAGE_SCRIPTS` | `0` | `1` permite que `browser_console_exec` ejecute texto de script en la pestaña con sesión iniciada |
| `FACTORY_ORCA_RATE_LIMIT_COOLDOWN_MS` | `60000` | Bloqueo de un origen tras HTTP 429 cuando no indica `Retry-After` |
| `FACTORY_ORCA_PROVIDER_TABS` | vacío | Pestaña autorizada por proveedor multimedia (`chatgpt=<browserPageId>`) |
| `FACTORY_ORCA_CLI` | `ORCA_CLI_COMMAND` o `orca` | Ejecutable de Orca |

## Pruebas

```bash
npm run test --workspace=packages/factory-browser-orca           # unitarias, Orca simulado
FACTORY_ORCA_INTEGRATION=1 npm run test:integration --workspace=packages/factory-browser-orca
```

La integración necesita Orca abierto, el perfil creado y el entorno exportado
(`source electron/scripts/factory/dev-env.sh && factory_prepare_dirs && factory_runtime_env`).
Levanta un sitio local en `127.0.0.1`, no consume generaciones y cierra sus
pestañas y su sesión de prueba al terminar.
