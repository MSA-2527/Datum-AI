/**
 * The shape of the OpenCascade module, as far as this application uses it.
 *
 * The package ships no types. Declaring the whole of OCCT would be tens of thousands of lines of
 * generated declarations for an API surface this uses perhaps thirty entries of, so the module
 * is typed as a factory returning an index and each wrapper states, locally and precisely, the
 * bindings it is about to call. That keeps the type assertions next to the calls they describe,
 * which is where someone reading the code needs them.
 */

declare module 'opencascade.js/dist/opencascade.wasm.js' {
  const init: (options: unknown) => Promise<Record<string, unknown>>;
  export default init;
}

declare module 'opencascade.js/dist/opencascade.wasm.wasm?url' {
  const url: string;
  export default url;
}
