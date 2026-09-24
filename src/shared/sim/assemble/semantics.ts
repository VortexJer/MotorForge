import { MARKER, norm, sub, dot, len, perp } from './scene'
import type { EngineScene, Vec3 } from './scene'

/**
 * Consecuencias FÍSICAS de dónde has puesto los marcadores.
 *
 * Esto es lo que hace que colocar un inyector sea marcar y no decorar. Las tres
 * cosas que se leen aquí son las que un motorista de verdad discutiría:
 *
 *  · INYECCIÓN DIRECTA O INDIRECTA. Se deduce de si la punta del inyector cae
 *    DENTRO del cilindro (por debajo del plano de culata) o fuera, en el
 *    colector. Inyectar dentro enfría la carga al evaporarse el combustible:
 *    entra aire más denso y el motor aguanta más compresión sin picar. Es la
 *    razón por la que los motores modernos son de inyección directa.
 *
 *  · POSICIÓN DE LA BUJÍA. Lo que importa es cuánto tiene que recorrer la llama
 *    desde la chispa hasta el punto más lejano de la cámara. Una bujía centrada
 *    quema rápido y parejo; una descentrada deja una zona de mezcla lejos que
 *    se calienta y comprime mientras espera, que es donde nace la detonación.
 *
 *  · PALANCA DEL MOTOR DE ARRANQUE. Su distancia al eje del cigüeñal es el radio
 *    donde aplica el par. Engranar cerca del eje es como aflojar una tuerca
 *    agarrando la llave por el medio.
 */

export interface SemanticEffects {
  /** true = la punta del inyector está dentro del cilindro. */
  inyeccionDirecta: boolean
  /** Multiplicador de llenado por enfriamiento de carga (1 = sin efecto). */
  factorLlenado: number
  /** Recorrido de llama relativo al calibre. 0,5 = bujía en el borde. */
  recorridoLlama: number
  /** Multiplicador de avance admisible: <1 si la llama tiene que viajar mucho. */
  factorAvance: number
  /** Radio de engrane del arranque (m). NaN si no hay o no se puede medir. */
  radioArranque: number
  /** Explicaciones para enseñar en pantalla. */
  efectos: string[]
  avisos: string[]
}

const nada = (): SemanticEffects => ({
  inyeccionDirecta: false, factorLlenado: 1, recorridoLlama: 0.25,
  factorAvance: 1, radioArranque: NaN, efectos: [], avisos: []
})

