# MotorForge

Offline desktop app to design, assemble and simulate internal-combustion engines part by part,
and to explain every failure with its **causal chain**:

```
boost 2.4 bar → peak pressure 190 bar → con-rod load 82 kN > buckling limit 74 kN
```

> Status: in development (research phase). Windows installer available via `npm run dist`.

## What it does

- **Engine model** — 0D single-zone Otto cycle (Wiebe combustion, Woschni-style heat transfer,
  Chen-Flynn friction), dyno curves (power/torque vs RPM), knock from required octane, ECU maps
  (λ and ignition advance over RPM × load) and fuel system (pump, regulator, injectors).
- **Explainable failures** — every term in the physics model records its dependencies, so a
  failure event carries the chain of causes that produced it.
- **Part limits from geometry** — import STEP/IGES/STL (OpenCascade in a worker), pick a material,
  and limits are derived analytically (Euler buckling, Lamé, Goodman fatigue) or with a
  **voxel FEA** solver (matrix-free conjugate gradient, von Mises p95).
- **Endurance bench** — accumulated wear across runs and sessions (Miner fatigue, ring-land
  pitting, thermal creep, bearings), so an engine stays "used" until rebuilt.
- **Physics lab** — the reciprocating assembly as Rapier rigid bodies with revolute and prismatic
  joints; breakage destroys joints and frees parts. Synthesised engine audio and F1-style telemetry.
- **HIL digital twin** — ECU and engine communicate only through a sensor bus.
- **Projects** — save/open `.mforge.json`, A/B dyno comparison, run history and CSV export.

## Design principles

1. **Explainable** — no failure without a cause chain.
2. **One limits contract** — the simulation consumes `DerivedLimit[]` regardless of whether a limit
   comes from the catalogue, analytic formulas, voxel FEA or manual input.
3. **Deterministic** — same assembly + same config ⇒ same result, so failures are reproducible.
4. **Simplified but coherent physics** — never dynamic CFD/FEA.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design (in Spanish).

## Stack

Electron · electron-vite · React 19 · TypeScript · Zustand · Three.js / React Three Fiber ·
Rapier (WASM) · occt-import-js · three-mesh-bvh · Vitest

## Run it

```bash
npm install
npm run dev        # development
npm test           # Vitest suite
npm run typecheck
npm run dist       # build + installer (electron-builder)
```
