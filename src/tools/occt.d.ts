// occt-import-js ships no typings (emscripten CommonJS factory).
declare module 'occt-import-js' {
  const factory: (overrides?: unknown) => Promise<unknown>;
  export default factory;
}
