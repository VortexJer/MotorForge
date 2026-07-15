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
