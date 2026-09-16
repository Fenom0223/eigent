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

El Brain ya es FastAPI (puerto **5001**, `EIGENT_BRAIN_PORT`). Agregar una ruta:

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

### Docker

```yaml
  eigent-brain:
    # ...igual que hoy...
    env_file: ./docker.env

  np_office_listener:
    image: <misma imagen de eigent>
    command: ["python", "np_office/np_office_listener.py"]
    env_file: ./docker.env
    volumes:
      - ./data:/app/data
    depends_on: [eigent-brain]
    restart: always
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
- **E2EE**: la sala se crea hoy sin cifrado (invite-only en el Synapse propio).
  Para activarlo: crear la sala con `m.room.encryption` + `matrix-nio[e2e]` con
  `store_path` persistente (`NP_OFFICE_STATE_DIR` ya reservado).
- **Idempotencia**: eventos ya procesados descartados (últimos 500); se rechaza
  cualquier remitente distinto de `NP_MX_BOT_MXID`.
