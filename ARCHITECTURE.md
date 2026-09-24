# MotorForge — Arquitectura

Aplicación de escritorio (offline, Windows/macOS/Linux) para diseñar, ensamblar y simular
motores de combustión interna pieza a pieza, hasta reproducir fallos reales de forma explicable.

## Stack

| Capa | Tecnología | Notas |
|---|---|---|
| Shell | Electron + electron-vite | Node real para SQLite, workers y WASM pesado |
| UI | React 19 + TypeScript + Zustand | |
| 3D | Three.js + React Three Fiber | PBR, planos de corte, explosionado, overlays de color (fase 1+) |
| Kernel geométrico | opencascade.js (OCCT/WASM) en worker | Import STEP/IGES, teselado, métricas (fase 2) |
| Simulación | TypeScript puro en `worker_threads` | Paso fijo, determinista. v0 corre síncrona en renderer |
| Persistencia | SQLite (better-sqlite3) + JSON validado con Zod | v0 usa catálogo en TS y ficheros JSON |

## Principios

1. **Fallos explicables**: cada término del modelo físico registra sus dependencias; un evento de
   fallo lleva `causeChain` (p. ej. `boost 2.4 bar → presión pico 190 bar → carga biela 82 kN > pandeo 74 kN`).
2. **Contrato único de límites**: la simulación consume `DerivedLimit[]` sin distinguir si el límite
   viene de catálogo (`catalog`), de fórmulas analíticas sobre geometría importada (`derived-analytic`),
   de FEA vóxel (`derived-fea`) o de edición manual (`manual`).
3. **Determinismo**: mismo ensamblaje + misma config ⇒ mismo resultado, para reproducir fallos.
4. **Física simplificada pero coherente**: 0D monozona (Wiebe), Woschni-lite, Chen-Flynn,
   cargas cuasi-estáticas, Miner para fatiga. Nunca CFD/FEA dinámico.

## Derivación automática de límites (fases 2 y 4)

Al importar un STEP: OCCT mide (volumen, mapa de espesores, secciones mínimas, conductos) →
el usuario clasifica la pieza y elige material de la BD de materiales → una *plantilla de cargas*
por tipo de pieza aporta las condiciones de contorno → se derivan límites:

- **Nivel A (analítico, instantáneo)**: pared delgada/Lamé para conductos, Euler para bielas,
  módulo resistente para flexión, temperatura de servicio del material, Goodman para fatiga.
- **Nivel B (FEA vóxel, bajo demanda, cacheado por caso)**: voxelización por paridad de cruces
  (three-mesh-bvh) → hexaedros trilineales → elasticidad lineal con gradiente conjugado matrix-free
  (Jacobi); von Mises p95 (fuera de las zonas de contorno) por unidad de carga → límite =
  σ admisible / (vm/unidad) / SF. Casos plantilla: biela axial, corona de pistón a presión.
  El pandeo de Euler se mantiene como techo independiente (el FEA lineal no lo ve).

## Fases

1. **MVP — hecha**: catálogo de piezas con límites de fábrica, ensamblador con validación de
   compatibilidad, simulación de ciclo Otto, banco dyno (CV/par vs RPM), fallos por límite duro con causa.
2. **Hecha**: import STEP/IGES/STL (occt-import-js en worker) + BD de materiales + derivación analítica de límites.
3. **Hecha**: mapas ECU (λ/avance por rpm×carga, bilineal), sistema de combustible (bomba + regulador +
   inyectores √ΔP → presión de raíl real), knock por octanaje requerido, transitorios (pull contra
   inercia con lag de turbo e inercia térmica).
4. **Hecha**: banco de resistencia (desgaste acumulado: fatiga Miner de biela/cigüeñal, ringland
   por picado, fluencia térmica, cojinetes, segmentos como fallo progresivo que roba par),
   FEA vóxel (nivel B) para piezas importadas, overlays 3D de utilización térmica/estructural.
