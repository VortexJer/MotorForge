/// <reference types="vite/client" />

import type { MotorForgeApi } from '../../preload/index'

declare global {
  interface Window {
    motorforge: MotorForgeApi
  }
}