export function readSemantics(
  scene: EngineScene,
  cilindro: { corona: Vec3; eje: Vec3; calibre: number } | null,
  /**
   * Coronas de TODOS los cilindros. Sin esto, el radio se medía siempre contra
   * el eje del primer cilindro y los inyectores de los demás caían "fuera" por
   * estar en su propio cilindro, que es justo donde tienen que estar.
   */
  coronas?: Vec3[]
): SemanticEffects {
  const r = nada()
  if (!cilindro || !(cilindro.calibre > 0)) return r
  const { corona, eje, calibre } = cilindro
  const u = norm(eje) // apunta de la corona hacia la culata

  // ------------------------------------------------------------- inyección
  const inyectores = scene.parts.filter((p) => p.role === 'injector')
  const puntas = inyectores
    .map((p) => p.markers.find((m) => m.id === MARKER.injectorTip))
    .filter((m): m is NonNullable<typeof m> => !!m)

  if (puntas.length > 0) {
    // "Dentro del cilindro" = por encima de la corona pero a menos de medio
    // calibre de altura, y dentro del radio. Ahí es donde va un inyector de
    // inyección directa: asomado a la cámara.
    const todasCoronas = coronas && coronas.length > 0 ? coronas : [corona]
    const dentro = puntas.filter((m) => {
      // Altura sobre el plano de las coronas: es el discriminante real entre
      // inyectar en la cámara y inyectar en el colector.
      const h = dot(sub(m.position, corona), u)
      if (!(h > -calibre * 0.05 && h < calibre * 0.6)) return false
      // Y que caiga sobre ALGÚN cilindro, no necesariamente el primero.
      let radialMin = Infinity
      for (const c of todasCoronas) {
        radialMin = Math.min(radialMin, len(perp(sub(m.position, c), u)))
      }
      return radialMin < calibre * 0.75
    })
    r.inyeccionDirecta = dentro.length > puntas.length / 2
    if (r.inyeccionDirecta) {
      // El calor de vaporización sale del aire admitido: enfría la carga y la
      // densifica. Una mejora de llenado del 5% es lo que se ve en la práctica.
      r.factorLlenado = 1.05
      r.efectos.push(
        'Inyección DIRECTA: las puntas asoman a la cámara. El combustible se evapora dentro y ' +
          'enfría la carga, así que entra aire más denso (+5% de llenado) y hay más margen ante ' +
          'la detonación.'
      )
    } else {
      r.efectos.push(
        'Inyección INDIRECTA: los inyectores quedan fuera del cilindro, en el colector. El ' +
          'combustible se evapora antes de entrar, así que no enfría la carga admitida.'
      )
    }

    // La dirección del chorro debería apuntar hacia dentro del cilindro.
    for (const m of puntas) {
      if (!m.direction) continue
      const haciaDentro = dot(norm(m.direction), u) // u va hacia la culata
      if (haciaDentro > 0.5) {
        r.avisos.push(
          'Hay un inyector cuyo chorro apunta hacia la culata en vez de hacia el pistón. ' +
            'Gira su dirección: así estarías mojando la cámara por arriba.'
        )
        break
      }
    }
  }

  // ------------------------------------------------------------------ bujía
  const chispas = scene.parts
    .filter((p) => p.role === 'sparkPlug')
    .map((p) => p.markers.find((m) => m.id === MARKER.sparkGap))
    .filter((m): m is NonNullable<typeof m> => !!m)

  if (chispas.length > 0) {
    // Descentramiento medio de la chispa respecto al eje del cilindro.
    // Contra SU cilindro, no contra el primero: una bujía centrada en el
    // cilindro 4 no está descentrada, está en su sitio.
    const cor = coronas && coronas.length > 0 ? coronas : [corona]
    const offsets = chispas.map((m) => {
      let min = Infinity
      for (const c of cor) min = Math.min(min, len(perp(sub(m.position, c), u)))
      return min / calibre
    })
    const off = offsets.reduce((s, v) => s + v, 0) / offsets.length
    // Recorrido de llama: del punto de chispa al borde más lejano de la cámara.
    r.recorridoLlama = 0.5 + off
    if (off < 0.12) {
      r.efectos.push(
        `Bujía CENTRADA (${(off * 100).toFixed(0)}% del calibre fuera del eje): la llama recorre ` +
          'lo mismo en todas direcciones, la combustión es rápida y pareja.'
      )
    } else {
      // Más recorrido = más tiempo con la mezcla lejana comprimiéndose = menos
      // avance admisible antes de que pique.
      r.factorAvance = Math.max(0.7, 1 - (off - 0.12) * 1.2)
      r.efectos.push(
        `Bujía DESCENTRADA (${(off * 100).toFixed(0)}% del calibre fuera del eje): la llama tarda ` +
          `más en llegar al extremo opuesto, así que admite un ${((1 - r.factorAvance) * 100).toFixed(0)}% ` +
          'menos de avance antes de detonar.'
      )
      if (off > 0.45) {
        r.avisos.push(
          'La bujía cae prácticamente en la pared del cilindro. Comprueba que la marcaste en el ' +
            'electrodo y no en la rosca o en el cuerpo.'
        )
      }
    }
  }

  // ---------------------------------------------------------------- arranque
  const arranque = scene.parts.find((p) => p.role === 'starter')
  const crank = scene.parts.find((p) => p.role === 'crank')
  if (arranque && crank) {
    const eng = arranque.markers.find((m) => m.id === MARKER.starterDrive)?.position
    const a = crank.markers.find((m) => m.id === MARKER.crankAxisA)?.position
    const b = crank.markers.find((m) => m.id === MARKER.crankAxisB)?.position
    if (eng && a && b && len(sub(b, a)) > 1e-6) {
      const ue = norm(sub(b, a))
      r.radioArranque = len(perp(sub(eng, a), ue))
      if (r.radioArranque < 0.02) {
        r.avisos.push(
          `El arranque engrana a ${(r.radioArranque * 1000).toFixed(0)} mm del eje del cigüeñal: ` +
            'demasiado cerca para hacer palanca. Suele engranar en la corona del volante.'
        )
      } else {
        r.efectos.push(
          `El arranque engrana a ${(r.radioArranque * 1000).toFixed(0)} mm del eje, que es el radio ` +
            'donde hace palanca para vencer la compresión.'
        )
      }
    }
  }

  return r
}