5. **Hecha**: proyectos (guardar/abrir `.mforge.json` con diálogo nativo + autosave de sesión en
   userData), desgaste persistente entre tandas y sesiones (motor "usado" hasta reconstruir),
   slot de refrigeración/aceite (baja corona/escape y protege cojinetes), comparador A/B de
   curvas de dyno, histórico de tandas y exportación CSV.
6. **Hecha**: laboratorio físico (pestaña propia, lazy) — tren alternativo como cuerpos rígidos
   de Rapier con juntas de revolución (biela-cigüeñal, biela-pistón) y deslizante estricta
   (pistón-bloque); sockets declarativos generados de la geometría real (`physics/sockets.ts`);
   fatiga/pandeo de Euler/pernos y térmica+gripaje (`physics/engineMath.ts`, testeado); rotura =
   destruir joints + piezas libres rebotando en el cárter en rojo neón; ECU con sensor de PMS
   sobre la deslizante, chispa PointLight de 15 ms y motor de arranque; audio 100% sintetizado
   (sawtooth + paso bajo por carga + ruido de turbo + CLANK y silencio); Custom Sandbox con
   física en pausa, import .glb y Asistente de Sockets (gizmos + esferas guía) con alineación
   exacta al sellar; telemetría estilo F1 monoespaciada con barras que parpadean cerca del
   límite; InstancedMesh para tornillería, LOD por distancia y focus-zoom con OutlinePass.

   **Compromiso clave**: ningún integrador de cuerpos rígidos aguanta 8000 rpm a 60 fps, así que
   el cigüeñal es un cuerpo cinemático motorizado a ω visual acotada (cámara lenta automática)
   mientras TODAS las fuerzas de fallo usan la ω real del modelo de RPM. Las micro-piezas
   (tornillería, clips) son hijos de la malla principal, sin cuerpo rígido propio.

7. **Hecha** (pliego LOD): árbol maestro de componentes en `physics/engineDetail.ts` —
   distribución completa (2 levas a ω/2, 16 válvulas sincronizadas al ciclo de 4 tiempos,
   muelles/taqués/cadena/tensor), turbo con wastegate, colectores, plénum con mariposa,
   tuberías (intercooler, aceite del turbo, manguitos con abrazaderas, rampa), volante con
   corona dentada instanciada, cojinetes, juntas, 6 sensores (CKP/CMP/aceite/ECT/MAP/knock)
   e inyectores/bobinas. Rendimiento: estáticos fusionados con mergeGeometries (una malla por
   material), tornillería SOLO en InstancedMesh (pernos de biela con matrices por frame desde
   los cuerpos), presupuesto testeado <35 mallas. LOD de 3 niveles por distancia de cámara:
   inspección (todo), banco (proxies low-poly para tornillería) y global (solo carcasas macro).
   Pulso electrónico §4 exacto: #facc15/#eab308, intensidad 4.5, 15 ms, retorno a gris CAD.

## Estructura

```
src/
  main/           Proceso principal Electron
  preload/        Bridge (vacío por ahora)
  renderer/       React UI (banco dyno, ensamblador)
    src/physics/  Laboratorio físico: Rapier + sockets + matemáticas de fallo + audio
  shared/sim/     Núcleo de simulación — TS puro, sin dependencias de UI, testeado con vitest
    types.ts      Contratos: piezas, límites, ensamblaje, eventos, mapas ECU
    catalog.ts    Biblioteca de piezas (incl. combustibles y bombas)
    materials.ts  BD de materiales con propiedades reales (fase 2)
    assembly.ts   Validación de compatibilidad y geometría resultante
    ecu.ts        Mapas rpm×carga con interpolación bilineal y mapas por defecto
    fuel.ts       Bomba + regulador + inyectores: presión de raíl real
    cycle.ts      Ciclo termodinámico 0D (Wiebe + Woschni-lite + Chen-Flynn) + knock
    dyno.ts       Barrido de RPM, curvas, chequeo de límites y eventos de fallo
    transient.ts  Pull contra inercia: lag de turbo + inercia térmica
    wear.ts       Banco de resistencia: daño acumulado por mecanismo (Miner, picado, fluencia…)
    utilization.ts Utilización valor/límite por pieza para los overlays 3D
    import/       Métricas de malla (BVH), derivación analítica (nivel A) y FEA vóxel (nivel B)
```

