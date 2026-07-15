declare module 'occt-import-js' {
  export interface OcctMesh {
    name?: string
    attributes: {
      position: { array: ArrayLike<number> }
      normal?: { array: ArrayLike<number> }
    }
    index: { array: ArrayLike<number> }
  }
  export interface OcctResult {
    success: boolean
    meshes: OcctMesh[]
  }
  export interface OcctModule {
    ReadStepFile(content: Uint8Array, params: null): OcctResult
    ReadIgesFile(content: Uint8Array, params: null): OcctResult
    ReadBrepFile(content: Uint8Array, params: null): OcctResult
  }
  export interface OcctInitOptions {
    wasmBinary?: ArrayBuffer
    locateFile?: (file: string) => string
  }
  const occtimportjs: (options?: OcctInitOptions) => Promise<OcctModule>
  export default occtimportjs
}
