import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@sim': resolve(__dirname, 'src/shared/sim')
    }
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Los ficheros se ejecutan DE UNO EN UNO a propósito.
    //
    // `hil/bench.test.ts` no comprueba que algo funcione, sino CUÁNTO TARDA
    // (p99 por frame) y que no asigna memoria. Con varios ficheros de test
    // repartiéndose los núcleos, esas dos medidas dejan de significar nada:
    // el bench empezó a agotar su tiempo en cuanto el proyecto ganó ficheros
    // de test, no porque el código fuese más lento. Lo mismo vale para el test
    // de cero asignaciones de la caja negra, que mide el heap del proceso.
    //
    // Coste real de serializar: unos pocos segundos en toda la suite. Barato a
    // cambio de que un fallo de rendimiento signifique un fallo de rendimiento.
    fileParallelism: false,
    // El bench recorre 20.000 ticks de un V8 con 20 sensores: 30 s se le quedan
    // cortos en una máquina cargada, y un falso rojo enseña a ignorar la suite.
    testTimeout: 120_000
  }
})