8. **Hecha** (K20C1): el motor de exhibición del laboratorio es un Honda K20C1 (Civic Type R)
   modelado con solidsight en `design/k20c1/model.py` (spec de características con provenance
   [researched]/[assumed], 31 piezas, 10 `expect()` de holguras cumplidos: 0.3 mm pistón-camisa,
   0.05 mm cojinetes, 2 mm cigüeñal-bloque) y exportado a STL por pieza en
   `src/renderer/src/assets/k20c1/`. `physics/k20c1Detail.ts` lo adapta al contrato
   `EngineDetail`: escala ANISÓTROPA (kx = spacing/94 mm, k = bore/86 mm — todo gira sobre X,
   así que el estiramiento no se deforma al girar), pivotes recentrados con `datums.json`,
   carga STL asíncrona con `onReady()` (el rig intercambia las geometrías de pistón/biela
   conservando SUS materiales → el pintado de estrés y la rotura en rojo siguen vivos), vista
   seccionada por clipping plane (requiere `gl.localClippingEnabled`, lo activa PhysicsLab) y
   pulsos §4 sobre cuerpos propios en las posiciones reales de bobina/inyector/bomba HP.
   Con ≠4 cilindros se usa el árbol procedural de la fase 7 (fallback intacto). Fuera de
   escena a propósito: radiador/intercooler/ventiladores (el K20C1 termina en las bocas
   de admisión y downpipe).

## Gemelo digital HIL (en curso)

`src/shared/sim/hil/` — el motor como caja negra física y la ECU como caja negra lógica,
comunicadas SOLO por sensores/actuadores virtuales (ver ADR-001 en `hil/types.ts`: tick 240 Hz,
RK4+Euler semi-implícito, Float64 estado / Float32 rings, cableado declarativo).
**Las 4 fases completadas**: 1) bus + SensorManager (latencia/ruido/ADC/fallos, determinista);
2) núcleo de primeros principios (EDO monozona de presión, par por dS/dθ, turbo-rotor RK4,
mariposa con bloqueo sónico, Chen-Flynn×Vogel, heat-soak, arquetipo agnóstico con orden de
encendido generado — el laboratorio ya consume este par); 3) ECU caja negra (rpm derivada del
CKP, speed-density por MAP/IAT, DeadTime por tensión real, SimLoop
física→sensores→ECU→actuadores, fuerzas G); 4) banco de validación `hil/bench.ts`
(V8+fallo+20 sensores, 20k ticks: ~2.8 ms/frame medio, p99 ~5.5 ms, zero-alloc verificado con
el heap profiler de muestreo — investigación documentada en el propio bench).
**Backlog**: UI de cableado; SimLoop a Web Worker en el renderer (hoy acumulador in-thread a
2.8 ms/frame, 6× bajo presupuesto); acoplamiento knock→FatigueScore del bus.

## Unidades

SI en todo el núcleo: m, kg, s, Pa, K, J, W, rad. Conversión a unidades "de taller"
(bar, CV, Nm, °C, RPM) solo en la capa de presentación.

## Empaquetado y distribución

`npm run dist` compila con electron-vite y empaqueta con **electron-builder**
(config en `electron-builder.yml`). Salida en `release/`, que está en `.gitignore`:

| Artefacto | Qué es |
|---|---|
| `MotorForge-<ver>-x64.exe` | Instalador NSIS con pasos: deja elegir carpeta, crea accesos directos |
| `MotorForge-<ver>-portable.exe` | Ejecutable suelto, no instala nada |

