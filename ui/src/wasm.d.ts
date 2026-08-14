/** Vite's `?url` imports resolve to a string at build time. */
declare module '*.wasm?url' {
  const url: string;
  export default url;
}
