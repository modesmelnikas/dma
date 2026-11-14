# DMA – Registro de obras y horas

Web app para que los operarios de DMA Estructures i Cobertes S.L. registren sus horas por obra, con panel de administración.
Node/Express + **Monday** como base de datos (tableros *DMA - Obras*, *DMA - Personal*, *DMA - Registros*).

## Variables de entorno (Render → Environment)
| Variable | Valor |
|---|---|
| `MONDAY_API_TOKEN` | Token personal de Monday (Avatar → Developers → My access tokens) |
| `BOARD_OBRAS` | 5107838007 |
| `BOARD_PERSONAL` | 5107838012 |
| `BOARD_REGISTROS` | 5107838013 |
| `SESSION_SECRET` | cadena aleatoria larga |
| `INITIAL_ADMIN_USER` / `INITIAL_ADMIN_PASSWORD` / `INITIAL_ADMIN_NAME` | primer administrador (se crea solo si el tablero Personal está vacío; pide cambiar la contraseña al entrar) |

Render: build `npm install`, start `npm start`, health check `/healthz`.

## Local
`MONDAY_MOCK=1 npm start` (Monday simulado en memoria) · `npm test`.