`npm run dist:dir` deja la app descomprimida en `release/win-unpacked/` sin generar
instalador — es lo que conviene usar para probar un cambio de empaquetado, porque
tarda una fracción.

### Dos cosas que hay que saber antes de tocar esto

**No se copia `node_modules` al paquete.** El renderer lo empaqueta Vite en un
bundle único, y `out/main` + `out/preload` solo importan `electron` y módulos
nativos de node (comprobable con
`grep -oE '(from|require\()\s*"[^"./][^"]*"' out/main/index.js`). Incluir
`node_modules` sumaría cientos de MB de three, rapier y react que ya viven dentro
del bundle. **Si algún día el proceso principal importa una dependencia de
verdad, hay que añadirla a `files:` en `electron-builder.yml` o la app dejará de
arrancar una vez empaquetada** — y no fallará en `dev`, solo en el instalador.

**El esquema `app://` funciona dentro del asar.** El handler de `src/main/index.ts`
resuelve con `net.fetch(pathToFileURL(...))` sobre una ruta que, ya empaquetado,
cae dentro de `app.asar`. Está verificado arrancando el `.exe` generado: el
renderer carga desde `app://bundle/assets/...` y el laboratorio de Rapier se
inicializa. Si en el futuro algo dejara de cargar ahí, la salida es
`asarUnpack: ['out/renderer/**']`, no desactivar el asar entero.

### Icono

`npm run icon` regenera `build/icon.ico` y `build/icon.png` con
`scripts/gen-icon.py` (Pillow). Es un pistón dibujado con primitivas y
supermuestreado ×4. El `.ico` lleva siete tamaños (16→256) a propósito: si solo
llevara el de 256, Windows lo reduciría por su cuenta y saldría borroso en la
barra de tareas. Las proporciones (corona gorda, dos ranuras en vez de tres,
biela ancha) están elegidas para que la silueta aguante a 16 px, no para que
luzca a 1024.

### Firma

No hay firma de código. Windows SmartScreen avisará la primera vez que alguien
ejecute el instalador; es lo esperado en una app sin firmar y no indica un fallo
del empaquetado.

## Caja negra (registrador de banco)

`src/shared/sim/hil/blackBox.ts` — el registrador de datos del gemelo digital.
Funciona como la de un avión, no como un log: graba SIEMPRE en un anillo
circular, así que cuando algo revienta ya tienes los segundos **anteriores** al
fallo. Un log que empiezas cuando ves el problema llega tarde por definición.

```
parado ──arm()──> armado ──(disparo)──> disparado ──(postRoll)──> congelado
```

Se engancha con `loop.attachBlackBox()` y graba al final de cada tick, después
de la física, para que la verdad y las lecturas de sensores de una misma fila
del CSV correspondan al mismo instante. Es opcional y nula por defecto: el bench
de rendimiento mide la física sin registrador.

**Graba las tres capas a la vez**, que es lo que permite diagnosticar de verdad:
la VERDAD física (`Src.Truth`), lo que la ECU CREE (`Src.Sensor`, con su ruido,
retraso y ADC) y lo que la ECU ORDENÓ (`Src.Actuator`). Un MAP que se separa de
la presión real es un sensor muriéndose; una inyección que no sigue a la orden
es tensión o bomba. Más el estado interno y los campos por cilindro, que dicen
QUÉ cilindro se rompió y no solo que el motor se rompió.

`toCsv()` exporta con cabecera `nombre[unidad]`, tiempo absoluto y **tiempo
relativo al disparo** (negativo antes del evento), que es la columna que se mira
de verdad. `toManifest()` da los metadatos. Desde la app, `saveBlackBox()` en el
preload escribe los dos archivos juntos.

### Disparos: dos cosas aprendidas a base de falsos positivos

**Habilitación (`gate`).** Un disparo se evalúa solo mientras su condición de
habilitación se cumpla. Sin esto, media lista salta en cada arranque: a 200 rpm
la presión de aceite es baja de verdad y el acelerómetro del bloque recoge el
golpe del motor de arranque, y ninguna de las dos cosas es una avería. Es lo
mismo que hace un cuadro real, que no enciende el testigo de aceite mientras das
al contacto.

