import type {
  AspirationPart,
  BlockPart,
  CrankPart,
  FuelPumpPart,
  FuelSpec,
  HeadPart,
  InjectorPart,
  Part,
  PistonPart,
  RodPart
} from './types'

/**
 * Biblioteca de piezas v0. Los límites llevan provenance 'catalog': números
 * de ficha técnica escritos a mano. En fase 2 las piezas importadas obtendrán
 * el mismo contrato con provenance 'derived-analytic' / 'derived-fea'.
 *
 * Base: un cuatro cilindros en línea 2.0 (86 × 86) tipo deportivo atmosférico.
 */

export const FUELS: Record<string, FuelSpec> = {
  gasolina95: {
    name: 'Gasolina 95',
    stoichAFR: 14.7,
    lhv: 42.9e6,
    density: 745,
    octane: 95,
    richCooling: 850
  },
  gasolina98: {
    name: 'Gasolina 98',
    stoichAFR: 14.7,
    lhv: 43.0e6,
    density: 750,
    octane: 98,
    richCooling: 850
  },
  e85: {
    name: 'E85 (etanol 85%)',
    stoichAFR: 9.8,
    lhv: 29.2e6,
    density: 785,
    // RON efectivo ~106 y gran calor de vaporización: el combustible anti-knock
    octane: 106,
    richCooling: 2100
  }
}

export const BLOCKS: BlockPart[] = [
  {
    id: 'block-alu-2.0',
    kind: 'block',
    name: 'Bloque aluminio 2.0 (86 mm)',
    source: 'catalog',
    spec: { bore: 0.086, deckHeight: 0.212, cylinders: 4 },
    limits: [
      {
        variable: 'peakCylinderPressure',
        value: 150e5,
        provenance: 'catalog',
        explanation: 'Bloque aluminio open-deck: la camisa flecta por encima de ~150 bar',
        failureMode: 'Fisura de camisa / junta de culata'
      }
    ]
  },
  {
    id: 'block-iron-2.0',
    kind: 'block',
    name: 'Bloque fundición 2.0 (86 mm) reforzado',
    source: 'catalog',
    spec: { bore: 0.086, deckHeight: 0.212, cylinders: 4 },
    limits: [
      {
        variable: 'peakCylinderPressure',
        value: 230e5,
        provenance: 'catalog',
        explanation: 'Fundición closed-deck con espárragos: soporta ~230 bar de presión pico',
        failureMode: 'Fisura de camisa / junta de culata'
      }
    ]
  }
]

export const CRANKS: CrankPart[] = [
  {
    id: 'crank-cast-86',
    kind: 'crank',
    name: 'Cigüeñal fundido 86 mm',
    source: 'catalog',
    spec: { stroke: 0.086 },
    limits: [
      {
        variable: 'rpm',
        value: 8400,
        provenance: 'catalog',
        explanation: 'Cigüeñal fundido: fatiga en muñequillas por encima de 8400 rpm sostenidas',
        failureMode: 'Rotura de muñequilla por fatiga'
      }
    ]
  },
  {
    id: 'crank-forged-86',
    kind: 'crank',
    name: 'Cigüeñal forjado 86 mm equilibrado',
    source: 'catalog',
    spec: { stroke: 0.086 },
    limits: [
      {
        variable: 'rpm',
        value: 10200,
        provenance: 'catalog',
        explanation: 'Forjado 4340 nitrurado, equilibrado dinámicamente hasta 10 200 rpm',
        failureMode: 'Rotura de muñequilla por fatiga'
      }
    ]
  }
]

export const RODS: RodPart[] = [
  {
    id: 'rod-stock-139',
    kind: 'rod',
    name: 'Biela de serie 139 mm (acero sinterizado)',
    source: 'catalog',
    spec: { length: 0.139, mass: 0.57 },
    limits: [
      {
        variable: 'rodCompression',
        value: 68e3,
        provenance: 'catalog',
        explanation: 'Sección en I de serie: pandeo a ~68 kN de carga axial',
        failureMode: 'Pandeo de biela (ventana en el bloque)'
      },
      {
        variable: 'rodTension',
        value: 29e3,
        provenance: 'catalog',
        explanation: 'Tornillería de serie: los tornillos ceden a ~29 kN de tracción',
        failureMode: 'Rotura de tornillos de biela en cruce de PMS'
      }
    ]
  },
  {
    id: 'rod-forged-139',
    kind: 'rod',
    name: 'Biela forjada H-beam 139 mm',
    source: 'catalog',
    spec: { length: 0.139, mass: 0.60 },
    limits: [
      {
        variable: 'rodCompression',
        value: 130e3,
        provenance: 'catalog',
        explanation: 'H-beam 4340 forjada: pandeo a ~130 kN',
        failureMode: 'Pandeo de biela'
      },
      {
        variable: 'rodTension',
        value: 55e3,
        provenance: 'catalog',
        explanation: 'Tornillos ARP2000: tracción máxima ~55 kN',
        failureMode: 'Rotura de tornillos de biela'
      }
    ]
  }
]

