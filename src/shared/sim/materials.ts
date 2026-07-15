/**
 * Base de datos de materiales de motor con propiedades reales (SI).
 * Al importar una pieza, el usuario solo elige material: los límites de
 * fallo se derivan de geometría + estas propiedades (ver import/derive.ts).
 */

export interface Material {
  id: string
  name: string
  category: 'acero' | 'aluminio' | 'fundición' | 'titanio' | 'superaleación'
  density: number // kg/m³
  youngModulus: number // Pa
  poisson: number
  yieldStrength: number // Pa (0.2%)
  ultimateStrength: number // Pa
  /** Límite de fatiga a ~1e7 ciclos, flexión rotativa. */
  fatigueLimit: number // Pa
  /** Temperatura a la que conserva propiedades de diseño. */
  maxServiceTemp: number // K
  meltingPoint: number // K
  thermalConductivity: number // W/(m·K)
  thermalExpansion: number // 1/K
}

export const MATERIALS: Material[] = [
  {
    id: 'steel-4340',
    name: 'Acero 4340 templado y revenido',
    category: 'acero',
    density: 7850,
    youngModulus: 205e9,
    poisson: 0.29,
    yieldStrength: 950e6,
    ultimateStrength: 1150e6,
    fatigueLimit: 490e6,
    maxServiceTemp: 700,
    meltingPoint: 1700,
    thermalConductivity: 44,
    thermalExpansion: 12.3e-6
  },
  {
    id: 'steel-c70',
    name: 'Acero C70 sinterizado (biela de serie)',
    category: 'acero',
    density: 7800,
    youngModulus: 200e9,
    poisson: 0.29,
    yieldStrength: 550e6,
    ultimateStrength: 900e6,
    fatigueLimit: 350e6,
    maxServiceTemp: 650,
    meltingPoint: 1690,
    thermalConductivity: 46,
    thermalExpansion: 12e-6
  },
  {
    id: 'steel-17-4ph',
    name: 'Inox 17-4PH H900 (hidráulica de inyección)',
    category: 'acero',
    density: 7750,
    youngModulus: 196e9,
    poisson: 0.27,
    yieldStrength: 1170e6,
    ultimateStrength: 1310e6,
    fatigueLimit: 480e6,
    maxServiceTemp: 590,
    meltingPoint: 1710,
    thermalConductivity: 18,
    thermalExpansion: 10.8e-6
  },
  {
    id: 'alu-2618',
    name: 'Aluminio 2618-T6 forjado (pistones racing)',
    category: 'aluminio',
    density: 2760,
    youngModulus: 74e9,
    poisson: 0.33,
    yieldStrength: 372e6,
    ultimateStrength: 440e6,
    fatigueLimit: 125e6,
    maxServiceTemp: 690,
    meltingPoint: 911,
    thermalConductivity: 146,
    thermalExpansion: 22.3e-6
  },
  {
    id: 'alu-4032',
    name: 'Aluminio 4032 hipereutéctico (pistones de serie)',
    category: 'aluminio',
    density: 2680,
    youngModulus: 79e9,
    poisson: 0.33,
    yieldStrength: 315e6,
    ultimateStrength: 380e6,
    fatigueLimit: 110e6,
    maxServiceTemp: 610,
    meltingPoint: 830,
    thermalConductivity: 138,
    thermalExpansion: 19.4e-6
  },
  {
    id: 'alu-a356',
    name: 'Aluminio A356-T6 fundido (bloques y culatas)',
    category: 'aluminio',
    density: 2685,
    youngModulus: 72.4e9,
    poisson: 0.33,
    yieldStrength: 228e6,
    ultimateStrength: 262e6,
    fatigueLimit: 85e6,
    maxServiceTemp: 570,
    meltingPoint: 888,
    thermalConductivity: 151,
    thermalExpansion: 21.5e-6
  },
  {
    id: 'iron-gg25',
    name: 'Fundición gris GG25 (bloques)',
    category: 'fundición',
    density: 7200,
    youngModulus: 110e9,
    poisson: 0.26,
    yieldStrength: 195e6,
    ultimateStrength: 250e6,
    fatigueLimit: 110e6,
    maxServiceTemp: 720,
    meltingPoint: 1450,
    thermalConductivity: 48,
    thermalExpansion: 11e-6
  },
  {
    id: 'iron-ggg60',
    name: 'Fundición nodular GGG60 (cigüeñales de serie)',
    category: 'fundición',
    density: 7100,
    youngModulus: 174e9,
    poisson: 0.28,
    yieldStrength: 370e6,
    ultimateStrength: 600e6,
    fatigueLimit: 260e6,
    maxServiceTemp: 700,
    meltingPoint: 1420,
    thermalConductivity: 32,
    thermalExpansion: 11.2e-6
  },
  {
    id: 'ti-6al4v',
    name: 'Titanio Ti-6Al-4V (bielas de competición)',
    category: 'titanio',
    density: 4430,
    youngModulus: 114e9,
    poisson: 0.34,
    yieldStrength: 880e6,
    ultimateStrength: 950e6,
    fatigueLimit: 510e6,
    maxServiceTemp: 670,
    meltingPoint: 1930,
    thermalConductivity: 6.7,
    thermalExpansion: 8.6e-6
  },
  {
    id: 'inconel-718',
    name: 'Inconel 718 (válvulas de escape, turbo)',
    category: 'superaleación',
    density: 8190,
    youngModulus: 200e9,
    poisson: 0.29,
    yieldStrength: 1035e6,
    ultimateStrength: 1240e6,
    fatigueLimit: 490e6,
    maxServiceTemp: 970,
    meltingPoint: 1610,
    thermalConductivity: 11.4,
    thermalExpansion: 13e-6
  }
]

export function materialById(id: string): Material {
  const m = MATERIALS.find((m) => m.id === id)
  if (!m) throw new Error(`Material desconocido: ${id}`)
  return m
}