**Umbrales calibrados contra el modelo, no contra la literatura.** El primer
umbral de escape que se puso fueron los ~950 °C de manual, y disparaba en todos
los ensayos: este modelo da 1230 K (957 °C) **ya al ralentí** y hasta 1358 K en
marcha. La tabla de rangos medidos está en el comentario de `bankTriggers()`.
Un disparo que salta siempre es peor que no tener disparo, porque enseña a
ignorarlo.

> Pendiente de mirar, y es del núcleo, no del registrador: 957 °C de escape al
> ralentí es altísimo para un gasolina atmosférico (lo normal en el colector son
> 300-400 °C). Parece que `Tap.ExhaustT` devuelve algo cercano a la temperatura
> de combustión y no la del gas ya mezclado en el colector, que es lo que
> mediría una sonda EGT real. Si se corrige, hay que bajar el umbral con ella.

### Coste

`record()` cumple ADR-001 §5: cero asignaciones por tick, verificado con un test
que mide el heap sobre 100.000 ticks. Las muestras van en un único `Float32Array`
de `capacidad × canales` (§3: anillo grande recorrido en bloque). Por defecto
graba a 60 Hz diezmando el tick de 240; el picado necesita 240 si se va a
analizar de verdad.

## Diseñador de motores

`src/shared/sim/designer.ts` + `renderer/src/components/EngineDesigner.tsx` —
la pestaña **Diseñar motor** convierte una arquitectura (cilindros, disposición,
calibre, carrera, relación biela/carrera, compresión, materiales) en un juego de
piezas que el resto de la aplicación ya sabe simular.

Antes de esto no se podía hacer un motor que no fuera el 2.0 del catálogo: solo
había **dos bloques, los dos de 4 cilindros y 86 mm**. La física nunca fue el
problema — `buildArchetype` acepta de 1 a 16 cilindros y deriva el orden de
encendido y los desfases de banco solo. Lo que faltaba era la capa para
**autoriar** el motor.

Las piezas diseñadas entran por el mismo saco de "piezas importadas" que ya
existía, así que banco, laboratorio, desgaste y proyectos funcionan con ellas sin
un solo cambio propio.

### Los límites se derivan, no se escriben

Misma regla que `archetype.ts` ("sin valores hardcodeados por arquetipo"). Cada
ley está calibrada para **reproducir el catálogo** en su punto de referencia
(86 × 86 mm): si diseñas ese motor, salen sus números exactos, y hay un test que
lo comprueba.

| Pieza | Ley | Por qué |
|---|---|---|
| Cigüeñal | velocidad media de pistón constante | lo que rompe la muñequilla es la inercia alternativa; más carrera ⇒ menos vueltas |
| Biela (compresión) | Euler: ∝ calibre⁴/L² | pandeo, no rotura |
| Biela (tracción) | ∝ calibre² | sección pura |
| Pistón (presión) | independiente del calibre | corona de espesor proporcional al radio: la tensión va con la presión, no con el tamaño |
| Bloque | material, penalizado si es supercuadrado | a más calibre para la misma carrera, menos material entre cilindros |
| Masas | pistón ∝ calibre³, biela ∝ L·calibre² | semejanza geométrica |

La cámara de combustión se calcula **invirtiendo** la fórmula de compresión de
`assembly.ts`, para que la relación que pides sea exactamente la que sale al
resolver. Ojo: `HEAD_GASKET_THICKNESS` está duplicada en los dos archivos y
**tiene que coincidir**, o la compresión pedida deja de ser la real.

Cada límite se muestra en pantalla con su explicación y su modo de fallo. Es la
diferencia entre "aguanta 180 bar" y "aguanta 180 bar porque el pandeo va con
I/L²": lo segundo enseña a diseñar.