export const PISTONS: PistonPart[] = [
  {
    id: 'piston-cast-86',
    kind: 'piston',
    name: 'Pistón fundido 86 mm (serie)',
    source: 'catalog',
    spec: { bore: 0.086, compressionHeight: 0.030, mass: 0.40, domeVolume: 0 },
    limits: [
      {
        variable: 'peakCylinderPressure',
        value: 125e5,
        provenance: 'catalog',
        explanation: 'Aleación hipereutéctica fundida: la corona cede a ~125 bar',
        failureMode: 'Rotura de corona / falda de pistón'
      },
      {
        variable: 'crownTemp',
        value: 610,
        provenance: 'catalog',
        explanation: 'El material fundido pierde resistencia a partir de ~610 K (337 °C) en corona',
        failureMode: 'Fusión / ablandamiento de corona de pistón'
      },
      {
        variable: 'knockIndex',
        value: 1.05,
        provenance: 'catalog',
        explanation: 'Aleación fundida frágil: la detonación sostenida rompe el puente entre segmentos',
        failureMode: 'Picado (detonación): rotura de ringland'
      }
    ]
  },
  {
    id: 'piston-forged-86',
    kind: 'piston',
    name: 'Pistón forjado 2618 86 mm',
    source: 'catalog',
    spec: { bore: 0.086, compressionHeight: 0.030, mass: 0.42, domeVolume: -3e-6 },
    limits: [
      {
        variable: 'peakCylinderPressure',
        value: 200e5,
        provenance: 'catalog',
        explanation: 'Forjado 2618 de competición: soporta ~200 bar de presión pico',
        failureMode: 'Rotura de corona de pistón'
      },
      {
        variable: 'crownTemp',
        value: 690,
        provenance: 'catalog',
        explanation: 'El 2618 forjado mantiene propiedades hasta ~690 K (417 °C)',
        failureMode: 'Fusión / ablandamiento de corona de pistón'
      },
      {
        variable: 'knockIndex',
        value: 1.15,
        provenance: 'catalog',
        explanation: 'El forjado dúctil tolera picado ligero antes de dañar el ringland',
        failureMode: 'Picado (detonación): rotura de ringland'
      }
    ]
  }
]

export const HEADS: HeadPart[] = [
  {
    id: 'head-sport-42',
    kind: 'head',
    name: 'Culata deportiva 16v (cámara 42 cc)',
    source: 'catalog',
    spec: {
      chamberVolume: 42e-6,
      veCurve: [
        [1000, 0.74],
        [2000, 0.82],
        [3000, 0.87],
        [4000, 0.91],
        [5000, 0.95],
        [6000, 0.97],
        [7000, 0.95],
        [8000, 0.90],
        [9500, 0.80]
      ]
    },
    limits: [
      {
        variable: 'exhaustTemp',
        value: 1220,
        provenance: 'catalog',
        explanation: 'Válvulas de escape monometálicas: pierden asiento por encima de ~1220 K (947 °C)',
        failureMode: 'Quemado de válvula de escape'
      }
    ]
  },
  {
    id: 'head-race-40',
    kind: 'head',
    name: 'Culata trabajada + levas (cámara 40 cc, válvulas Inconel)',
    source: 'catalog',
    spec: {
      chamberVolume: 40e-6,
      veCurve: [
        [1000, 0.70],
        [2000, 0.78],
        [3000, 0.85],
        [4000, 0.92],
        [5000, 0.98],
        [6000, 1.02],
        [7000, 1.03],
        [8000, 1.00],
        [9500, 0.92]
      ]
    },
    limits: [
      {
        variable: 'exhaustTemp',
        value: 1340,
        provenance: 'catalog',
        explanation: 'Válvulas Inconel y asientos de berilio-cobre: hasta ~1340 K (1067 °C)',
        failureMode: 'Quemado de válvula de escape'
      }
    ]
  }
]

