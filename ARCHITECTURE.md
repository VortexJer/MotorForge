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
- **Nivel B (FEA vóxel, al importar, cacheado)**: voxelización robusta (three-mesh-bvh) +
  elasticidad lineal con gradiente conjugado matrix-free; se escala carga unitaria hasta von Mises = límite elástico.

## Fases

1. **MVP — hecha**: catálogo de piezas con límites de fábrica, ensamblador con validación de
   compatibilidad, simulación de ciclo Otto, banco dyno (CV/par vs RPM), fallos por límite duro con causa.
2. **Hecha**: import STEP/IGES/STL (occt-import-js en worker) + BD de materiales + derivación analítica de límites.
3. **Hecha**: mapas ECU (λ/avance por rpm×carga, bilineal), sistema de combustible (bomba + regulador +
   inyectores √ΔP → presión de raíl real), knock por octanaje requerido, transitorios (pull contra
   inercia con lag de turbo e inercia térmica).
4. Desgaste acumulado, fatiga, fallos progresivos, FEA vóxel, overlays 3D térmicos/tensión.

## Estructura

```
src/
  main/           Proceso principal Electron
  preload/        Bridge (vacío por ahora)
  renderer/       React UI (banco dyno, ensamblador)
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
    import/       Métricas de malla (BVH) y derivación analítica de límites
```

## Unidades

SI en todo el núcleo: m, kg, s, Pa, K, J, W, rad. Conversión a unidades "de taller"
(bar, CV, Nm, °C, RPM) solo en la capa de presentación.
