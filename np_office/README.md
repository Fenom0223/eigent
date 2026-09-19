# Pocket-to-Office — Listener Matrix para Eigent

Esta carpeta agrega a **Eigent** (Electron + Brain Python) la capacidad de recibir
tareas delegadas desde una nota de voz enviada en **Element X** y devolver el
resultado (texto + archivos) a la sala. El usuario lo ve en el móvil.

```
Element X (voz) → np-bot (STT + LLM) → NP_TASK:{...} → @desktop-<user>
                                                              │
                              Eigent ejecuta el workflow DOE ─┘
                                                              │
Element X (móvil) ← resultado + m.file (informe PDF/CSV) ←────┘
```

## 1. Archivos

| Archivo | Rol |
|---|---|
| `np_office_listener.py` | Listener Matrix (matrix-nio), autocontenido (~230 líneas) |

## 2. Credenciales

Las genera `onboard.sh` (repo `np-sovereign-core`) en el `docker.env` del usuario:

```ini
NP_MX_HOMESERVER=https://np-cpu-<cliente>.<dominio>
NP_MX_DESKTOP_MXID=@desktop-<usuario>:<dominio>
NP_MX_DESKTOP_TOKEN=<token>
NP_MX_OFFICE_ROOM_ID=!abc123:<dominio>
NP_MX_OFFICE_ALIAS="#mi-oficina-<usuario>:<dominio>"
NP_MX_BOT_MXID=@np-bot:<dominio>
```

En Eigent (Electron), el `docker.env` se inyecta como variables de entorno al
proceso principal y al Brain: `docker run --env-file docker.env` o `env_file:`
en el compose. El listener las lee del entorno, igual que el backend.

## 3. Wiring — elegir UN camino

### Camino A — HTTP contra el Brain (recomendado: cero acople)

> **Implementado (con límite de arquitectura):** `server/main.py` expone
> `POST /office/task` (raíz, sin `/v1`) en el contenedor `api` (puerto 5678), que
> es el que el sidecar llama. El executor es **configurable**:
> `NP_OFFICE_EIGENT_EXECUTOR_URL` (reenvía al Brain/worker externo) o
> `NP_OFFICE_LLM_MODEL` (+ `litellm_url`/`NP_OFFICE_LLM_KEY`, responde vía la
> pasarela LiteLLM). **Límite:** el contenedor `server` es el API de gestión
> (historial/espacios/modelos) y NO ejecuta agentes; el runtime multi-agente real
> (DOE) vive en el Brain de escritorio (`backend/`, `EIGENT_BRAIN_PORT=5001`),
> acoplado a Electron (task_lock/workspace/SSE). Para ejecución DOE completa, el
> listener debe correr junto al Brain y apuntar `NP_OFFICE_TASK_URL` ahí.

El Brain es FastAPI (puerto **5001**, `EIGENT_BRAIN_PORT`). Agregar una ruta:

```python
# backend/app/office.py
from fastapi import APIRouter
from pydantic import BaseModel

router = APIRouter(prefix="/office", tags=["office"])

class OfficeTask(BaseModel):
    task_id: str
    text: str
    locale: str = "es"
    from_: str = ""

@router.post("/task")
async def office_task(task: OfficeTask):
    # Disparar el workflow existente de Eigent (agentes CAMEL / directiva DOE)
    answer = await run_eigent_task(task.text)     # <- adaptar al entrypoint real
    files  = []                                    # ej: ["/app/data/informe.pdf"]
    return {"answer": answer, "files": files}
```

Registrar el router en `backend/main.py` (sobre `api`) y exportar:

```ini
NP_OFFICE_TASK_URL=http://127.0.0.1:5001/office/task
```

### Camino B — Python in-process

Un servicio del Brain que instancie el listener con un handler que invoque la
sociedad de agentes:

```python
from np_office.np_office_listener import OfficeListener, Task, TaskResult

async def handler(task: Task) -> TaskResult:
    answer = await run_eigent_task(task.text)
    return TaskResult(text=answer, files=[...])

OfficeListener(handler=handler).run_forever()
```

## 4. Ejecución

### Docker (sidecar)

Ya está aplicado en `server/docker-compose.yml` (servicio `np_office_listener`),
que reusa la imagen de `server/Dockerfile` — esa imagen ya trae `np_office/`
copiado a `/app/np_office` y `matrix-nio[e2e]` (con `libolm-dev` en la base):

```yaml
  np_office_listener:
    build:
      context: ..
      dockerfile: server/Dockerfile      # ya incluye np_office/ + matrix-nio[e2e]
    command: ["python", "np_office/np_office_listener.py"]
    env_file: ./docker.env
    environment:
      - NP_OFFICE_TASK_URL=http://api:5678/office/task   # wiring pendiente (Camino A)
    volumes:
      - ./np_office_state:/app/.np_office   # store Olm persistente (device_id fijo)
    depends_on: [api]
    restart: unless-stopped
```

### Local (dev)

```powershell
python -m venv .venv-office
.\.venv-office\Scripts\pip install "matrix-nio[e2e]"
# cargar docker.env en el entorno y correr:
python np_office\np_office_listener.py --selfcheck
python np_office\np_office_listener.py
```

### Validación

```bash
python -m py_compile np_office/np_office_listener.py
python np_office/np_office_listener.py --selfcheck
```

Log esperado:

```
[OFFICE] BOOT mxid=@desktop-juan:dominio homeserver=https://np-cpu-... room=!abc:dominio executor=http trusted=@np-bot:dominio
[OFFICE] TASK_RECEIVED task_id=t-001 chars=86
[OFFICE] TASK_DONE task_id=t-001 seconds=12.8 files=1
[OFFICE] FILE_SENT name=informe.pdf bytes=48213
```

## 5. Notas

- **Aislamiento**: `@desktop-<usuario>` solo es miembro de su propia sala; el
  ruteo lo garantiza Synapse.
- **DOE es estándar**: las directivas `.md` (GEMINI.md) y Playwright como MCP van
  en la **imagen base** (son código compartido), no en el `docker.env`.
- **E2EE (por defecto ON)**: `onboard.sh` crea la sala con `m.room.encryption`
  (megolm) y el listener exige E2EE (`NP_OFFICE_ENCRYPTED=1`). Requiere
  `matrix-nio[e2e]` (libolm) y el **device_id FIJO** de
  `NP_MX_DESKTOP_DEVICE_ID`: la cuenta Olm vive en `NP_OFFICE_STATE_DIR`, así que
  si el device_id cambia entre arranques el listener no descifra. Los archivos
  se suben cifrados (`upload(..., encrypt=True)`). Para sala en claro (debug):
  `NP_OFFICE_E2EE=0 ./onboard.sh <cliente>.env <usuarios>.csv`
- **Idempotencia**: eventos ya procesados descartados (últimos 500); se rechaza
  cualquier remitente distinto de `NP_MX_BOT_MXID`.