export const INJECTORS: InjectorPart[] = [
  {
    id: 'inj-310',
    kind: 'injector',
    name: 'Inyectores 310 cc/min (serie)',
    source: 'catalog',
    // 310 cc/min × 0.745 kg/l ≈ 3.85 g/s
    spec: { staticFlow: 3.85e-3 },
    limits: [
      {
        variable: 'injectorDuty',
        value: 0.85,
        provenance: 'catalog',
        explanation: 'Por encima del 85% de duty el inyector no cierra de forma consistente',
        failureMode: 'Inyector saturado: la mezcla empobrece sin control'
      }
    ]
  },
  {
    id: 'inj-550',
    kind: 'injector',
    name: 'Inyectores 550 cc/min',
    source: 'catalog',
    spec: { staticFlow: 6.83e-3 },
    limits: [
      {
        variable: 'injectorDuty',
        value: 0.85,
        provenance: 'catalog',
        explanation: 'Por encima del 85% de duty el inyector no cierra de forma consistente',
        failureMode: 'Inyector saturado: la mezcla empobrece sin control'
      }
    ]
  },
  {
    id: 'inj-1000',
    kind: 'injector',
    name: 'Inyectores 1000 cc/min',
    source: 'catalog',
    spec: { staticFlow: 12.4e-3 },
    limits: [
      {
        variable: 'injectorDuty',
        value: 0.85,
        provenance: 'catalog',
        explanation: 'Por encima del 85% de duty el inyector no cierra de forma consistente',
        failureMode: 'Inyector saturado: la mezcla empobrece sin control'
      }
    ]
  }
]

export const FUEL_PUMPS: FuelPumpPart[] = [
  {
    id: 'pump-stock-110',
    kind: 'fuelPump',
    name: 'Bomba de serie 110 l/h',
    source: 'catalog',
    // 110 l/h × 0.745 kg/l a 3.5 bar; corte a 5 bar
    spec: { maxFlow: 2.28e-2, maxPressure: 5.0e5 },
    limits: []
  },
  {
    id: 'pump-255',
    kind: 'fuelPump',
    name: 'Bomba de alto caudal 255 l/h',
    source: 'catalog',
    spec: { maxFlow: 5.28e-2, maxPressure: 8.0e5 },
    limits: []
  },
  {
    id: 'pump-dual-460',
    kind: 'fuelPump',
    name: 'Doble bomba 460 l/h (competición)',
    source: 'catalog',
    spec: { maxFlow: 9.52e-2, maxPressure: 9.0e5 },
    limits: []
  }
]

export const ASPIRATIONS: AspirationPart[] = [
  {
    id: 'asp-na',
    kind: 'aspiration',
    name: 'Admisión atmosférica',
    source: 'catalog',
    spec: { type: 'na', defaultBoost: 0, spoolRpm: 0 },
    limits: []
  },
  {
    id: 'asp-turbo-gt28',
    kind: 'aspiration',
    name: 'Turbo GT2860 (spool ~3200 rpm)',
    source: 'catalog',
    spec: { type: 'turbo', defaultBoost: 0.8e5, spoolRpm: 3200 },
    limits: [
      {
        variable: 'boost',
        value: 1.6e5,
        provenance: 'catalog',
        explanation: 'A más de 1.6 bar el compresor sale de mapa y el eje supera su régimen máximo',
        failureMode: 'Sobrerrégimen de turbo: rotura de rodete'
      }
    ]
  },
  {
    id: 'asp-turbo-gt35',
    kind: 'aspiration',
    name: 'Turbo GT3582 (spool ~4600 rpm)',
    source: 'catalog',
    spec: { type: 'turbo', defaultBoost: 1.2e5, spoolRpm: 4600 },
    limits: [
      {
        variable: 'boost',
        value: 2.5e5,
        provenance: 'catalog',
        explanation: 'Compresor grande: admite hasta 2.5 bar dentro de mapa',
        failureMode: 'Sobrerrégimen de turbo: rotura de rodete'
      }
    ]
  }
]

export const CATALOG: Part[] = [
  ...BLOCKS,
  ...CRANKS,
  ...RODS,
  ...PISTONS,
  ...HEADS,
  ...INJECTORS,
  ...FUEL_PUMPS,
  ...ASPIRATIONS
]

export function partById<T extends Part>(id: string): T {
  const part = CATALOG.find((p) => p.id === id)
  if (!part) throw new Error(`Pieza desconocida: ${id}`)
  return part as T
}
